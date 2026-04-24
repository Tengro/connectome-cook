/**
 * Dockerfile generator — Phase 2 of BUILD-PLAN.md.
 *
 * Templates a multi-stage Dockerfile from a `GeneratorInput` so cook can
 * produce a deployable image with all of the recipe's MCP servers built in.
 *
 * Architecture
 * ------------
 *   1. One **builder stage** per `McpSource` whose install kind is
 *      `npm` / `pip-editable` / `custom`. Each stage:
 *        - apt-installs `git ca-certificates`,
 *        - sets `WORKDIR /build`, then
 *        - splices `getRuntime(source.install).installSteps(source)` —
 *          which does the `git clone` (with optional BuildKit secret mount
 *          for private repos) + the install.
 *      Sibling-copy sources do NOT get a builder stage; the runtime stage
 *      copies them straight from the build context.
 *
 *   2. A **node-stage** alias for `node:20-bookworm-slim` is FROM-aliased
 *      under the name `node-runtime` if any recipe references the literal
 *      `node` / `npm` / `npx` commands. We need to copy `/usr/local/bin/node`
 *      and the npm package out of it into the runtime stage. (See
 *      DESIGN-NOTES lesson #6: Docker COPY follows symlinks for npm/npx,
 *      so we copy the lib/node_modules tree wholesale and re-create the
 *      symlinks ourselves.)
 *
 *   3. A **`ch-deps`** stage that CLONES connectome-host (URL is a build
 *      arg `CH_REPO_URL`, default `https://github.com/anima-research/connectome-host.git`;
 *      ref via `CH_REF`, default `main`) and runs `bun install --frozen-lockfile`.
 *      Auto-clone is the cook contract — no sibling-COPY of connectome-host.
 *
 *   4. A **runtime stage** (`oven/bun:1-debian`):
 *        - apt-installs `tini ca-certificates` + `python3` (if any source's
 *          runtime is python3),
 *        - COPYs `node` + `npm`/`npx` from the node alias if needed,
 *        - COPYs each builder stage's `/build/<basename>` into its
 *          `inContainerPath`,
 *        - COPYs sibling-copy sources from the build context,
 *        - COPYs node_modules + connectome-host source from `ch-deps`,
 *        - COPYs `recipes/` from the build context (cook writes the
 *          resolved recipes to `<outDir>/recipes/`),
 *        - mkdir's every workspace mount path declared in any recipe,
 *        - chowns everything to `bun:bun`,
 *        - sets `USER bun`, `ENV DATA_DIR=/app/data`,
 *          `ENTRYPOINT ["tini", "--"]`, and
 *          `CMD ["bun", "src/index.ts", "recipes/<parent-recipe-basename>.json"]`.
 *
 * Stage naming
 * ------------
 * Each builder stage's name is sanitized from the source's URL basename
 * (or `key` for sibling sources, though those don't get a stage). The
 * sanitization pipeline: lowercase, replace runs of non-`[a-z0-9-]` with
 * a single `-`, strip leading/trailing dashes, append `-build`. Empty
 * results fall back to `mcp-source-<index>`. Result is a Docker-valid
 * stage identifier (Docker wants `[a-zA-Z0-9_][a-zA-Z0-9_.-]*` — our
 * lowercase-alphanum-dash subset is a safe overlap with that).
 */

import { basename } from 'node:path';
import type {
  GeneratorInput,
  McpSource,
  WalkResult,
} from '../types.js';
import type { Recipe, RecipeMcpServer, RecipeWorkspaceMount } from '../vendor/recipe.js';
import { getRuntime, repoBasename } from '../runtimes/index.js';
import * as customRuntime from '../runtimes/custom.js';

/** Default URL of the connectome-host repo to clone into the `ch-deps` stage. */
const DEFAULT_CH_REPO_URL = 'https://github.com/anima-research/connectome-host.git';
const DEFAULT_CH_REF = 'main';

/** Base image for the connectome-host bun-deps + runtime stages. */
const BUN_BASE_IMAGE = 'oven/bun:1-debian';

/** Base image used for the optional node-binary-source alias. */
const NODE_BASE_IMAGE = 'node:20-bookworm-slim';
const NODE_STAGE_ALIAS = 'node-runtime';

/** Generate a complete multi-stage Dockerfile string for `input`. */
export function generateDockerfile(input: GeneratorInput): string {
  const { walks, sources, options } = input;
  if (walks.length === 0) {
    throw new Error('generateDockerfile: walks is empty — need at least the parent recipe.');
  }

  const parent = walks[0]!;
  const parentRecipeBasename = basename(parent.path);
  const builderSources = sources.filter((s) => s.install.kind !== 'sibling-copy');
  const siblingSources = sources.filter((s) => s.install.kind === 'sibling-copy');
  const stageNames = assignStageNames(builderSources);

  const needsNode = anyRecipeUsesNodeCommand(walks);
  const needsPython = builderSources.some(
    (s) => runtimeForSource(s) === 'python3',
  );
  const persistentDirs = collectWorkspaceMountPaths(walks);
  const hasAnySecret = sources.some((s) => s.authSecret);
  const imageName = options.imageName ?? deriveImageName(parent.recipe);

  const sections: string[] = [];

  sections.push(renderHeader({
    imageName,
    parentRecipeBasename,
    builderSources,
    siblingSources,
    hasAnySecret,
  }));

  if (needsNode) {
    sections.push(renderNodeAliasStage());
  }

  for (const source of builderSources) {
    const stage = stageNames.get(source.key)!;
    sections.push(renderBuilderStage(source, stage));
  }

  sections.push(renderChDepsStage());

  sections.push(renderRuntimeStage({
    builderSources,
    siblingSources,
    stageNames,
    persistentDirs,
    needsNode,
    needsPython,
    parentRecipeBasename,
  }));

  // Trailing newline keeps editors / `cat | head` happy.
  return sections.join('\n\n') + '\n';
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

interface HeaderArgs {
  imageName: string;
  parentRecipeBasename: string;
  builderSources: McpSource[];
  siblingSources: McpSource[];
  hasAnySecret: boolean;
}

function renderHeader(args: HeaderArgs): string {
  const { imageName, parentRecipeBasename, builderSources, siblingSources, hasAnySecret } = args;
  const lines: string[] = [];
  lines.push('# syntax=docker/dockerfile:1.7');
  lines.push('');
  lines.push('# ---------------------------------------------------------------------------');
  lines.push(`# ${imageName} — generated by connectome-cook.`);
  lines.push('# ---------------------------------------------------------------------------');
  lines.push(`# Parent recipe: ${parentRecipeBasename}`);
  lines.push('# Build context: this Dockerfile\'s directory (cook output dir).');
  lines.push('#');
  lines.push('# Stages:');
  for (const source of builderSources) {
    lines.push(`#   - ${source.url}${source.ref && source.ref !== 'main' ? `@${source.ref}` : ''} (${describeInstall(source)})`);
  }
  for (const source of siblingSources) {
    if (source.install.kind === 'sibling-copy') {
      lines.push(`#   - sibling-copy: ${source.install.siblingDir} -> ${source.inContainerPath}`);
    }
  }
  lines.push('#   - ch-deps: clones connectome-host (override URL/ref via CH_REPO_URL / CH_REF build args)');
  lines.push('#   - runtime: assembles the final image (oven/bun:1-debian)');
  if (hasAnySecret) {
    lines.push('#');
    lines.push('# This image consumes BuildKit secrets. Pass them at build time:');
    lines.push('#   docker build --secret id=<NAME>,env=<NAME> ...');
    lines.push('# (one --secret flag per source.authSecret in the recipe).');
  }
  lines.push('# ---------------------------------------------------------------------------');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Optional node-binary alias stage
// ---------------------------------------------------------------------------

function renderNodeAliasStage(): string {
  // Aliases the node:20-bookworm-slim image so the runtime stage can COPY
  // /usr/local/bin/node and /usr/local/lib/node_modules out of it without
  // pulling NodeSource APT packages into the bun-debian runtime.
  return [
    '# ---- node binary source --------------------------------------------------',
    `FROM ${NODE_BASE_IMAGE} AS ${NODE_STAGE_ALIAS}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Builder stage (one per source)
// ---------------------------------------------------------------------------

function renderBuilderStage(source: McpSource, stageName: string): string {
  const runtime = getRuntime(source.install);
  const baseImage =
    source.install.kind === 'custom'
      ? customRuntime.baseImageFor(source)
      : runtime.baseImage;

  const lines: string[] = [];
  lines.push(`# ---- builder: ${source.url}${source.ref && source.ref !== 'main' ? `@${source.ref}` : ''} `.padEnd(75, '-'));
  lines.push(`FROM ${baseImage} AS ${stageName}`);
  lines.push('RUN apt-get update \\');
  lines.push(' && apt-get install -y --no-install-recommends git ca-certificates \\');
  lines.push(' && rm -rf /var/lib/apt/lists/*');
  lines.push('WORKDIR /build');
  lines.push(runtime.installSteps(source));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// connectome-host bun-deps stage (auto-clone)
// ---------------------------------------------------------------------------

function renderChDepsStage(): string {
  // We clone, then move the working tree to /app so the runtime stage can
  // COPY both `node_modules` and the source files out of /app.
  return [
    '# ---- ch-deps: clone connectome-host + install bun deps --------------------',
    `FROM ${BUN_BASE_IMAGE} AS ch-deps`,
    `ARG CH_REPO_URL=${DEFAULT_CH_REPO_URL}`,
    `ARG CH_REF=${DEFAULT_CH_REF}`,
    'RUN apt-get update \\',
    ' && apt-get install -y --no-install-recommends git ca-certificates \\',
    ' && rm -rf /var/lib/apt/lists/*',
    'WORKDIR /app',
    'RUN git clone "${CH_REPO_URL}" /tmp/ch \\',
    ' && cd /tmp/ch \\',
    ' && git checkout "${CH_REF}" \\',
    ' && cp -a /tmp/ch/. /app/ \\',
    ' && rm -rf /tmp/ch /app/.git',
    'RUN bun install --frozen-lockfile',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Runtime stage
// ---------------------------------------------------------------------------

interface RuntimeStageArgs {
  builderSources: McpSource[];
  siblingSources: McpSource[];
  stageNames: Map<string, string>;
  persistentDirs: string[];
  needsNode: boolean;
  needsPython: boolean;
  parentRecipeBasename: string;
}

function renderRuntimeStage(args: RuntimeStageArgs): string {
  const {
    builderSources,
    siblingSources,
    stageNames,
    persistentDirs,
    needsNode,
    needsPython,
    parentRecipeBasename,
  } = args;

  const lines: string[] = [];
  lines.push('# ---- runtime: assembled image --------------------------------------------');
  lines.push(`FROM ${BUN_BASE_IMAGE} AS runtime`);
  lines.push('');

  // apt step — tini, ca-certificates, gosu (for entrypoint user-drop),
  // optional python3.
  const aptPackages = ['tini', 'ca-certificates', 'gosu'];
  if (needsPython) aptPackages.push('python3', 'python3-venv');
  lines.push('RUN apt-get update \\');
  lines.push(` && apt-get install -y --no-install-recommends ${aptPackages.join(' ')} \\`);
  lines.push(' && rm -rf /var/lib/apt/lists/*');
  lines.push('');

  if (needsNode) {
    lines.push('# Bring in Node.js for recipes that spawn `node`, `npm`, or `npx`.');
    lines.push('# Docker COPY follows symlinks; npm and npx in node:20 are symlinks');
    lines.push('# into the npm package.  Copy the binary + the npm package wholesale,');
    lines.push('# then recreate the symlinks ourselves so npm-cli.js can resolve its');
    lines.push('# sibling lib/cli.js correctly.');
    lines.push(`COPY --from=${NODE_STAGE_ALIAS} /usr/local/bin/node          /usr/local/bin/node`);
    lines.push(`COPY --from=${NODE_STAGE_ALIAS} /usr/local/lib/node_modules  /usr/local/lib/node_modules`);
    lines.push('RUN ln -sf ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \\');
    lines.push(' && ln -sf ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx');
    lines.push('');
  }

  // COPY each builder stage's /build/<basename> into its inContainerPath.
  for (const source of builderSources) {
    const stage = stageNames.get(source.key)!;
    const dir = repoBasename(source.url);
    lines.push(`COPY --from=${stage} /build/${dir} ${source.inContainerPath}`);
  }
  if (builderSources.length > 0) lines.push('');

  // sibling-copy sources: COPY <siblingDir> <inContainerPath> from the
  // build context (operator must place the checkout next to the cook output dir).
  for (const source of siblingSources) {
    if (source.install.kind === 'sibling-copy') {
      lines.push(`COPY ${source.install.siblingDir} ${source.inContainerPath}`);
    }
  }
  if (siblingSources.length > 0) lines.push('');

  // connectome-host: copy node_modules + source from ch-deps.
  lines.push('# connectome-host source + bun deps');
  lines.push('WORKDIR /app');
  lines.push('COPY --from=ch-deps /app/node_modules ./node_modules');
  lines.push('COPY --from=ch-deps /app/package.json /app/bun.lock /app/tsconfig.json ./');
  lines.push('COPY --from=ch-deps /app/src ./src');
  lines.push('');

  // recipes/ — cook writes the resolved tree to <outDir>/recipes/.
  lines.push('# Recipes — cook emitted these into <outDir>/recipes/.');
  lines.push('COPY recipes /app/recipes');
  lines.push('');

  // mkdir -p for every persistent dir; chown -R bun:bun on /app + every
  // in-container source path.
  const chownTargets = ['/app'];
  for (const source of [...builderSources, ...siblingSources]) {
    if (!chownTargets.includes(source.inContainerPath)) {
      chownTargets.push(source.inContainerPath);
    }
  }

  if (persistentDirs.length > 0) {
    lines.push('# Pre-create persistent dirs with bun-user ownership so bind mounts');
    lines.push('# from a UID-1000 host (default Linux/WSL2 user) work without manual chown.');
    lines.push(`RUN mkdir -p ${persistentDirs.join(' ')} \\`);
    lines.push(` && chown -R bun:bun ${chownTargets.join(' ')}`);
  } else {
    lines.push(`RUN chown -R bun:bun ${chownTargets.join(' ')}`);
  }
  lines.push('');

  // Cook entrypoint: runs as root, chowns RW bind-mount targets
  // (docker-compose creates missing host paths as root if absent), then
  // exec-drops to the bun user via gosu.  This is the standard Postgres-
  // style "init as root, work as service user" pattern.  We deliberately
  // do NOT set USER bun here — gosu handles the drop at runtime.
  lines.push('# Entrypoint script — runs as root, chowns bind targets, drops to bun.');
  lines.push('COPY entrypoint.sh /usr/local/bin/cook-entrypoint');
  lines.push('RUN chmod +x /usr/local/bin/cook-entrypoint');
  lines.push('');

  lines.push('ENV DATA_DIR=/app/data');
  lines.push('');
  lines.push('ENTRYPOINT ["tini", "--", "/usr/local/bin/cook-entrypoint"]');
  lines.push(`CMD ["bun", "src/index.ts", "recipes/${parentRecipeBasename}"]`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Stage-name assignment
// ---------------------------------------------------------------------------

/** Map each source's `key` to a unique sanitized Docker stage name.  Builder
 *  sources only — sibling-copy sources don't get a stage. */
function assignStageNames(builderSources: McpSource[]): Map<string, string> {
  const result = new Map<string, string>();
  const usedNames = new Set<string>();
  for (let i = 0; i < builderSources.length; i++) {
    const source = builderSources[i]!;
    const sanitized = sanitizeStageName(source);
    let candidate = sanitized || `mcp-source-${i + 1}`;
    let suffix = 2;
    while (usedNames.has(candidate)) {
      candidate = `${sanitized || `mcp-source-${i + 1}`}-${suffix}`;
      suffix += 1;
    }
    usedNames.add(candidate);
    result.set(source.key, candidate);
  }
  return result;
}

/** Sanitize a source's url-basename into a valid lowercase Docker stage id,
 *  appending `-build`. Returns empty string when nothing usable remains. */
function sanitizeStageName(source: McpSource): string {
  const seed = source.url ? repoBasename(source.url) : source.key;
  const cleaned = seed
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!cleaned) return '';
  return `${cleaned}-build`;
}

// ---------------------------------------------------------------------------
// Recipe introspection
// ---------------------------------------------------------------------------

/** Determine the build runtime (node / python3 / custom) for a builder source.
 *  Used to pick which apt packages need installing in the runtime stage. */
function runtimeForSource(source: McpSource): 'node' | 'python3' | 'custom' {
  switch (source.install.kind) {
    case 'npm':
      return 'node';
    case 'pip-editable':
      return 'python3';
    case 'custom':
      return source.install.runtime;
    case 'sibling-copy':
      return 'custom';
  }
}

/** True if any walked recipe has an mcpServer that spawns the literal
 *  `node`, `npm`, or `npx` command. Drives whether we copy node + npm into
 *  the runtime stage. */
function anyRecipeUsesNodeCommand(walks: WalkResult[]): boolean {
  const NODE_COMMANDS = new Set(['node', 'npm', 'npx']);
  for (const walk of walks) {
    const servers = walk.recipe.mcpServers;
    if (!servers) continue;
    for (const server of Object.values(servers) as RecipeMcpServer[]) {
      if (server.command && NODE_COMMANDS.has(server.command)) return true;
    }
  }
  return false;
}

/** Collect every workspace-mount path declared in any recipe, deduplicated
 *  and stripped of `./` prefixes. Mounts that look like absolute container
 *  paths (`/foo`) are passed through; the runtime `mkdir -p` is run from
 *  /app, so relative paths resolve under /app. Always includes `data` since
 *  it's the target of `ENV DATA_DIR=/app/data` and conductor child dataDirs. */
function collectWorkspaceMountPaths(walks: WalkResult[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  // `data/` is the durable home for Chronicle stores, fleet child dataDirs,
  // and `DATA_DIR`; always create it whether or not a recipe mounts it
  // explicitly via the workspace module.
  seen.add('data');
  ordered.push('data');
  for (const walk of walks) {
    const ws = walk.recipe.modules?.workspace;
    if (!ws || typeof ws !== 'object') continue;
    const mounts = ws.mounts as RecipeWorkspaceMount[] | undefined;
    if (!mounts) continue;
    for (const mount of mounts) {
      const normalized = normalizeMountPath(mount.path);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      ordered.push(normalized);
    }
  }
  return ordered;
}

/** `./output` → `output`; `/app/data` → `/app/data`; trailing slashes stripped. */
function normalizeMountPath(path: string): string {
  let p = path.trim();
  if (p.startsWith('./')) p = p.slice(2);
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

/** Brief human-readable label for a source's install pattern. */
function describeInstall(source: McpSource): string {
  switch (source.install.kind) {
    case 'npm': return 'npm';
    case 'pip-editable': return 'pip-editable';
    case 'custom': return `custom (${source.install.runtime})`;
    case 'sibling-copy': return `sibling-copy (${source.install.siblingDir})`;
  }
}

/** Default image name from the recipe.  Lowercase, alphanum/dash only.
 *  e.g. "Knowledge Mining Triumvirate" → "knowledge-mining-triumvirate". */
function deriveImageName(recipe: Recipe): string {
  const cleaned = recipe.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'cook-image';
}
