/**
 * Recipe walker.
 *
 * Given the path (or URL) of a parent recipe, load it and traverse
 * `modules.fleet.children[].recipe` recursively, returning a flat list of
 * `{ path, recipe }` entries in declaration order (parent first, then each
 * child in the order it appears in `fleet.children`, depth-first).
 *
 * Path resolution:
 *   - `child.recipe` strings are resolved against the *parent* recipe's
 *     directory (NOT the process cwd). Absolute paths and `http(s)://` URLs
 *     pass through unchanged.
 *   - HTTP(S) parents with relative child paths fail with a clear error.
 *
 * Cycle safety:
 *   - Each entry is keyed by absolute resolved path (or URL string). If a
 *     cycle is encountered, the already-visited recipe is silently skipped.
 *
 * Pure async function — no side effects beyond reading files / fetching URLs
 * via `loadRecipeRaw`.
 */

import { dirname, isAbsolute, resolve } from 'node:path';
import { loadRecipeRaw, type Recipe, type RecipeFleetChild } from './vendor/recipe.js';
import type { WalkResult } from './types.js';

/** True if `s` looks like an `http://` or `https://` URL. */
function isUrl(s: string): boolean {
  return s.startsWith('http://') || s.startsWith('https://');
}

/**
 * Resolve a child `recipe` reference relative to its parent's location.
 *
 * @param childRef     The raw `child.recipe` string from the parent recipe.
 * @param parentLoc    The parent's `path` from its own WalkResult — either
 *                     an absolute filesystem path or an `http(s)://` URL.
 * @returns The resolved path/URL ready to feed back into `loadRecipeRaw`.
 * @throws  When a remote parent has a relative child path (no base dir).
 */
function resolveChildPath(childRef: string, parentLoc: string): string {
  // Absolute URL anywhere — always passes through.
  if (isUrl(childRef)) return childRef;

  // Parent is a URL: relative child paths can't be resolved.
  if (isUrl(parentLoc)) {
    throw new Error(
      `can't resolve relative child path against URL parent: ` +
      `child "${childRef}" referenced from "${parentLoc}"`,
    );
  }

  // Absolute filesystem path — pass through.
  if (isAbsolute(childRef)) return childRef;

  // Relative path — resolve against the parent recipe's directory.
  return resolve(dirname(parentLoc), childRef);
}

/** Normalize an input path to the canonical form we use as `WalkResult.path`
 *  and as the dedup key. URLs stay as-is; file paths are made absolute. */
function normalizeRoot(input: string): string {
  if (isUrl(input)) return input;
  return resolve(input);
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

    for (const child of getFleetChildren(recipe)) {
      const childLoc = resolveChildPath(child.recipe, loc);
      await visit(childLoc);
    }
  }

  await visit(normalizeRoot(rootPath));
  return results;
}
