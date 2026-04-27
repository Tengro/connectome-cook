/**
 * Vendored from connectome-host: forking-knowledge-miner/src/recipe.ts
 * Sync source: github.com/anima-research/connectome-host
 * Last synced: feat/sidecar-services branch (sidecar `services` + `templateFiles`).
 *              Earlier: commit f4b6588 (feat(recipe): \${VAR:-default} substitution
 *              syntax — adds optional-with-fallback form to substituteEnvVars).
 *              Earlier syncs: bb40b64 (credentialFiles), a111e79 (parent-dir
 *              resolution + enabledTools/disabledTools + activity), 6273370
 *              (source metadata).
 *
 * Note: cook does NOT vendor `substituteEnvVars` itself — `loadRecipeRaw`
 * deliberately skips substitution so the env-collector can scan placeholders
 * BEFORE substitution.  But cook's env-collector regex MUST match upstream's
 * substituteEnvVars regex byte-for-byte; see src/env-collector.ts.
 *
 * Why vendored: connectome-host isn't published to npm, so cook can't depend
 * on it directly. The recipe schema is small and stable enough that
 * duplicating ~300 LoC is cheaper than wrangling a git/file dep. Re-sync this
 * file when the upstream schema evolves; the surface that matters for cook is:
 *
 *   - Type exports (Recipe + nested types)
 *   - validateRecipe() — structural validation
 *   - loadRecipeRaw() — read+parse+validate WITHOUT env-substitution
 *   - resolveRecipeRelative() — parent-dir-relative path resolution helper,
 *     used by walker.ts to traverse fleet children
 *
 * Two deliberate divergences from upstream:
 *
 *   1. We expose loadRecipeRaw() instead of loadRecipe(). Cook needs to scan
 *      raw recipe JSON for ${VAR} patterns BEFORE substitution (so we can
 *      prompt the operator for missing values), and never wants to fetch
 *      remote system-prompt URLs at build time. loadRecipeRaw also skips
 *      the resolveChildRecipePaths side-effect — walker.ts wants raw paths
 *      so it can drive its own traversal/dedup.
 *
 *   2. RecipeModules.wake is loosened from `GateConfig` (which lives in
 *      @animalabs/agent-framework, a runtime-only dep) to `Record<string,
 *      unknown>`. Cook only cares whether wake is enabled, not its config
 *      shape.
 */

import { readFileSync, existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RecipeStrategy {
  type: 'autobiographical' | 'passthrough' | 'frontdesk';
  headWindowTokens?: number;
  recentWindowTokens?: number;
  compressionModel?: string;
  maxMessageTokens?: number;
}

export interface RecipeAgent {
  name?: string;
  model?: string;
  systemPrompt: string;
  maxTokens?: number;
  strategy?: RecipeStrategy;
}

export interface RecipeMcpServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  transport?: 'stdio' | 'websocket';
  token?: string;
  toolPrefix?: string;
  enabledFeatureSets?: string[];
  disabledFeatureSets?: string[];
  /** Tool allow-list; `*` is a substring wildcard. */
  enabledTools?: string[];
  /** Tool deny-list; wins over enabledTools on overlap. */
  disabledTools?: string[];
  reconnect?: boolean;
  reconnectIntervalMs?: number;
  channelSubscription?: 'auto' | 'manual' | string[];
  source?: RecipeMcpServerSource;
  /** Auxiliary credential / config files this MCP needs at runtime
   *  (e.g. `.zuliprc`).  Build tooling collects values, writes the file,
   *  bind-mounts it.  Ignored at runtime by connectome-host's loader. */
  credentialFiles?: RecipeCredentialFile[];
}

export interface RecipeMcpServerSource {
  url: string;
  ref?: string;
  install?:
    | 'npm'
    | 'pip-editable'
    | { run: string; runtime: 'node' | 'python3' | 'custom' };
  authSecret?: string;
  sslBypass?: boolean;
  inContainer?: { path: string };
}

/** Auxiliary credential / config file an MCP server reads at runtime.
 *  Build tooling prompts the operator for field values, serializes them
 *  in the declared format, writes the file at `path`, bind-mounts it. */
export interface RecipeCredentialFile {
  path: string;
  format: 'ini' | 'json' | 'env';
  section?: string;
  mode?: string;
  fields: RecipeCredentialFileField[];
}

export interface RecipeCredentialFileField {
  name: string;
  envOverride?: string;
  description?: string;
  placeholder?: string;
  secret?: boolean;
}

export interface RecipeWorkspaceMount {
  name: string;
  path: string;
  mode?: 'read-write' | 'read-only';
  watch?: 'always' | 'on-agent-action' | 'never';
  ignore?: string[];
  wakeOnChange?: boolean | Array<'created' | 'modified' | 'deleted'>;
  autoMaterialize?: boolean;
}

export interface RecipeModules {
  subagents?: boolean | { defaultModel?: string; defaultMaxTokens?: number };
  lessons?: boolean;
  retrieval?: boolean | { model?: string; maxInjected?: number };
  /** Loosened from upstream's GateConfig — cook doesn't need its shape. */
  wake?: boolean | Record<string, unknown>;
  workspace?: boolean | { mounts: RecipeWorkspaceMount[]; configMount?: boolean };
  /** Surface typing-indicator activity to MCPL channels while inferring. */
  activity?: boolean | { channels?: string[] };
  /**
   * Cross-process child fleet.  Relative paths in `children[].recipe` are
   * resolved at load time against the parent recipe file's directory (or URL
   * base) — see resolveRecipeRelative().  Runtime paths (workspace mounts,
   * dataDir) stay CWD-relative.
   */
  fleet?: boolean | RecipeFleet;
}

export interface RecipeFleet {
  children?: RecipeFleetChild[];
  allowedRecipes?: string[];
  defaultSubscription?: string[];
}

export interface RecipeFleetChild {
  name: string;
  /** Recipe path or http(s) URL; relative paths resolve against the parent
   *  recipe's location (file dir or URL base), not CWD. */
  recipe: string;
  dataDir?: string;
  env?: Record<string, string>;
  subscription?: string[];
  autoStart?: boolean;
  autoRestart?: boolean;
}

export interface Recipe {
  name: string;
  description?: string;
  version?: string;
  agent: RecipeAgent;
  mcpServers?: Record<string, RecipeMcpServer>;
  modules?: RecipeModules;
  sessionNaming?: { examples?: string[] };
  /** Sidecar services that build/deploy tooling includes alongside the agent
   *  process (databases, viewers, search engines, reverse proxies).  Loader
   *  ignores at runtime; cook translates to docker-compose entries. */
  services?: RecipeSidecarService[];
  /** Templated config files cook should render and bind into the agent
   *  container.  Use case: nested-JSON config like mediawiki-mcp-server's
   *  config.json that doesn't fit credentialFiles' flat shape.  Named
   *  distinctly from the per-sidecar `templateFiles` to keep the two
   *  shapes from colliding in autocomplete and error messages. */
  containerTemplateFiles?: RecipeContainerTemplateFile[];
}

export interface RecipeContainerTemplateFile {
  hostPath: string;
  inContainer: string;
  /** `${VAR}` / `${VAR:-default}` substitution; `$$` → literal `$`. */
  template: string;
  mode?: string;
}

export interface RecipeSidecarService {
  name: string;
  image: string;
  ports?: string[];
  volumes?: Array<{ source: string; target: string; readOnly?: boolean }>;
  environment?: Record<string, string>;
  secrets?: string[];
  dependsOn?: string[];
  restart?: 'unless-stopped' | 'no' | 'always' | 'on-failure';
  healthcheck?: {
    test: string[];
    interval?: string;
    timeout?: string;
    retries?: number;
    startPeriod?: string;
  };
  templateFiles?: RecipeTemplateFile[];
}

/** Generated config file the build tool renders from a `${VAR}` template
 *  + collected env values (operator prompts / --env-file / process.env).
 *  Distinct from credentialFiles which serializes structured fields. */
export interface RecipeTemplateFile {
  path: string;
  template: string;
  mode?: string;
}

// ---------------------------------------------------------------------------
// Path resolution helpers
// ---------------------------------------------------------------------------

/** Base for resolving recipe-relative paths.  `file` sources use the parent
 *  recipe's directory; `url` sources use the parent URL as base. */
export type RecipeSourceBase =
  | { kind: 'file'; dir: string }
  | { kind: 'url'; base: string };

/** Resolve a child recipe reference against its parent's source base.
 *  Absolute paths and `http(s)://` URLs pass through unchanged.  Used by
 *  cook's walker to traverse fleet children portably. */
export function resolveRecipeRelative(child: string, base: RecipeSourceBase): string {
  if (child.startsWith('http://') || child.startsWith('https://')) return child;
  if (isAbsolute(child)) return child;
  if (base.kind === 'file') return resolve(base.dir, child);
  return new URL(child, base.base).href;
}

// ---------------------------------------------------------------------------
// Loading (raw — no env-substitution, no prompt-fetching, no path resolution)
// ---------------------------------------------------------------------------

/**
 * Read a recipe from a URL or local file, parse JSON, and validate structure.
 *
 * Unlike upstream's `loadRecipe`, this does NOT substitute `${VAR}` tokens
 * in string values, does NOT fetch a system-prompt URL, and does NOT mutate
 * `children[].recipe` strings to absolute paths.  Cook's pipeline needs raw
 * recipes so the env-collector can find unresolved `${VAR}`s and prompt the
 * operator, and the walker can drive its own deterministic traversal.
 */
export async function loadRecipeRaw(source: string): Promise<Recipe> {
  let raw: unknown;

  if (source.startsWith('http://') || source.startsWith('https://')) {
    const res = await fetch(source);
    if (!res.ok) {
      throw new Error(
        `Failed to fetch recipe from ${source}: ${res.status} ${res.statusText}`,
      );
    }
    raw = await res.json();
  } else {
    const path = resolve(source);
    if (!existsSync(path)) throw new Error(`Recipe file not found: ${path}`);
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  }

  return validateRecipe(raw);
}

/**
 * Validate raw JSON against the recipe schema.  Pure function — does not
 * touch process.env or the filesystem.  Allows `${VAR}` strings to pass
 * through (they're typed as `string`, the validator only checks types).
 */
/** Reject path strings that would escape a sandboxed output dir.  Recipes
 *  may come from operator-supplied URLs, so every host-side path is treated
 *  as untrusted: must be relative AND contain no `..` segments. */
function rejectPathEscape(label: string, path: string): void {
  if (path.startsWith('/')) {
    throw new Error(`${label} must be a relative path (no leading "/"); got "${path}"`);
  }
  if (/(^|\/)\.\.(\/|$)/.test(path)) {
    throw new Error(`${label} contains a ".." segment which is not allowed; got "${path}"`);
  }
  if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')) {
    throw new Error(`${label} must not be an absolute Windows path; got "${path}"`);
  }
}

/** Normalize relative paths for cross-validation comparison.  Strips a
 *  single leading `./` and collapses repeated slashes; trailing slashes
 *  preserved (a trailing slash on a path implies "directory", which is
 *  semantically distinct from the file form for our purposes).
 *  Used to make `./foo` and `foo` compare equal when matching
 *  `services[].templateFiles[].path` against `services[].volumes[].source`. */
function normalizeRelPath(p: string): string {
  return p.replace(/^\.\//, '').replace(/\/{2,}/g, '/');
}

export function validateRecipe(raw: unknown): Recipe {
  if (!raw || typeof raw !== 'object') throw new Error('Recipe must be a JSON object');
  const obj = raw as Record<string, unknown>;

  if (typeof obj.name !== 'string' || !obj.name) {
    throw new Error('Recipe must have a "name" string');
  }
  if (!obj.agent || typeof obj.agent !== 'object') {
    throw new Error('Recipe must have an "agent" object');
  }

  const agent = obj.agent as Record<string, unknown>;
  if (typeof agent.systemPrompt !== 'string' || !agent.systemPrompt) {
    throw new Error('Recipe agent must have a "systemPrompt" string');
  }

  if (agent.strategy) {
    const strategy = agent.strategy as Record<string, unknown>;
    if (
      strategy.type &&
      strategy.type !== 'autobiographical' &&
      strategy.type !== 'passthrough' &&
      strategy.type !== 'frontdesk'
    ) {
      throw new Error(
        `Invalid strategy type "${strategy.type}". Must be "autobiographical", "passthrough", or "frontdesk".`,
      );
    }
  }

  if (obj.mcpServers && typeof obj.mcpServers === 'object') {
    for (const [id, entry] of Object.entries(obj.mcpServers as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object') {
        throw new Error(`mcpServers.${id} must be an object`);
      }
      const server = entry as Record<string, unknown>;
      const hasCommand = typeof server.command === 'string' && server.command;
      const hasUrl = typeof server.url === 'string' && server.url;
      if (!hasCommand && !hasUrl) {
        throw new Error(
          `mcpServers.${id} must have a "command" string (stdio) or "url" string (websocket)`,
        );
      }
      if (server.args !== undefined && !Array.isArray(server.args)) {
        throw new Error(`mcpServers.${id}.args must be an array`);
      }
      if (server.source !== undefined) {
        if (typeof server.source !== 'object' || server.source === null) {
          throw new Error(`mcpServers.${id}.source must be an object`);
        }
        const src = server.source as Record<string, unknown>;
        if (typeof src.url !== 'string' || !src.url) {
          throw new Error(`mcpServers.${id}.source.url must be a non-empty string`);
        }
        if (src.ref !== undefined && typeof src.ref !== 'string') {
          throw new Error(`mcpServers.${id}.source.ref must be a string`);
        }
        if (src.install !== undefined) {
          const install = src.install;
          const isShorthand = install === 'npm' || install === 'pip-editable';
          const isCustom =
            typeof install === 'object' && install !== null
            && typeof (install as Record<string, unknown>).run === 'string'
            && ['node', 'python3', 'custom'].includes(
              (install as Record<string, unknown>).runtime as string,
            );
          if (!isShorthand && !isCustom) {
            throw new Error(
              `mcpServers.${id}.source.install must be 'npm', 'pip-editable', ` +
              `or { run: string, runtime: 'node' | 'python3' | 'custom' }`,
            );
          }
        }
        if (src.authSecret !== undefined && typeof src.authSecret !== 'string') {
          throw new Error(`mcpServers.${id}.source.authSecret must be a string`);
        }
        if (src.sslBypass !== undefined && typeof src.sslBypass !== 'boolean') {
          throw new Error(`mcpServers.${id}.source.sslBypass must be a boolean`);
        }
        if (src.inContainer !== undefined) {
          if (typeof src.inContainer !== 'object' || src.inContainer === null) {
            throw new Error(`mcpServers.${id}.source.inContainer must be an object`);
          }
          if (typeof (src.inContainer as Record<string, unknown>).path !== 'string') {
            throw new Error(`mcpServers.${id}.source.inContainer.path must be a string`);
          }
        }
      }
      for (const field of ['enabledTools', 'disabledTools'] as const) {
        if (server[field] === undefined) continue;
        if (
          !Array.isArray(server[field])
          || !(server[field] as unknown[]).every((p) => typeof p === 'string' && p)
        ) {
          throw new Error(`mcpServers.${id}.${field} must be an array of non-empty strings`);
        }
      }
      if (server.credentialFiles !== undefined) {
        if (!Array.isArray(server.credentialFiles)) {
          throw new Error(`mcpServers.${id}.credentialFiles must be an array`);
        }
        const seenPaths = new Set<string>();
        for (let i = 0; i < server.credentialFiles.length; i++) {
          const cf = server.credentialFiles[i] as Record<string, unknown>;
          if (!cf || typeof cf !== 'object') {
            throw new Error(`mcpServers.${id}.credentialFiles[${i}] must be an object`);
          }
          if (typeof cf.path !== 'string' || !cf.path) {
            throw new Error(`mcpServers.${id}.credentialFiles[${i}].path must be a non-empty string`);
          }
          if (seenPaths.has(cf.path)) {
            throw new Error(`mcpServers.${id}.credentialFiles[${i}].path "${cf.path}" is duplicated within the same server`);
          }
          seenPaths.add(cf.path);
          if (cf.format !== 'ini' && cf.format !== 'json' && cf.format !== 'env') {
            throw new Error(`mcpServers.${id}.credentialFiles[${i}].format must be 'ini', 'json', or 'env'`);
          }
          if (cf.section !== undefined && typeof cf.section !== 'string') {
            throw new Error(`mcpServers.${id}.credentialFiles[${i}].section must be a string`);
          }
          if (cf.mode !== undefined && (typeof cf.mode !== 'string' || !/^0?[0-7]{3,4}$/.test(cf.mode))) {
            throw new Error(`mcpServers.${id}.credentialFiles[${i}].mode must be an octal string like "0600"`);
          }
          if (!Array.isArray(cf.fields) || cf.fields.length === 0) {
            throw new Error(`mcpServers.${id}.credentialFiles[${i}].fields must be a non-empty array`);
          }
          const seenFieldNames = new Set<string>();
          for (let j = 0; j < cf.fields.length; j++) {
            const f = cf.fields[j] as Record<string, unknown>;
            if (!f || typeof f !== 'object') {
              throw new Error(`mcpServers.${id}.credentialFiles[${i}].fields[${j}] must be an object`);
            }
            if (typeof f.name !== 'string' || !f.name) {
              throw new Error(`mcpServers.${id}.credentialFiles[${i}].fields[${j}].name must be a non-empty string`);
            }
            if (seenFieldNames.has(f.name)) {
              throw new Error(`mcpServers.${id}.credentialFiles[${i}].fields[${j}].name "${f.name}" is duplicated`);
            }
            seenFieldNames.add(f.name);
            if (f.envOverride !== undefined && (typeof f.envOverride !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(f.envOverride))) {
              throw new Error(`mcpServers.${id}.credentialFiles[${i}].fields[${j}].envOverride must be a valid env var name`);
            }
            for (const optStr of ['description', 'placeholder'] as const) {
              if (f[optStr] !== undefined && typeof f[optStr] !== 'string') {
                throw new Error(`mcpServers.${id}.credentialFiles[${i}].fields[${j}].${optStr} must be a string`);
              }
            }
            if (f.secret !== undefined && typeof f.secret !== 'boolean') {
              throw new Error(`mcpServers.${id}.credentialFiles[${i}].fields[${j}].secret must be a boolean`);
            }
          }
        }
      }
    }
  }

  if (obj.modules && typeof obj.modules === 'object') {
    const mods = obj.modules as Record<string, unknown>;
    if (mods.workspace && typeof mods.workspace === 'object') {
      const ws = mods.workspace as Record<string, unknown>;
      if (!Array.isArray(ws.mounts) || ws.mounts.length === 0) {
        throw new Error('workspace.mounts must be a non-empty array');
      }
      for (let i = 0; i < ws.mounts.length; i++) {
        const m = ws.mounts[i] as Record<string, unknown>;
        if (!m || typeof m !== 'object') {
          throw new Error(`workspace.mounts[${i}] must be an object`);
        }
        if (typeof m.name !== 'string' || !m.name) {
          throw new Error(`workspace.mounts[${i}].name must be a non-empty string`);
        }
        if (typeof m.path !== 'string' || !m.path) {
          throw new Error(`workspace.mounts[${i}].path must be a non-empty string`);
        }
        if (m.mode !== undefined && m.mode !== 'read-write' && m.mode !== 'read-only') {
          throw new Error(`workspace.mounts[${i}].mode must be "read-write" or "read-only"`);
        }
      }
    }

    if (mods.fleet && typeof mods.fleet === 'object') {
      const fleet = mods.fleet as Record<string, unknown>;
      if (fleet.children !== undefined) {
        if (!Array.isArray(fleet.children)) {
          throw new Error('fleet.children must be an array');
        }
        const seenNames = new Set<string>();
        for (let i = 0; i < fleet.children.length; i++) {
          const c = fleet.children[i] as Record<string, unknown>;
          if (!c || typeof c !== 'object') {
            throw new Error(`fleet.children[${i}] must be an object`);
          }
          if (typeof c.name !== 'string' || !c.name) {
            throw new Error(`fleet.children[${i}].name must be a non-empty string`);
          }
          if (seenNames.has(c.name)) {
            throw new Error(`fleet.children[${i}].name "${c.name}" is duplicated`);
          }
          seenNames.add(c.name);
          if (typeof c.recipe !== 'string' || !c.recipe) {
            throw new Error(`fleet.children[${i}].recipe must be a non-empty string`);
          }
          if (c.subscription !== undefined && !Array.isArray(c.subscription)) {
            throw new Error(`fleet.children[${i}].subscription must be an array of strings`);
          }
          if (c.autoStart !== undefined && typeof c.autoStart !== 'boolean') {
            throw new Error(`fleet.children[${i}].autoStart must be a boolean`);
          }
        }
      }
      if (fleet.allowedRecipes !== undefined) {
        if (
          !Array.isArray(fleet.allowedRecipes)
          || !fleet.allowedRecipes.every((r) => typeof r === 'string')
        ) {
          throw new Error('fleet.allowedRecipes must be an array of strings');
        }
        for (const pattern of fleet.allowedRecipes as string[]) {
          if (pattern === '*' || !pattern.includes('*')) continue;
          if (pattern.indexOf('*') !== pattern.length - 1) {
            throw new Error(
              `fleet.allowedRecipes entry "${pattern}" has a mid-string "*". ` +
              `Only trailing "*" (prefix match) or a bare "*" (allow all) are supported.`,
            );
          }
        }
      }
      if (fleet.defaultSubscription !== undefined) {
        if (
          !Array.isArray(fleet.defaultSubscription)
          || !fleet.defaultSubscription.every((s) => typeof s === 'string')
        ) {
          throw new Error('fleet.defaultSubscription must be an array of strings');
        }
      }
    }
  }

  if (obj.containerTemplateFiles !== undefined) {
    if (!Array.isArray(obj.containerTemplateFiles)) {
      throw new Error('containerTemplateFiles must be an array');
    }
    const seenHostPaths = new Set<string>();
    const seenContainerPaths = new Set<string>();
    for (let i = 0; i < obj.containerTemplateFiles.length; i++) {
      const tf = obj.containerTemplateFiles[i] as Record<string, unknown>;
      if (!tf || typeof tf !== 'object') {
        throw new Error(`containerTemplateFiles[${i}] must be an object`);
      }
      if (typeof tf.hostPath !== 'string' || !tf.hostPath) {
        throw new Error(`containerTemplateFiles[${i}].hostPath must be a non-empty string`);
      }
      rejectPathEscape(`containerTemplateFiles[${i}].hostPath`, tf.hostPath);
      if (seenHostPaths.has(tf.hostPath)) {
        throw new Error(`containerTemplateFiles[${i}].hostPath "${tf.hostPath}" is duplicated`);
      }
      seenHostPaths.add(tf.hostPath);
      if (typeof tf.inContainer !== 'string' || !tf.inContainer) {
        throw new Error(`containerTemplateFiles[${i}].inContainer must be a non-empty string`);
      }
      if (seenContainerPaths.has(tf.inContainer)) {
        throw new Error(`containerTemplateFiles[${i}].inContainer "${tf.inContainer}" is duplicated`);
      }
      seenContainerPaths.add(tf.inContainer);
      if (typeof tf.template !== 'string') {
        throw new Error(`containerTemplateFiles[${i}].template must be a string`);
      }
      if (tf.mode !== undefined && (typeof tf.mode !== 'string' || !/^0?[0-7]{3,4}$/.test(tf.mode))) {
        throw new Error(`containerTemplateFiles[${i}].mode must be an octal string like "0644"`);
      }
    }
  }
  if (obj.templateFiles !== undefined && obj.containerTemplateFiles === undefined) {
    throw new Error(
      'top-level `templateFiles` is not a valid field — use `containerTemplateFiles` ' +
      '(per-sidecar `templateFiles` lives under `services[].templateFiles`).',
    );
  }

  if (obj.services !== undefined) {
    if (!Array.isArray(obj.services)) {
      throw new Error('services must be an array');
    }
    const seenSvcNames = new Set<string>();
    for (let i = 0; i < obj.services.length; i++) {
      const svc = obj.services[i] as Record<string, unknown>;
      if (!svc || typeof svc !== 'object') {
        throw new Error(`services[${i}] must be an object`);
      }
      if (typeof svc.name !== 'string' || !svc.name || !/^[a-z][a-z0-9_-]*$/.test(svc.name)) {
        throw new Error(`services[${i}].name must be a non-empty lowercase identifier (a-z 0-9 _ -)`);
      }
      if (seenSvcNames.has(svc.name)) {
        throw new Error(`services[${i}].name "${svc.name}" is duplicated`);
      }
      seenSvcNames.add(svc.name);
      if (typeof svc.image !== 'string' || !svc.image) {
        throw new Error(`services[${i}].image must be a non-empty string`);
      }
      if (svc.ports !== undefined) {
        if (!Array.isArray(svc.ports) || !(svc.ports as unknown[]).every((p) => typeof p === 'string' && p)) {
          throw new Error(`services[${i}].ports must be an array of non-empty strings`);
        }
      }
      if (svc.volumes !== undefined) {
        if (!Array.isArray(svc.volumes)) {
          throw new Error(`services[${i}].volumes must be an array`);
        }
        for (let v = 0; v < svc.volumes.length; v++) {
          const vol = svc.volumes[v] as Record<string, unknown>;
          if (!vol || typeof vol !== 'object') {
            throw new Error(`services[${i}].volumes[${v}] must be an object`);
          }
          if (typeof vol.source !== 'string' || !vol.source) {
            throw new Error(`services[${i}].volumes[${v}].source must be a non-empty string`);
          }
          if (typeof vol.target !== 'string' || !vol.target) {
            throw new Error(`services[${i}].volumes[${v}].target must be a non-empty string`);
          }
          if (vol.readOnly !== undefined && typeof vol.readOnly !== 'boolean') {
            throw new Error(`services[${i}].volumes[${v}].readOnly must be a boolean`);
          }
        }
      }
      if (svc.environment !== undefined) {
        if (typeof svc.environment !== 'object' || Array.isArray(svc.environment)) {
          throw new Error(`services[${i}].environment must be an object`);
        }
        for (const [k, val] of Object.entries(svc.environment as Record<string, unknown>)) {
          if (typeof val !== 'string') {
            throw new Error(`services[${i}].environment.${k} must be a string`);
          }
        }
      }
      if (svc.secrets !== undefined) {
        if (!Array.isArray(svc.secrets) || !(svc.secrets as unknown[]).every((s) => typeof s === 'string' && s)) {
          throw new Error(`services[${i}].secrets must be an array of non-empty strings`);
        }
      }
      if (svc.dependsOn !== undefined) {
        if (!Array.isArray(svc.dependsOn) || !(svc.dependsOn as unknown[]).every((s) => typeof s === 'string' && s)) {
          throw new Error(`services[${i}].dependsOn must be an array of non-empty strings`);
        }
      }
      if (svc.restart !== undefined) {
        const allowed = ['unless-stopped', 'no', 'always', 'on-failure'];
        if (typeof svc.restart !== 'string' || !allowed.includes(svc.restart)) {
          throw new Error(`services[${i}].restart must be one of ${allowed.join(' / ')}`);
        }
      }
      if (svc.healthcheck !== undefined) {
        if (typeof svc.healthcheck !== 'object' || svc.healthcheck === null) {
          throw new Error(`services[${i}].healthcheck must be an object`);
        }
        const hc = svc.healthcheck as Record<string, unknown>;
        if (!Array.isArray(hc.test) || !(hc.test as unknown[]).every((s) => typeof s === 'string')) {
          throw new Error(`services[${i}].healthcheck.test must be an array of strings`);
        }
        for (const optStr of ['interval', 'timeout', 'startPeriod'] as const) {
          if (hc[optStr] !== undefined && typeof hc[optStr] !== 'string') {
            throw new Error(`services[${i}].healthcheck.${optStr} must be a string`);
          }
        }
        if (hc.retries !== undefined && (typeof hc.retries !== 'number' || hc.retries < 0)) {
          throw new Error(`services[${i}].healthcheck.retries must be a non-negative number`);
        }
      }
      if (svc.templateFiles !== undefined) {
        if (!Array.isArray(svc.templateFiles)) {
          throw new Error(`services[${i}].templateFiles must be an array`);
        }
        const seenTfPaths = new Set<string>();
        // Normalize volume sources for comparison so `./foo` matches `foo`.
        // This is the form templateFiles[].path is stored in (no enforced
        // shape), so normalizing both sides catches operator mismatches
        // that are syntactically different but semantically the same.
        const volumeSources = new Set<string>();
        for (const vol of (svc.volumes as Array<Record<string, unknown>> | undefined) ?? []) {
          if (typeof vol.source === 'string') volumeSources.add(normalizeRelPath(vol.source));
        }
        for (let t = 0; t < svc.templateFiles.length; t++) {
          const tf = svc.templateFiles[t] as Record<string, unknown>;
          if (!tf || typeof tf !== 'object') {
            throw new Error(`services[${i}].templateFiles[${t}] must be an object`);
          }
          if (typeof tf.path !== 'string' || !tf.path) {
            throw new Error(`services[${i}].templateFiles[${t}].path must be a non-empty string`);
          }
          rejectPathEscape(`services[${i}].templateFiles[${t}].path`, tf.path);
          const normalizedTfPath = normalizeRelPath(tf.path);
          if (seenTfPaths.has(normalizedTfPath)) {
            throw new Error(`services[${i}].templateFiles[${t}].path "${tf.path}" is duplicated within the service`);
          }
          seenTfPaths.add(normalizedTfPath);
          if (typeof tf.template !== 'string') {
            throw new Error(`services[${i}].templateFiles[${t}].template must be a string`);
          }
          if (tf.mode !== undefined && (typeof tf.mode !== 'string' || !/^0?[0-7]{3,4}$/.test(tf.mode))) {
            throw new Error(`services[${i}].templateFiles[${t}].mode must be an octal string like "0644"`);
          }
          if (!volumeSources.has(normalizedTfPath)) {
            throw new Error(
              `services[${i}].templateFiles[${t}].path "${tf.path}" has no matching ` +
              `entry in services[${i}].volumes[].source — the rendered template will ` +
              `not be visible to the sidecar.  Add a corresponding volume mount.`,
            );
          }
        }
      }
    }
  }

  return obj as unknown as Recipe;
}
