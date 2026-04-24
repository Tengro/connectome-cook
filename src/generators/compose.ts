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
import type { RecipeWorkspaceMount, RecipeMcpServer } from '../vendor/recipe.js';
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
  const secrets = input.sources.filter((s) => s.authSecret);

  return renderCompose({
    serviceName,
    imageName,
    volumes,
    secrets,
  });
}

// ---------------------------------------------------------------------------
// Slug derivation
// ---------------------------------------------------------------------------

function deriveServiceName(recipeName: string): string {
  return slugify(recipeName);
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
  secrets: McpSource[];
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
  const { serviceName, imageName, volumes, secrets } = input;

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

  if (secrets.length > 0) {
    lines.push('');
    lines.push('    secrets:');
    for (const s of secrets) {
      lines.push(`      - ${s.authSecret}`);
    }
  }

  lines.push('');
  lines.push('    # docker stop sends SIGTERM; tini forwards it to the parent process,');
  lines.push('    # which has its own graceful-shutdown logic for any fleet children.');
  lines.push('    # 30s gives the slowest child time to flush state.');
  lines.push('    stop_grace_period: 30s');

  if (secrets.length > 0) {
    lines.push('');
    lines.push('# Secrets are populated from files of the same name in the cook output');
    lines.push('# directory. Put each token in a file (chmod 600) before `docker compose');
    lines.push('# up`. See .env.example / README.md for the list and how to source them.');
    lines.push('secrets:');
    for (const s of secrets) {
      lines.push(`  ${s.authSecret}:`);
      lines.push(`    file: ./${s.authSecret}`);
    }
  }

  // Trailing newline so editors don't complain.
  lines.push('');
  return lines.join('\n');
}
