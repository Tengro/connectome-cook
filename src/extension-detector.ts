/**
 * Extension detector — the `extensions` counterpart of source-detector.
 *
 * Walks each recipe's `extensions` block and classifies every entry into
 * one of three acquisition modes:
 *
 *   1. `source` present (git shape) → a builder-stage source, expressed as
 *      an `McpSource` with `role: 'extension'` so the existing runtimes/
 *      dockerfile machinery clones + builds it unchanged. Target path is
 *      `/app/extensions/<name>` — extensions must live under /app so Bun's
 *      upward node_modules resolution reaches connectome-host's dependency
 *      tree (that's what makes `extends AutobiographicalStrategy` resolve
 *      against the exact @animalabs/* versions the host ships).
 *      `path` is interpreted relative to the cloned repo root.
 *
 *   2. no `source`, relative `path` → a LocalExtension: cook bundles the
 *      directory containing the entry file from the operator's disk into
 *      the build context and the Dockerfile COPYs it in. Only valid for
 *      file-loaded recipes (URL recipes have no local dir to bundle from).
 *
 *   3. no `source`, absolute `path` → cook cannot bake it. Strict mode
 *      errors; non-strict warns and leaves the path untouched (operator
 *      must bind-mount the code at that path).
 *
 * Dedup: extensions are keyed by name (`ext:<name>`). The same name
 * declared by multiple recipes in a fleet must agree on its metadata —
 * first-write-wins with a divergence warning, mirroring source-detector.
 */

import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  InstallPattern,
  LocalExtension,
  McpSource,
  SourceRef,
  WalkResult,
} from './types.js';
import type { RecipeExtension, RecipeMcpServerGitSource } from './vendor/recipe.js';

export interface DetectExtensionsOptions {
  strict: boolean;
}

export interface DetectedExtensions {
  /** Git-sourced extensions, ready to be concatenated into the sources list. */
  gitExtensions: McpSource[];
  /** Local bundles cook must copy into the build context. */
  localExtensions: LocalExtension[];
}

/** In-image root for all baked extensions. */
export const EXTENSIONS_CONTAINER_ROOT = '/app/extensions';

/** Map a recipe extension's `source.install` to the internal pattern —
 *  same semantics as source-detector's mapping for MCP servers. */
function mapInstall(
  install: RecipeMcpServerGitSource['install'] | undefined,
): InstallPattern {
  if (install === 'npm') return { kind: 'npm' };
  if (install === 'pip-editable') return { kind: 'pip-editable' };
  if (install && typeof install === 'object') {
    return { kind: 'custom', run: install.run, runtime: install.runtime };
  }
  // Default: clone only. Bun-on-source imports TS directly, so a plain
  // strategy/module extension needs no build step at all.
  return { kind: 'custom', run: '', runtime: 'bun' };
}

/** Strip a leading `./` and collapse duplicate slashes. */
function normalizeEntry(path: string): string {
  return path.replace(/^\.\//, '').replace(/\/{2,}/g, '/');
}

function warnDivergent(name: string, field: string, first: string, next: string): void {
  process.stderr.write(
    `[extension-detector] WARN: extension "${name}" has divergent ${field} — ` +
    `"${first}" vs "${next}"; keeping the first.\n`,
  );
}

/**
 * Inspect every walked recipe's `extensions` block. Throws an aggregated
 * error for entries cook cannot bake (strict mode) or that are structurally
 * impossible (relative local path on a URL-loaded recipe).
 */
export function detectExtensions(
  walks: WalkResult[],
  options: DetectExtensionsOptions,
): DetectedExtensions {
  const gitByName = new Map<string, McpSource>();
  const localByName = new Map<string, LocalExtension>();
  /** Entries cook cannot bake: absolute path without source. */
  const unbakeable: Array<{ recipePath: string; name: string; path: string }> = [];
  const errors: string[] = [];

  for (const walk of walks) {
    const extensions = walk.recipe.extensions;
    if (!extensions) continue;
    const isUrlRecipe = walk.path.startsWith('http://') || walk.path.startsWith('https://');

    for (const [name, ext] of Object.entries(extensions)) {
      const ref: SourceRef = { recipePath: walk.path, mcpServerName: name };

      if (ext.source) {
        addGitExtension(gitByName, localByName, name, ext, ref, errors);
        continue;
      }

      if (isAbsolute(ext.path)) {
        unbakeable.push({ recipePath: walk.path, name, path: ext.path });
        continue;
      }

      if (isUrlRecipe) {
        errors.push(
          `${walk.path} :: extensions.${name}: relative path "${ext.path}" on a URL-loaded ` +
          `recipe has no local directory to bundle from. Add a \`source\` block or use an absolute path.`,
        );
        continue;
      }

      addLocalExtension(localByName, gitByName, walk.path, name, ext, ref, errors);
    }
  }

  if (options.strict && unbakeable.length > 0) {
    const lines = unbakeable
      .map((u) => `  - ${u.recipePath} :: extensions.${u.name} (path ${u.path})`)
      .join('\n');
    errors.push(
      `Extension(s) with absolute paths and no 'source' block cannot be baked into the image (strict mode):\n${lines}\n` +
      `Add a 'source' block, switch to a recipe-relative path, or rerun without --strict (and bind-mount the code).`,
    );
  } else {
    for (const u of unbakeable) {
      process.stderr.write(
        `[extension-detector] WARN: ${u.recipePath} :: extensions.${u.name} has absolute path ` +
        `${u.path} and no source — not baked; the operator must bind-mount the code at that path.\n`,
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }

  return {
    gitExtensions: Array.from(gitByName.values()),
    localExtensions: Array.from(localByName.values()),
  };
}

function addGitExtension(
  gitByName: Map<string, McpSource>,
  localByName: Map<string, LocalExtension>,
  name: string,
  ext: RecipeExtension,
  ref: SourceRef,
  errors: string[],
): void {
  const source = ext.source!;
  if (isAbsolute(ext.path)) {
    errors.push(
      `${ref.recipePath} :: extensions.${name}: with a 'source' block, 'path' must be ` +
      `relative to the cloned repo root; got absolute "${ext.path}".`,
    );
    return;
  }
  if (localByName.has(name)) {
    errors.push(
      `extension "${name}" is declared both with and without a 'source' block across recipes — ` +
      `pick one acquisition mode.`,
    );
    return;
  }

  const entry = normalizeEntry(ext.path);
  const existing = gitByName.get(name);
  if (existing) {
    if (existing.url !== source.url) warnDivergent(name, 'source.url', existing.url, source.url);
    if (existing.ref !== (source.ref ?? 'main')) warnDivergent(name, 'source.ref', existing.ref, source.ref ?? 'main');
    if (existing.entry !== entry) warnDivergent(name, 'path', existing.entry ?? '', entry);
    if (source.systemPackages && source.systemPackages.length > 0) {
      existing.systemPackages = [
        ...new Set([...(existing.systemPackages ?? []), ...source.systemPackages]),
      ].sort();
    }
    existing.refs.push(ref);
    return;
  }

  gitByName.set(name, {
    role: 'extension',
    extensionName: name,
    entry,
    key: `ext:${name}`,
    url: source.url,
    ref: source.ref ?? 'main',
    install: mapInstall(source.install),
    inContainerPath: `${EXTENSIONS_CONTAINER_ROOT}/${name}`,
    refs: [ref],
    ...(source.authSecret !== undefined ? { authSecret: source.authSecret } : {}),
    ...(source.sslBypass !== undefined ? { sslBypass: source.sslBypass } : {}),
    ...(source.systemPackages !== undefined ? { systemPackages: source.systemPackages } : {}),
  });
}

function addLocalExtension(
  localByName: Map<string, LocalExtension>,
  gitByName: Map<string, McpSource>,
  recipePath: string,
  name: string,
  ext: RecipeExtension,
  ref: SourceRef,
  errors: string[],
): void {
  if (gitByName.has(name)) {
    errors.push(
      `extension "${name}" is declared both with and without a 'source' block across recipes — ` +
      `pick one acquisition mode.`,
    );
    return;
  }

  const resolved = resolve(dirname(recipePath), ext.path);
  if (!existsSync(resolved)) {
    errors.push(
      `${recipePath} :: extensions.${name}: entry file not found at ${resolved} — ` +
      `cook bundles the containing directory from your disk, so the file must exist at build time.`,
    );
    return;
  }
  const hostDir = dirname(resolved);
  const entryBasename = basename(resolved);

  const existing = localByName.get(name);
  if (existing) {
    if (existing.hostDir !== hostDir) warnDivergent(name, 'directory', existing.hostDir, hostDir);
    if (existing.entryBasename !== entryBasename) {
      warnDivergent(name, 'entry file', existing.entryBasename, entryBasename);
    }
    existing.refs.push(ref);
    return;
  }

  localByName.set(name, {
    name,
    hostDir,
    entryBasename,
    inContainerPath: `${EXTENSIONS_CONTAINER_ROOT}/${name}`,
    hasPackageJson: existsSync(join(hostDir, 'package.json')),
    refs: [ref],
  });
}
