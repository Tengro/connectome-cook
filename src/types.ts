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
  | { kind: 'custom'; run: string; runtime: 'node' | 'python3' | 'custom' | 'bun' }
  /** Install a published npm package globally (`npm install -g <package>`) at
   *  image build time. Unlike the git-clone kinds this has no `inContainerPath`
   *  and no builder stage — it runs in the runtime stage so the recipe's
   *  `npx -y <package>` command resolves it offline, closing the cold-boot
   *  fetch race. `package` is the full spec incl. version (e.g.
   *  `@professional-wiki/mediawiki-mcp-server@0.12.0`). */
  | { kind: 'npm-global'; package: string }
  /** Operator must supply a sibling checkout at build time; used when a
   *  recipe's MCP server has no `source` block and we're not in `--strict`. */
  | { kind: 'sibling-copy'; siblingDir: string };

/** Normalized metadata for one component whose source we need to bake in —
 *  an MCP server (role 'mcp', the default) or a recipe extension (role
 *  'extension', target `/app/extensions/<name>`). Deduplication key:
 *  `${url}@${ref}` for MCP; `ext:${name}` for extensions. Multiple recipe
 *  refs may point at the same source (e.g. Zulip is used by miner,
 *  reviewer, and clerk). */
export interface McpSource {
  /** What this source provides. Absent means 'mcp' (pre-extension shape). */
  role?: 'mcp' | 'extension';
  /** For role 'extension': the recipe `extensions` key that declared it. */
  extensionName?: string;
  /** For role 'extension': entry module path relative to the source root,
   *  normalized (no leading `./`). Overlay rewrites the shipped recipe's
   *  extension path to `${inContainerPath}/${entry}`. */
  entry?: string;
  /** Unique key used for deduplication across a walked recipe tree. */
  key: string;
  /** Source git URL (from `RecipeMcpServerSource.url`). */
  url: string;
  /** Git ref: branch name, tag, or refspec. Empty when sibling-copy. */
  ref: string;
  /** Commit SHA the ref resolved to at cook time (set by --pin-refs).
   *  When present, builds check out this exact commit instead of the
   *  branch tip, and it's recorded in connectome.lock. */
  commit?: string;
  /** Install pattern — see `InstallPattern`. */
  install: InstallPattern;
  /** Name of the env var holding a secret consumed by the install step
   *  (e.g. `ZULIP_TOKEN` for a private-repo clone). */
  authSecret?: string;
  /** Whether to tolerate self-signed TLS during `git clone` (internal servers). */
  sslBypass?: boolean;
  /** Absolute path inside the image where the source lives after install. */
  inContainerPath: string;
  /** Extra apt packages this source needs in the *runtime* image (e.g.
   *  `ffmpeg`/`curl` for a tool that shells out). Merged into the runtime
   *  apt line — cook can't otherwise know a source's runtime binary deps. */
  systemPackages?: string[];
  /** Where this source is referenced (for error messages + README). */
  refs: SourceRef[];
}

/** A reference to an McpSource from a specific recipe's MCP server entry
 *  (or, for role 'extension', the recipe's `extensions` key — reusing the
 *  field keeps every existing error/README formatter working unchanged). */
export interface SourceRef {
  /** Path of the recipe that references this source. */
  recipePath: string;
  /** Name of the MCP server entry (`recipe.mcpServers[].name`) or the
   *  extension name for role 'extension'. */
  mcpServerName: string;
}

/** A source-less extension with a recipe-relative path: cook bundles the
 *  directory containing the entry file from the operator's disk into the
 *  build context (`<outDir>/extensions/<name>/`) and the Dockerfile COPYs
 *  it to `/app/extensions/<name>`. node_modules/.git are excluded from the
 *  bundle; if the directory has a package.json, the runtime stage runs
 *  `bun install` in it so the extension's own deps resolve. */
export interface LocalExtension {
  /** Recipe `extensions` key — also the bundle dir name. */
  name: string;
  /** Absolute host directory to bundle (dirname of the resolved entry). */
  hostDir: string;
  /** Entry file basename within hostDir (e.g. `index.ts`). */
  entryBasename: string;
  /** Absolute in-image path: `/app/extensions/<name>`. */
  inContainerPath: string;
  /** Whether hostDir contains a package.json (drives the bun install step). */
  hasPackageJson: boolean;
  /** Where this extension is referenced (for errors + README). */
  refs: SourceRef[];
}

/** An environment variable discovered by scanning recipe JSON for `${VAR}`
 *  or `${VAR:-default}`. */
export interface EnvVar {
  name: string;
  /** Everywhere this variable is referenced. */
  usedIn: EnvVarUse[];
  /** When set, the recipe references this var as `${VAR:-default}` — the
   *  literal default text falls back if the operator doesn't supply a
   *  value.  Cook's prompt path treats defaulted vars as optional. */
  defaultValue?: string;
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
  /** Pinned connectome-host SHA (set by --pin-refs): baked as the CH_REF
   *  build-arg default so the image clones the exact commit. */
  pinnedChRef?: string;
}

/** Subcommand handler signature — all subcommands conform to this. */
export type SubcommandHandler = (argv: string[]) => Promise<number>;

/** Bundle of everything a generator needs to emit one artifact.  All Phase 2
 *  generators (dockerfile, compose, overlay, env, readme) take this shape;
 *  individual generators are free to ignore fields they don't need. */
export interface GeneratorInput {
  /** Walker output: parent first, then descendants in declaration order. */
  walks: WalkResult[];
  /** Deduplicated sources discovered across the walked recipes: MCP servers
   *  plus git-sourced extensions (role 'extension'). */
  sources: McpSource[];
  /** Source-less extensions bundled from the operator's disk. */
  localExtensions?: LocalExtension[];
  /** Environment variables referenced anywhere in the walked recipes. */
  envVars: EnvVar[];
  /** Build-time options (output dir, image name, strict mode, etc.). */
  options: BuildOptions;
}
