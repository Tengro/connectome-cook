/**
 * Vendored from connectome-host: forking-knowledge-miner/src/recipe.ts
 * Sync source: github.com/anima-research/connectome-host
 * Last synced: commit bb40b64 (feat(recipe): credentialFiles schema for auxiliary
 *              side files).  Earlier syncs covered: a111e79 (parent-dir resolution
 *              + enabledTools/disabledTools + activity), 6273370 (source metadata).
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

  return obj as unknown as Recipe;
}
