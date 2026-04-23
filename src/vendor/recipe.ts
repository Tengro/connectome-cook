/**
 * Vendored from connectome-host: forking-knowledge-miner/src/recipe.ts
 * Sync source: github.com/anima-research/connectome-host
 * Last synced: commit 6273370 (feat(recipe): add source metadata for build/deploy tooling)
 *
 * Why vendored: connectome-host isn't published to npm, so cook can't depend
 * on it directly. The recipe schema is small and stable enough that
 * duplicating ~200 LoC is cheaper than wrangling a git/file dep. Re-sync this
 * file when the upstream schema evolves; the surface that matters for cook is:
 *
 *   - Type exports (Recipe + nested types)
 *   - validateRecipe() — structural validation
 *   - loadRecipeRaw() — read+parse+validate WITHOUT env-substitution
 *
 * Two deliberate divergences from upstream:
 *
 *   1. We expose loadRecipeRaw() instead of loadRecipe(). Cook needs to scan
 *      raw recipe JSON for ${VAR} patterns BEFORE substitution (so we can
 *      prompt the operator for missing values), and never wants to fetch
 *      remote system-prompt URLs at build time.
 *
 *   2. RecipeModules.wake is loosened from `GateConfig` to `Record<string,
 *      unknown>`. We don't depend on @animalabs/agent-framework, and cook
 *      doesn't introspect wake's internals — only enabled-yes-or-no.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

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
  reconnect?: boolean;
  reconnectIntervalMs?: number;
  channelSubscription?: 'auto' | 'manual' | string[];
  source?: RecipeMcpServerSource;
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
  subagents?: boolean | { defaultModel?: string };
  lessons?: boolean;
  retrieval?: boolean | { model?: string; maxInjected?: number };
  /** Loosened from upstream's GateConfig — cook doesn't need its shape. */
  wake?: boolean | Record<string, unknown>;
  workspace?: boolean | { mounts: RecipeWorkspaceMount[]; configMount?: boolean };
  fleet?: boolean | RecipeFleet;
}

export interface RecipeFleet {
  children?: RecipeFleetChild[];
  allowedRecipes?: string[];
  defaultSubscription?: string[];
}

export interface RecipeFleetChild {
  name: string;
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
// Loading (raw — no env-substitution, no prompt-fetching)
// ---------------------------------------------------------------------------

/**
 * Read a recipe from a URL or local file, parse JSON, and validate structure.
 *
 * Unlike upstream's `loadRecipe`, this does NOT substitute `${VAR}` tokens
 * in string values, and does NOT fetch a system-prompt URL.  Cook's pipeline
 * needs raw recipes so the env-collector can find unresolved `${VAR}`s and
 * prompt the operator for them.
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
