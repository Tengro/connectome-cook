/**
 * Template rendering for cook's `templateFiles` / `containerTemplateFiles`.
 *
 * The grammar (and the regex below) MUST stay in sync with connectome-host's
 * `substituteEnvVars` (forking-knowledge-miner/src/recipe.ts) — operators
 * write the same `${VAR}` shapes in their recipes and expect identical
 * behavior at cook-render time and at agent-runtime substitution.  The
 * parity test (`template-parity.test.ts`) asserts this invariant.
 *
 * Grammar:
 *   `${VAR}`              — required; missing-or-empty → empty + report missing
 *   `${VAR:-default}`     — optional; missing-or-empty → default
 *   `$$`                  — literal `$` (so `$${VAR}` renders as `${VAR}`)
 *
 * Anything else starting with `$` (e.g. `$VAR` shell-style) is left alone —
 * cook does NOT do shell-style substitution.  This matches conhost.
 *
 * Returns `{ rendered, missing }`.  `missing` is sorted for deterministic
 * test output and warning messages.
 */

export interface RenderResult {
  rendered: string;
  /** Var names that were `${VAR}`-referenced (no default) AND had no
   *  value in `values`.  Sorted ascending.  Empty when fully resolved. */
  missing: string[];
}

const TEMPLATE_RE = /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

export function renderTemplate(
  template: string,
  values: Record<string, string>,
): RenderResult {
  const missing = new Set<string>();
  const rendered = template.replace(
    TEMPLATE_RE,
    (match, name: string | undefined, defaultValue: string | undefined) => {
      if (match === '$$') return '$';
      const n = name!;
      const v = values[n];
      // Treat empty string as unset — operators occasionally `export FOO=`
      // to clear a value and expect the default to apply.  Mirrors
      // resolveValue() in prompts.ts and substituteEnvVars in conhost.
      if (v !== undefined && v !== '') return v;
      if (defaultValue !== undefined) return defaultValue;
      missing.add(n);
      return '';
    },
  );
  return { rendered, missing: Array.from(missing).sort() };
}
