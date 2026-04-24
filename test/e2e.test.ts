/**
 * End-to-end test: run cook build against the in-repo Triumvirate example
 * and verify the generated artifacts are sane.
 *
 * Does NOT run `docker compose build` itself — that's a slow + network-heavy
 * step we'd rather leave for a manual ops smoke (see README §Verification).
 * But it asserts the artifacts are well-formed enough that docker WILL
 * accept them: Dockerfile parses to multi-stage, compose YAML round-trips,
 * recipes re-load through cook's own walker.
 */

import { describe, expect, test, beforeAll } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { walkRecipe } from '../src/walker.js';

const REPO_ROOT = resolve(import.meta.dir, '..');
const EXAMPLE_RECIPE = join(REPO_ROOT, 'examples/triumvirate/recipes/triumvirate.json');

let outDir: string;

beforeAll(() => {
  outDir = mkdtempSync(join(tmpdir(), 'cook-e2e-'));
  // Run cook build via the same bun process that's running the tests.
  const result = spawnSync(
    'bun',
    [join(REPO_ROOT, 'bin/cook'), 'build', EXAMPLE_RECIPE, '--out', outDir, '--no-prompts'],
    { encoding: 'utf-8', cwd: REPO_ROOT },
  );
  if (result.status !== 0) {
    throw new Error(
      `cook build failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`,
    );
  }
});

describe('cook build against the Triumvirate example', () => {
  test('writes all expected top-level files', () => {
    expect(existsSync(join(outDir, 'Dockerfile'))).toBe(true);
    expect(existsSync(join(outDir, 'docker-compose.yml'))).toBe(true);
    expect(existsSync(join(outDir, '.env.example'))).toBe(true);
    expect(existsSync(join(outDir, 'README.md'))).toBe(true);
    expect(existsSync(join(outDir, 'entrypoint.sh'))).toBe(true);
    // No .env because --no-prompts and ANTHROPIC_API_KEY isn't in test env.
    expect(existsSync(join(outDir, '.env'))).toBe(false);
    // No .zuliprc either: under --no-prompts, the credential file is
    // skipped when ZULIP_EMAIL/KEY/SITE aren't provided.  Operator drops
    // their own.  (Setting the env vars would make cook synthesize one.)
    expect(existsSync(join(outDir, '.zuliprc'))).toBe(false);
  });

  test('writes one recipe per walked entry', () => {
    expect(existsSync(join(outDir, 'recipes/triumvirate.json'))).toBe(true);
    expect(existsSync(join(outDir, 'recipes/knowledge-miner.json'))).toBe(true);
    expect(existsSync(join(outDir, 'recipes/knowledge-reviewer.json'))).toBe(true);
    expect(existsSync(join(outDir, 'recipes/clerk.json'))).toBe(true);
  });

  test('Dockerfile is multi-stage with the expected stages', () => {
    const dockerfile = readFileSync(join(outDir, 'Dockerfile'), 'utf-8');
    expect(dockerfile).toStartWith('# syntax=docker/dockerfile:1.7');
    // Per-source builder stage for zulip
    expect(dockerfile).toMatch(/FROM node:[\d.]+-bookworm-slim AS zulip[a-z0-9-]*-build/);
    // ch-deps stage with the build arg
    expect(dockerfile).toMatch(/FROM oven\/bun:1-debian AS ch-deps/);
    expect(dockerfile).toMatch(/ARG CH_REPO_URL/);
    // Runtime stage
    expect(dockerfile).toMatch(/FROM oven\/bun:1-debian AS runtime/);
    // Cook entrypoint: runs as root, drops to bun via gosu (no USER directive).
    expect(dockerfile).toMatch(/COPY entrypoint\.sh \/usr\/local\/bin\/cook-entrypoint/);
    expect(dockerfile).toMatch(/ENTRYPOINT \["tini", "--", "\/usr\/local\/bin\/cook-entrypoint"\]/);
    expect(dockerfile).toMatch(/CMD \["bun", "src\/index\.ts", "recipes\/triumvirate\.json"\]/);
  });

  test('compose YAML round-trips through Bun.YAML', () => {
    const composeText = readFileSync(join(outDir, 'docker-compose.yml'), 'utf-8');
    // Use Bun's built-in YAML if available, else regex-check structure.
    type BunWithYAML = { YAML?: { parse(s: string): unknown } };
    const yaml = (Bun as unknown as BunWithYAML).YAML;
    if (yaml?.parse) {
      const parsed = yaml.parse(composeText) as Record<string, unknown>;
      expect(parsed.services).toBeDefined();
      const services = parsed.services as Record<string, Record<string, unknown>>;
      const serviceKeys = Object.keys(services);
      expect(serviceKeys).toHaveLength(1);
      const service = services[serviceKeys[0]!]!;
      expect(service.stdin_open).toBe(true);
      expect(service.tty).toBe(true);
      expect(service.image).toMatch(/knowledge-mining-triumvirate/);
    } else {
      // Fallback: structural regex checks.
      expect(composeText).toMatch(/services:/);
      expect(composeText).toMatch(/stdin_open: true/);
      expect(composeText).toMatch(/tty: true/);
    }
  });

  test('every generated recipe re-loads through walker', async () => {
    const walks = await walkRecipe(join(outDir, 'recipes/triumvirate.json'));
    expect(walks).toHaveLength(4);
    const names = walks.map((w) => w.recipe.name);
    expect(names).toContain('Knowledge Mining Triumvirate');
    expect(names).toContain('Knowledge Miner (generic Triumvirate example)');
    expect(names).toContain('Knowledge Reviewer');
    expect(names).toContain('Library Frontdesk');
  });

  test('.env.example lists ANTHROPIC_API_KEY + recipe vars', () => {
    const env = readFileSync(join(outDir, '.env.example'), 'utf-8');
    expect(env).toContain('ANTHROPIC_API_KEY=');
    expect(env).toContain('GITLAB_TOKEN=');
    expect(env).toContain('GITLAB_API_URL=');
  });

  test('README is data-driven with parent recipe name', () => {
    const readme = readFileSync(join(outDir, 'README.md'), 'utf-8');
    expect(readme).toStartWith('# Knowledge Mining Triumvirate — Dockerized');
    expect(readme).toContain('docker attach knowledge-mining-triumvirate');
  });
});

// Cleanup after all tests in this file (best-effort).
afterAll(() => {
  try { rmSync(outDir, { recursive: true, force: true }); } catch { /* noop */ }
});

// Bun's `afterAll` lives in `bun:test`; importing it lazily to avoid an
// extra import line at the top.
import { afterAll } from 'bun:test';
