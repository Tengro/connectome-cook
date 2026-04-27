/**
 * Compose generator — Phase 2 of BUILD-PLAN.md.
 *
 * Templates a `docker-compose.yml` (Compose v2 format) for a single service
 * that runs the parent recipe.  The recipe-host process spawned inside the
 * container is responsible for starting fleet children — one Compose service
 * is enough no matter how many child agents the recipe orchestrates.
 *
 * Why hand-rolled YAML (not js-yaml)? Compose YAML is a small, well-defined
 * shape; pulling a YAML library for one generator is not worth the install
 * cost.  We carefully indent + quote where the spec demands it and produce
 * output that round-trips through `js-yaml`/`yaml`/`Bun.YAML.parse`.
 *
 * Reference output: examples/triumvirate/docker-compose.yml.  Functional
 * equivalence is the goal (header comments + bind-mount commentary may
 * differ; the structural shape — services map, build context, volumes,
 * env_file, stdin_open + tty, stop_grace_period — must match).
 */

import type { GeneratorInput, McpSource, WalkResult } from '../types.js';
import type { RecipeWorkspaceMount } from '../vendor/recipe.js';
import { slugify } from '../slug.js';
export { slugify };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a `docker-compose.yml` string for the given recipe tree.
 *
 * Throws if `input.walks` is empty (caller error — there must be at least a
 * parent recipe).
 */
export function generateCompose(input: GeneratorInput): string {
  if (input.walks.length === 0) {
    throw new Error('generateCompose: walks must contain at least the parent recipe');
  }

  const parent = input.walks[0]!;
  const serviceName = deriveServiceName(parent.recipe.name);
  const imageName = input.options.imageName ?? `${serviceName}:latest`;

  const volumes = collectVolumes(input.walks);
  // Build-time secrets from mcpServers[].source.authSecret — deduped by name.
  const buildSecrets: McpSource[] = [];
  const seenAuthSecrets = new Set<string>();
  for (const s of input.sources) {
    if (!s.authSecret || seenAuthSecrets.has(s.authSecret)) continue;
    seenAuthSecrets.add(s.authSecret);
    buildSecrets.push(s);
  }

  // Sidecar services from the parent recipe's `services` field.  Sidecars
  // can reference their own runtime secrets (e.g. WIKI_DB_PASSWORD); cook
  // writes those as 0600 files just like authSecrets.
  const sidecars = parent.recipe.services ?? [];

  // Top-level secrets block is the union of build-time auth secrets +
  // sidecar runtime secrets.  Deduped by name.
  const allSecretNames = new Set<string>();
  for (const s of buildSecrets) allSecretNames.add(s.authSecret!);
  for (const svc of sidecars) {
    for (const sec of svc.secrets ?? []) allSecretNames.add(sec);
  }

  return renderCompose({
    serviceName,
    imageName,
    volumes,
    buildSecrets,
    sidecars,
    allSecretNames: Array.from(allSecretNames).sort(),
  });
}

// ---------------------------------------------------------------------------
// Slug derivation
// ---------------------------------------------------------------------------

function deriveServiceName(recipeName: string): string {
  return slugify(recipeName);
}

/** Quote a value for safe inclusion in a docker-compose YAML environment
 *  block.  YAML interprets bareword values like `yes`/`no`/`null`/`on` as
 *  booleans; numbers as numbers; values with `:` as keys.  Quoting with
 *  double quotes (and escaping `"` and `\\`) is the universally safe form.
 *  We don't escape `$` because compose still wants to interpolate `${VAR}`
 *  references inside the value (that's part of compose's contract).
 *
 *  NB: distinct from `escapeForEnvFile` (cli.ts) — that one formats
 *  values for `.env` files, where `$` MUST be escaped to prevent compose
 *  from interpolating substrings like `${M5qt58t}` out of secret values.
 *  Different file format, different rules; they do NOT share a core. */
function quoteForComposeEnvBlock(value: string): string {
  if (value === '') return '""';
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

// ---------------------------------------------------------------------------
// Volume derivation
// ---------------------------------------------------------------------------

/** Internal compose volume entry. Rendered as `./<host>:<container>[:ro]`. */
interface ComposeVolume {
  host: string;
  container: string;
  readOnly: boolean;
}

/**
 * Aggregate workspace mounts across every walked recipe.  Dedup key is the
 * normalized container path so two recipes mounting different host names at
 * `./output` collapse to a single entry (first-write-wins on host name +
 * mode — mirrors source-detector's first-wins policy).
 *
 * Credential files (declared via `mcpServers[*].credentialFiles`) get a
 * read-only file-bind mount each: `./<basename>:<container-path>:ro`.
 * Replaces the older Zulip-specific heuristic — any MCP that declares a
 * credential file gets the same treatment.
 */
function collectVolumes(walks: WalkResult[]): ComposeVolume[] {
  const byContainer = new Map<string, ComposeVolume>();

  // Workspace mounts → bind volumes.
  for (const walk of walks) {
    const workspace = walk.recipe.modules?.workspace;
    if (!workspace || typeof workspace !== 'object' || !workspace.mounts) continue;
    for (const mount of workspace.mounts) {
      const v = mountToVolume(mount);
      // First-write-wins on container path.
      if (!byContainer.has(v.container)) {
        byContainer.set(v.container, v);
      }
    }
  }

  // Fleet child data dirs → bind volumes so children survive container
  // restarts.  Mount the longest common prefix of all dataDirs (the example
  // shape: `./data:/app/data` rather than 3× `./data/<child>:/app/data/<child>`).
  // When there's no common ancestor, fall back to per-child mounts.
  for (const path of fleetDataDirParents(walks)) {
    const v: ComposeVolume = {
      host: `./${path}`,
      container: `/app/${path}`,
      readOnly: false,
    };
    if (!byContainer.has(v.container)) {
      byContainer.set(v.container, v);
    }
  }

  const volumes = Array.from(byContainer.values());

  // Declarative credential-file volumes.  One file-bind per unique
  // credentialFiles[].path across the walked recipes.
  for (const cf of declaredCredentialFiles(walks)) {
    volumes.push({
      host: `./${cf.hostFilename}`,
      container: cf.containerPath,
      readOnly: true,
    });
  }

  // Top-level containerTemplateFiles on the parent recipe — agent-side
  // generated config files (e.g. mediawiki-mcp-server's config.json) that
  // need a bind mount at the declared in-container path.
  const parent = walks[0];
  if (parent) {
    for (const tf of parent.recipe.containerTemplateFiles ?? []) {
      volumes.push({
        host: `./${tf.hostPath.replace(/^\.\//, '').replace(/^\/+/, '')}`,
        container: tf.inContainer,
        readOnly: true,
      });
    }
  }

  return volumes;
}

/** Collect (host filename, container path) for every distinct credential
 *  file declared across the recipe tree.  Dedup by container path. */
function declaredCredentialFiles(
  walks: WalkResult[],
): Array<{ hostFilename: string; containerPath: string }> {
  const seen = new Map<string, { hostFilename: string; containerPath: string }>();
  for (const walk of walks) {
    for (const server of Object.values(walk.recipe.mcpServers ?? {})) {
      for (const cf of server.credentialFiles ?? []) {
        const containerPath = cf.path.startsWith('/')
          ? cf.path
          : '/app/' + cf.path.replace(/^\.\//, '').replace(/^\/+/, '');
        if (seen.has(containerPath)) continue;
        const hostFilename = cf.path
          .replace(/^\.\//, '')
          .replace(/^\/+/, '')
          .split('/').pop() ?? 'credential';
        seen.set(containerPath, { hostFilename, containerPath });
      }
    }
  }
  return Array.from(seen.values());
}

/** Container-side paths the runtime entrypoint needs to chown before
 *  dropping to bun.  RW workspace mounts + fleet dataDir parents only —
 *  RO mounts and credential file binds stay as the operator owns them. */
export function chownTargets(walks: WalkResult[]): string[] {
  const out = new Set<string>();
  for (const v of collectVolumes(walks)) {
    if (v.readOnly) continue;
    out.add(v.container);
  }
  return Array.from(out).sort();
}

/** Collect every fleet child's dataDir (explicit or `./data/<child-name>`
 *  default) across all walks, then return the minimal set of host paths
 *  to bind-mount so all of them are persistent.  When all dataDirs share
 *  a common prefix, returns just the prefix (cleaner YAML, matches the
 *  hand-curated example).  Otherwise returns each unique entry. */
function fleetDataDirParents(walks: WalkResult[]): string[] {
  const dataDirs = new Set<string>();
  for (const walk of walks) {
    const fleet = walk.recipe.modules?.fleet;
    if (!fleet || typeof fleet !== 'object' || !fleet.children) continue;
    for (const child of fleet.children) {
      const dir = child.dataDir ?? `./data/${child.name}`;
      const cleaned = stripLeadingDotSlash(dir);
      if (cleaned) dataDirs.add(cleaned);
    }
  }
  if (dataDirs.size === 0) return [];

  const segs = Array.from(dataDirs).map((p) => p.split('/').filter(Boolean));
  // Longest common prefix across all segment lists.
  const prefix: string[] = [];
  const minLen = Math.min(...segs.map((s) => s.length));
  outer: for (let i = 0; i < minLen; i++) {
    const head = segs[0]?.[i];
    if (head === undefined) break;
    for (const s of segs) {
      if (s[i] !== head) break outer;
    }
    prefix.push(head);
  }

  if (prefix.length > 0) {
    // Don't collapse to the full path of a single entry — the parent dir
    // is what we want to bind so siblings can be added without recompose.
    // If prefix === full path of every entry (all identical), use it as-is.
    return [prefix.join('/')];
  }
  // No common prefix — emit per-dir mounts (caller's Map will dedup).
  return Array.from(dataDirs);
}

/**
 * Convert a recipe workspace mount to a compose bind volume.
 *
 * Host side: take `mount.path`, strip leading `./`, leave the rest intact —
 * the example uses `./data`, `./output`, etc. directly so we mirror that
 * shape (avoids a slug round-trip that would lose information).
 * Container side: `/app/<lastSegment>` of the host path.
 */
function mountToVolume(mount: RecipeWorkspaceMount): ComposeVolume {
  const stripped = stripLeadingDotSlash(mount.path);
  const lastSegment = stripped.split('/').filter(Boolean).pop() ?? slugify(mount.name);
  return {
    host: `./${stripped}`,
    container: `/app/${lastSegment}`,
    readOnly: mount.mode === 'read-only',
  };
}

function stripLeadingDotSlash(p: string): string {
  return p.replace(/^\.\//, '').replace(/^\/+/, '');
}

// (Old anyRecipeUsesZulip heuristic removed — credentialFiles makes the
//  Zulip-specific shape declarative.  Any future MCP that needs a side
//  file uses the same path: declare credentialFiles in the recipe.)

// ---------------------------------------------------------------------------
// YAML rendering
// ---------------------------------------------------------------------------

interface RenderInput {
  serviceName: string;
  imageName: string;
  volumes: ComposeVolume[];
  /** Build-time auth secrets from mcpServers[].source.authSecret. */
  buildSecrets: McpSource[];
  /** Sidecar service entries from the parent recipe's `services` field. */
  sidecars: import('../vendor/recipe.js').RecipeSidecarService[];
  /** Union of every secret name (build + sidecar) that needs a top-level
   *  secrets entry.  Sorted for deterministic output. */
  allSecretNames: string[];
}

const HEADER = [
  '# Generated by connectome-cook.',
  '#',
  '# Quick start:',
  '#   1. cp .env.example .env  &&  edit it (set required keys at minimum)',
  '#   2. docker compose up -d --build',
  '#   3. docker attach <service>            # join the TUI',
  '#',
  '# Detach the TUI without stopping anything: press Ctrl+P then Ctrl+Q.',
  '# Do NOT use /quit + d inside the TUI — when the parent agent exits,',
  '# PID 1 dies and the container shuts down (taking all children with it).',
  '# Use Docker\'s detach sequence instead.',
  '#',
  '# Stop everything: docker compose down',
  '',
].join('\n');

function renderCompose(input: RenderInput): string {
  const { serviceName, imageName, volumes, buildSecrets, sidecars, allSecretNames } = input;

  const lines: string[] = [];
  lines.push(HEADER);
  lines.push('services:');
  lines.push(`  ${serviceName}:`);
  lines.push(`    image: ${imageName}`);
  lines.push(`    container_name: ${serviceName}`);
  lines.push('');
  lines.push('    build:');
  lines.push('      context: .');
  lines.push('      dockerfile: Dockerfile');
  if (buildSecrets.length > 0) {
    // Build-time secrets: `docker compose build` only passes secrets to
    // the build when they're declared under `build.secrets`.  The
    // service-level `secrets:` further down handles runtime; build-time
    // is a separate plumbing.  Both reference the same top-level
    // `secrets:` block at the bottom of the file.
    lines.push('      secrets:');
    for (const s of buildSecrets) {
      lines.push(`        - ${s.authSecret}`);
    }
  }
  lines.push('');
  lines.push('    # TUI needs a real TTY for rendering and keypress capture; without');
  lines.push('    # these two flags `docker attach` shows nothing useful.');
  lines.push('    stdin_open: true');
  lines.push('    tty: true');
  lines.push('');
  lines.push('    # Recipe ${VAR} substitution reads from the child process\'s env at');
  lines.push('    # startup. See .env.example for the full list of supported keys.');
  lines.push('    env_file:');
  lines.push('      - .env');

  if (volumes.length > 0) {
    lines.push('');
    lines.push('    volumes:');
    for (const v of volumes) {
      const suffix = v.readOnly ? ':ro' : '';
      lines.push(`      - ${v.host}:${v.container}${suffix}`);
    }
  }

  lines.push('');
  lines.push('    # docker stop sends SIGTERM; tini forwards it to the parent process,');
  lines.push('    # which has its own graceful-shutdown logic for any fleet children.');
  lines.push('    # 30s gives the slowest child time to flush state.');
  lines.push('    stop_grace_period: 30s');

  // Sidecar services — each as its own service entry under the same `services:`
  // top-level block.  Cook emits in declaration order from the recipe.
  for (const svc of sidecars) {
    lines.push('');
    lines.push(`  ${svc.name}:`);
    lines.push(`    image: ${svc.image}`);
    lines.push(`    container_name: ${svc.name}`);
    if (svc.restart) {
      lines.push(`    restart: ${svc.restart}`);
    } else {
      // Sensible default — operator probably wants sidecars to come back
      // after a host reboot or transient crash.
      lines.push('    restart: unless-stopped');
    }
    if (svc.dependsOn && svc.dependsOn.length > 0) {
      lines.push('    depends_on:');
      for (const dep of svc.dependsOn) {
        lines.push(`      - ${dep}`);
      }
    }
    if (svc.ports && svc.ports.length > 0) {
      lines.push('    ports:');
      for (const p of svc.ports) {
        lines.push(`      - "${p}"`);
      }
    }
    if (svc.environment && Object.keys(svc.environment).length > 0) {
      lines.push('    environment:');
      for (const [k, v] of Object.entries(svc.environment)) {
        // Quote values defensively — docker-compose's env interpretation
        // is happy with quoted strings, and this avoids surprises with
        // values that look like YAML special tokens (yes/no/null/...).
        lines.push(`      ${k}: ${quoteForComposeEnvBlock(v)}`);
      }
    }
    if (svc.volumes && svc.volumes.length > 0) {
      lines.push('    volumes:');
      for (const v of svc.volumes) {
        const suffix = v.readOnly ? ':ro' : '';
        lines.push(`      - ${v.source}:${v.target}${suffix}`);
      }
    }
    if (svc.secrets && svc.secrets.length > 0) {
      lines.push('    secrets:');
      for (const sec of svc.secrets) {
        lines.push(`      - ${sec}`);
      }
    }
    if (svc.healthcheck) {
      const hc = svc.healthcheck;
      lines.push('    healthcheck:');
      const testStr = JSON.stringify(hc.test);
      lines.push(`      test: ${testStr}`);
      if (hc.interval) lines.push(`      interval: ${hc.interval}`);
      if (hc.timeout) lines.push(`      timeout: ${hc.timeout}`);
      if (hc.retries !== undefined) lines.push(`      retries: ${hc.retries}`);
      if (hc.startPeriod) lines.push(`      start_period: ${hc.startPeriod}`);
    }
  }

  if (allSecretNames.length > 0) {
    lines.push('');
    lines.push('# Secrets are populated from files of the same name in the cook output');
    lines.push('# directory. Cook auto-writes each file (mode 0600) from collected env');
    lines.push('# values; operator can override by editing/replacing the file before');
    lines.push('# `docker compose build` (build-time secrets) or `up` (runtime secrets).');
    lines.push('secrets:');
    for (const name of allSecretNames) {
      lines.push(`  ${name}:`);
      lines.push(`    file: ./${name}`);
    }
  }

  // Trailing newline so editors don't complain.
  lines.push('');
  return lines.join('\n');
}
