/**
 * Unit tests for renderTemplate.  Covers the grammar contract:
 *   - ${VAR}              required substitution
 *   - ${VAR:-default}     fall-through default
 *   - $$                  literal $ escape
 *   - empty string treated as unset
 *   - non-matching $ patterns left alone
 *   - missing list returned sorted, deduped
 *
 * Parity against connectome-host's substituteEnvVars lives in
 * `template-parity.test.ts`.
 */

import { describe, expect, test } from 'bun:test';
import { renderTemplate } from './template.js';

describe('renderTemplate — basic substitution', () => {
  test('substitutes ${VAR} when present', () => {
    const r = renderTemplate('hello ${NAME}', { NAME: 'world' });
    expect(r.rendered).toBe('hello world');
    expect(r.missing).toEqual([]);
  });

  test('marks ${VAR} as missing when absent', () => {
    const r = renderTemplate('hello ${NAME}', {});
    expect(r.rendered).toBe('hello ');
    expect(r.missing).toEqual(['NAME']);
  });

  test('treats empty string as unset', () => {
    const r = renderTemplate('hello ${NAME}', { NAME: '' });
    expect(r.rendered).toBe('hello ');
    expect(r.missing).toEqual(['NAME']);
  });

  test('multiple references to same missing var dedupe', () => {
    const r = renderTemplate('${X} ${X} ${X}', {});
    expect(r.rendered).toBe('  ');
    expect(r.missing).toEqual(['X']);
  });

  test('missing list is sorted', () => {
    const r = renderTemplate('${ZETA} ${ALPHA} ${MIDDLE}', {});
    expect(r.missing).toEqual(['ALPHA', 'MIDDLE', 'ZETA']);
  });
});

describe('renderTemplate — defaults', () => {
  test('${VAR:-default} uses default when var unset', () => {
    const r = renderTemplate('${PORT:-8080}', {});
    expect(r.rendered).toBe('8080');
    expect(r.missing).toEqual([]);
  });

  test('${VAR:-default} uses default when var empty', () => {
    const r = renderTemplate('${PORT:-8080}', { PORT: '' });
    expect(r.rendered).toBe('8080');
    expect(r.missing).toEqual([]);
  });

  test('${VAR:-default} uses value when var set', () => {
    const r = renderTemplate('${PORT:-8080}', { PORT: '9090' });
    expect(r.rendered).toBe('9090');
  });

  test('default may be empty', () => {
    const r = renderTemplate('${X:-}', {});
    expect(r.rendered).toBe('');
    expect(r.missing).toEqual([]);
  });

  test('default may contain spaces and punctuation (no closing brace)', () => {
    const r = renderTemplate('${URL:-http://localhost:8080/path}', {});
    expect(r.rendered).toBe('http://localhost:8080/path');
  });
});

describe('renderTemplate — escape semantics', () => {
  test('$$ renders as literal $', () => {
    const r = renderTemplate('cost: $$5', { '5': 'nope' });
    expect(r.rendered).toBe('cost: $5');
  });

  test('$${VAR} renders as literal ${VAR} — no substitution', () => {
    const r = renderTemplate('write $${HOME} for the home dir', { HOME: '/u' });
    expect(r.rendered).toBe('write ${HOME} for the home dir');
    expect(r.missing).toEqual([]);
  });

  test('shell-style $VAR is left alone (no substitution)', () => {
    const r = renderTemplate('echo $HOME', { HOME: '/u' });
    expect(r.rendered).toBe('echo $HOME');
  });

  test('lone $ at end of string is left alone', () => {
    const r = renderTemplate('cost is $', {});
    expect(r.rendered).toBe('cost is $');
  });
});

describe('renderTemplate — edge cases', () => {
  test('empty template returns empty', () => {
    expect(renderTemplate('', {})).toEqual({ rendered: '', missing: [] });
  });

  test('template with no substitutions passes through verbatim', () => {
    const r = renderTemplate('the quick brown fox', { FOX: 'cat' });
    expect(r.rendered).toBe('the quick brown fox');
  });

  test('ignores ${invalid name with spaces}', () => {
    // Name doesn't match [A-Za-z_][A-Za-z0-9_]* — left alone.
    const r = renderTemplate('${has spaces}', {});
    expect(r.rendered).toBe('${has spaces}');
    expect(r.missing).toEqual([]);
  });

  test('ignores ${1NUMERIC} (starts with digit)', () => {
    const r = renderTemplate('${1ABC}', {});
    expect(r.rendered).toBe('${1ABC}');
  });

  test('mixed missing + present + default', () => {
    const r = renderTemplate('${A}/${B:-fallback}/${C}', { A: 'one' });
    expect(r.rendered).toBe('one/fallback/');
    expect(r.missing).toEqual(['C']);
  });

  test('underscore-prefixed names are valid', () => {
    const r = renderTemplate('${_PRIVATE}', { _PRIVATE: 'x' });
    expect(r.rendered).toBe('x');
  });
});
