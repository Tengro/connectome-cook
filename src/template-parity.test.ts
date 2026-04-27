/**
 * Parity test: cook's `renderTemplate` MUST match connectome-host's
 * `substituteEnvVars` for every input that doesn't trigger conhost's
 * throw-on-missing path.
 *
 * Why this matters: operators write `${VAR}` once in their recipe, then
 * cook renders the template at build time AND conhost substitutes at
 * runtime (for fields not in `skipKeys`).  If the two diverge,
 * `${VAR:-default}` semantics or escape semantics could silently differ
 * between the artifacts cook ships and the recipe conhost loads.
 *
 * The reference implementation below is a faithful local copy of conhost's
 * `substituteEnvVars` core (forking-knowledge-miner/src/recipe.ts).
 * Two divergence points relative to renderTemplate:
 *   1. conhost throws on truly-missing `${VAR}` (no default); renderTemplate
 *      reports them as missing and emits empty.  We test substitution
 *      behavior only — error semantics differ by design (cook continues +
 *      warns; conhost fails fast) and aren't part of the parity contract.
 *   2. conhost reads from process.env directly; renderTemplate reads from a
 *      values bag.  Tests below pass identical inputs to both.
 *
 * If you change the regex or substitution rule in template.ts, update the
 * REFERENCE_REGEX and reference body below to match.  CI catches drift.
 */

import { describe, expect, test } from 'bun:test';
import { renderTemplate } from './template.js';

/** Byte-for-byte copy of conhost's substituteEnvVars regex, used both as
 *  reference for the parity check and as a static check that template.ts
 *  hasn't drifted on the regex itself. */
const REFERENCE_REGEX = /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/** Faithful core of conhost's substituteEnvVars (string-only branch).  We
 *  drop the throw-on-missing path (returns empty + records missing,
 *  matching renderTemplate's contract for the parity comparison). */
function referenceSubstitute(template: string, values: Record<string, string>): string {
  return template.replace(
    REFERENCE_REGEX,
    (match, name: string | undefined, defaultValue: string | undefined) => {
      if (match === '$$') return '$';
      const n = name!;
      const v = values[n];
      if (defaultValue !== undefined) {
        return v !== undefined && v !== '' ? v : defaultValue;
      }
      // ${VAR} — required.  Conhost throws here; for parity we mirror
      // renderTemplate's "empty when missing" so we can compare strings.
      if (v === undefined || v === '') return '';
      return v;
    },
  );
}

/** Ensure the regex used by cook's template.ts has the same source as the
 *  one captured here (and therefore the one in conhost). */
test('regex source matches conhost reference', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const body = fs.readFileSync(path.join(here, 'template.ts'), 'utf-8');
  // Look for the exact regex literal in the source.
  expect(body).toContain('/\\$\\$|\\$\\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\\}/g');
});

interface Case {
  name: string;
  template: string;
  values: Record<string, string>;
}

const CASES: Case[] = [
  { name: 'plain literal', template: 'no vars here', values: {} },
  { name: 'simple ${VAR}', template: 'hello ${NAME}', values: { NAME: 'world' } },
  { name: 'unset ${VAR}', template: 'hello ${NAME}', values: {} },
  { name: 'empty-string ${VAR}', template: 'hello ${NAME}', values: { NAME: '' } },
  { name: 'default fallback (unset)', template: '${PORT:-8080}', values: {} },
  { name: 'default fallback (empty)', template: '${PORT:-8080}', values: { PORT: '' } },
  { name: 'default overridden by value', template: '${PORT:-8080}', values: { PORT: '9000' } },
  { name: 'empty default', template: '${X:-}', values: {} },
  { name: 'default with URL-shaped content', template: '${URL:-http://localhost:8080/path}', values: {} },
  { name: '$$ escape', template: 'a $$ b', values: {} },
  { name: '$${VAR} escape produces literal ${VAR}', template: 'use $${HOME}', values: { HOME: '/u' } },
  { name: 'shell-style $VAR untouched', template: 'echo $HOME', values: { HOME: '/u' } },
  { name: 'lone trailing $', template: 'cost is $', values: {} },
  { name: 'invalid name with spaces', template: '${has spaces}', values: {} },
  { name: 'invalid name starting with digit', template: '${1ABC}', values: {} },
  { name: 'underscore-prefixed name', template: '${_PRIVATE}', values: { _PRIVATE: 'x' } },
  { name: 'multiple vars, mixed', template: '${A}/${B:-fb}/${C}', values: { A: 'one' } },
  { name: 'repeated same var', template: '${X} ${X} ${X}', values: { X: 'q' } },
  { name: 'adjacent vars', template: '${A}${B}', values: { A: '1', B: '2' } },
  { name: 'var inside text', template: 'before${A}after', values: { A: 'mid' } },
  { name: 'JSON-shaped template body', template: '{"k":"${V:-fb}","x":"$$"}', values: {} },
  { name: 'PHP-shaped template body', template: '$wgServer = "${URL}";', values: { URL: 'http://x' } },
];

describe('renderTemplate ↔ substituteEnvVars parity', () => {
  for (const c of CASES) {
    test(c.name, () => {
      const cookOut = renderTemplate(c.template, c.values).rendered;
      const refOut = referenceSubstitute(c.template, c.values);
      expect(cookOut).toBe(refOut);
    });
  }
});
