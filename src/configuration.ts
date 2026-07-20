/**
 * Recipe → configuration lowering.
 *
 * A *recipe* is declarative intent: it may carry `source` blocks, unbound
 * `${VAR}` references, and host-relative paths. A *configuration* is the
 * fully-resolved artifact the runtime loads — overlays applied (in-container
 * paths substituted) and build-only `source` blocks demoted to `sourceMeta`
 * provenance. Every backend ships configurations, never raw recipes; these
 * helpers are the shared lowering step.
 */

import { basename } from 'node:path';
import { slugify } from './slug.js';
import type { Recipe, RecipeExtension, RecipeMcpServer } from './vendor/recipe.js';

/** Apply a Partial<Recipe> overlay to a Recipe with shallow per-entry merge
 *  for mcpServers and extensions. Matches the contract `generateOverlays`
 *  documents — only the fields a generator wants to override are present. */
export function applyOverlay(recipe: Recipe, overlay: Partial<Recipe> | undefined): Recipe {
  if (!overlay) return recipe;
  const merged: Recipe = { ...recipe };
  if (overlay.mcpServers) {
    merged.mcpServers = { ...(recipe.mcpServers ?? {}) };
    for (const [name, overlayServer] of Object.entries(overlay.mcpServers)) {
      const original = recipe.mcpServers?.[name];
      merged.mcpServers[name] = original
        ? { ...original, ...(overlayServer as Partial<RecipeMcpServer>) }
        : (overlayServer as RecipeMcpServer);
    }
  }
  if (overlay.extensions) {
    merged.extensions = { ...(recipe.extensions ?? {}) };
    for (const [name, overlayExt] of Object.entries(overlay.extensions)) {
      const original = recipe.extensions?.[name];
      merged.extensions[name] = original
        ? { ...original, ...(overlayExt as Partial<RecipeExtension>) }
        : (overlayExt as RecipeExtension);
    }
  }
  return merged;
}

/** Demote each mcpServer's and extension's build-only `source` block to
 *  `sourceMeta` before the recipe is shipped as a configuration. The runtime
 *  loader validates `source` yet never uses it — it's build-tooling metadata
 *  that cook alone consumes. Renaming keeps the provenance visible to anyone
 *  reading the shipped file without tripping runtime validation. */
export function demoteMcpSource(recipe: Recipe): Recipe {
  let result = recipe;
  if (recipe.mcpServers) {
    const mcpServers: Record<string, RecipeMcpServer> = {};
    for (const [name, server] of Object.entries(recipe.mcpServers)) {
      const { source, ...rest } = server;
      mcpServers[name] = source === undefined ? rest : { ...rest, sourceMeta: source };
    }
    result = { ...result, mcpServers };
  }
  if (recipe.extensions) {
    const extensions: Record<string, RecipeExtension> = {};
    for (const [name, ext] of Object.entries(recipe.extensions)) {
      const { source, ...rest } = ext;
      extensions[name] = source === undefined ? rest : { ...rest, sourceMeta: source };
    }
    result = { ...result, extensions };
  }
  return result;
}

/** Pick the output filename for one walked recipe.  File-paths use basename
 *  as-is so the in-container layout matches what operators wrote.  URLs get
 *  slugified plus `.json`. */
export function recipeFilename(walkPath: string): string {
  if (walkPath.startsWith('http://') || walkPath.startsWith('https://')) {
    return `${slugify(walkPath)}.json`;
  }
  return basename(walkPath);
}

/** Lower a recipe to its shipped configuration: overlay, then demote. */
export function lowerToConfiguration(
  recipe: Recipe,
  overlay: Partial<Recipe> | undefined,
): Recipe {
  return demoteMcpSource(applyOverlay(recipe, overlay));
}
