/**
 * Environment-variable collector.
 *
 * Walks each WalkResult's recipe object tree, finds string values containing
 * `${VAR_NAME}` placeholders, and returns a deduplicated `EnvVar[]` so the
 * CLI can prompt the operator for missing values (or list them in
 * `.env.example`) BEFORE substitution happens.
 *
 * Why an object walk (not a JSON-stringify + regex sweep): we want a useful
 * `jsonPath` per match — e.g. `mcpServers.gitlab.env.GITLAB_TOKEN` —
 * so error messages and prompts can tell the operator exactly where each
 * variable is referenced.
 *
 * The placeholder pattern matches connectome-host's `substituteEnvVars`:
 *   /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g
 *
 * Multiple occurrences of the same `${VAR}` inside a single string value
 * collapse to one EnvVarUse for that path — recording the same path twice
 * adds no information.
 */

import type { EnvVar, EnvVarUse, WalkResult } from './types.js';

/** Pattern matching connectome-host's `substituteEnvVars`. */
const VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** A JS identifier that doesn't need bracket-quoting in a dotted path. */
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Format an object property key for inclusion in a dotted JSON path.
 *
 * Identifier-shaped keys get a leading dot (`foo.bar`); anything else gets
 * bracket-quoted (`foo["weird key"]`). Empty `parent` returns the key bare.
 */
function joinKey(parent: string, key: string): string {
  if (IDENT.test(key)) {
    return parent ? `${parent}.${key}` : key;
  }
  // Escape backslashes and double quotes for the bracket-quoted form.
  const escaped = key.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `${parent}["${escaped}"]`;
}

/** Format an array index for inclusion in a dotted JSON path. */
function joinIndex(parent: string, index: number): string {
  return `${parent}[${index}]`;
}

/**
 * Recursively walk `value` from `path`, invoking `onString` for every string
 * leaf with the leaf's full jsonPath.
 */
function walk(
  value: unknown,
  path: string,
  onString: (s: string, p: string) => void,
): void {
  if (typeof value === 'string') {
    onString(value, path);
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      walk(value[i], joinIndex(path, i), onString);
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      walk(child, joinKey(path, key), onString);
    }
  }
  // Numbers, booleans, null, undefined: no `${VAR}` possible — skip.
}

/**
 * Scan walker output for `${VAR}` placeholders.
 *
 * For each WalkResult, traverses the recipe object tree, collects every
 * `${VAR}` reference inside string leaves, and aggregates them across walks
 * into a deduplicated `EnvVar[]` sorted by `name` for stable output.
 */
export function collectEnvVars(walks: WalkResult[]): EnvVar[] {
  const byName = new Map<string, EnvVarUse[]>();

  for (const walk_ of walks) {
    walk(walk_.recipe, '', (s, p) => {
      // Reset lastIndex defensively — we share one regex across the run.
      VAR_PATTERN.lastIndex = 0;
      // Track which (var, path) pairs we've already recorded for this string,
      // so multiple occurrences of `${VAR}` in the same string only add one
      // EnvVarUse.
      const seenInString = new Set<string>();
      let match: RegExpExecArray | null;
      while ((match = VAR_PATTERN.exec(s)) !== null) {
        const name = match[1]!;
        if (seenInString.has(name)) continue;
        seenInString.add(name);

        let uses = byName.get(name);
        if (!uses) {
          uses = [];
          byName.set(name, uses);
        }
        uses.push({ recipePath: walk_.path, jsonPath: p });
      }
    });
  }

  const out: EnvVar[] = [];
  for (const [name, usedIn] of byName) {
    out.push({ name, usedIn });
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}
