/**
 * Recipe walker.
 *
 * Given the path (or URL) of a parent recipe, load it and traverse
 * `modules.fleet.children[].recipe` recursively, returning a flat list of
 * `{ path, recipe }` entries in declaration order (parent first, then each
 * child in the order it appears in `fleet.children`, depth-first).
 *
 * Path resolution: delegated to the vendored `resolveRecipeRelative`, which
 * matches connectome-host's runtime behaviour — relative children resolve
 * against the parent recipe's directory (file source) or URL base (URL
 * source). Absolute paths and `http(s)://` URLs pass through unchanged.
 *
 * Cycle safety: each entry is keyed by its resolved path/URL. If a cycle is
 * encountered, the already-visited recipe is silently skipped.
 *
 * Pure async function — no side effects beyond reading files / fetching URLs
 * via `loadRecipeRaw`.
 */

import { dirname, resolve } from 'node:path';
import {
  loadRecipeRaw,
  resolveRecipeRelative,
  type Recipe,
  type RecipeFleetChild,
  type RecipeSourceBase,
} from './vendor/recipe.js';
import type { WalkResult } from './types.js';

/** True if `s` looks like an `http://` or `https://` URL. */
function isUrl(s: string): boolean {
  return s.startsWith('http://') || s.startsWith('https://');
}

/** Build the source base for resolving children of a recipe loaded from `loc`. */
function sourceBaseFor(loc: string): RecipeSourceBase {
  return isUrl(loc) ? { kind: 'url', base: loc } : { kind: 'file', dir: dirname(loc) };
}

/** Normalize an input path to the canonical form we use as `WalkResult.path`
 *  and as the dedup key. URLs stay as-is; file paths are made absolute. */
function normalizeRoot(input: string): string {
  return isUrl(input) ? input : resolve(input);
}

/** Extract the fleet children array from a recipe, or `[]` if there are none. */
function getFleetChildren(recipe: Recipe): RecipeFleetChild[] {
  const fleet = recipe.modules?.fleet;
  if (!fleet || typeof fleet !== 'object') return [];
  return fleet.children ?? [];
}

/**
 * Walk a recipe tree starting from `rootPath`.
 *
 * Returns a flat array `[parent, ...descendants]` in depth-first declaration
 * order, deduplicated by absolute resolved path. Cycles are handled by
 * skipping already-visited entries (no error, no infinite loop).
 */
export async function walkRecipe(rootPath: string): Promise<WalkResult[]> {
  const results: WalkResult[] = [];
  const visited = new Set<string>();

  async function visit(loc: string): Promise<void> {
    if (visited.has(loc)) return;
    visited.add(loc);

    const recipe = await loadRecipeRaw(loc);
    results.push({ path: loc, recipe });

    const base = sourceBaseFor(loc);
    for (const child of getFleetChildren(recipe)) {
      const childLoc = resolveRecipeRelative(child.recipe, base);
      await visit(childLoc);
    }
  }

  await visit(normalizeRoot(rootPath));
  return results;
}
