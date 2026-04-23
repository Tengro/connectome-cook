/**
 * Shared types for connectome-cook.
 *
 * These are the data structures that flow between modules:
 *   cli → walker → source-detector → generators
 *             └──→ env-collector ──┘
 *
 * Recipe types are vendored at src/vendor/recipe.ts and re-exported below
 * for convenient consumption.
 */

import type { Recipe } from './vendor/recipe.js';
export type { Recipe } from './vendor/recipe.js';

/** Result of walking a recipe tree: parent + every reachable fleet child. */
export interface WalkResult {
  /** Absolute path (or URL) the recipe was loaded from. */
  path: string;
  /** The loaded recipe object (raw — no env substitution applied). */
  recipe: Recipe;
}

/** How an MCP server's source should be installed inside the image. */
export type InstallPattern =
  | { kind: 'npm' }
  | { kind: 'pip-editable' }
  | { kind: 'custom'; run: string; runtime: 'node' | 'python3' | 'custom' }
  /** Operator must supply a sibling checkout at build time; used when a
   *  recipe's MCP server has no `source` block and we're not in `--strict`. */
  | { kind: 'sibling-copy'; siblingDir: string };

/** Normalized metadata for one MCP server whose source we need to bake in.
 *  Deduplication key: `${url}@${ref}`. Multiple recipe refs may point at
 *  the same source (e.g. Zulip is used by miner, reviewer, and clerk). */
export interface McpSource {
  /** Unique key used for deduplication across a walked recipe tree. */
  key: string;
  /** Source git URL (from `RecipeMcpServerSource.url`). */
  url: string;
  /** Git ref: branch name, tag, or refspec. Empty when sibling-copy. */
  ref: string;
  /** Install pattern — see `InstallPattern`. */
  install: InstallPattern;
  /** Name of the env var holding a secret consumed by the install step
   *  (e.g. `ZULIP_TOKEN` for a private-repo clone). */
  authSecret?: string;
  /** Whether to tolerate self-signed TLS during `git clone` (internal servers). */
  sslBypass?: boolean;
  /** Absolute path inside the image where the source lives after install. */
  inContainerPath: string;
  /** Where this source is referenced (for error messages + README). */
  refs: SourceRef[];
}

/** A reference to an McpSource from a specific recipe's MCP server entry. */
export interface SourceRef {
  /** Path of the recipe that references this source. */
  recipePath: string;
  /** Name of the MCP server entry (`recipe.mcpServers[].name`). */
  mcpServerName: string;
}

/** An environment variable discovered by scanning recipe JSON for `${VAR}`. */
export interface EnvVar {
  name: string;
  /** Everywhere this variable is referenced. */
  usedIn: EnvVarUse[];
}

export interface EnvVarUse {
  recipePath: string;
  /** Dotted JSON path into the recipe (for debugging / error messages). */
  jsonPath: string;
}

/** Flags accepted by `cook build` / `cook run` / `cook check`. */
export interface BuildOptions {
  /** Output directory for generated artifacts. */
  outDir: string;
  /** If true, skip interactive prompting — expect all vars preset. */
  noPrompts: boolean;
  /** Path to a dotenv-shaped file with variable values. */
  envFile?: string;
  /** Fail on any MCP server without a `source` block (no sibling-COPY fallback). */
  strict: boolean;
  /** Override for generated image name. Default: derived from recipe. */
  imageName?: string;
  /** If true, resolve each branch ref to its current commit SHA before baking. */
  pinRefs: boolean;
}

/** Subcommand handler signature — all subcommands conform to this. */
export type SubcommandHandler = (argv: string[]) => Promise<number>;
