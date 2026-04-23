/**
 * Tests for the `.env.example` generator.
 *
 * Coverage:
 *   1. Diff-test against the triumvirate example: assert structural content
 *      (ANTHROPIC_API_KEY, GITLAB_TOKEN, GITLAB_API_URL all present;
 *      Required heading present; UNIX newlines only).
 *   2. Synthetic input with a source that has `authSecret: GITLAB_TOKEN`:
 *      assert a comment mentioning BuildKit secrets appears near the secret.
 *   3. Synthetic input with no env vars: assert ANTHROPIC_API_KEY still
 *      appears (it's hardcoded for membrane).
 */

import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { generateEnv } from './env.js';
import { collectEnvVars } from '../env-collector.js';
import { detectSources } from '../source-detector.js';
import { loadRecipeRaw } from '../vendor/recipe.js';
import type {
  BuildOptions,
  EnvVar,
  GeneratorInput,
  McpSource,
  WalkResult,
} from '../types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RECIPES_DIR = resolve(HERE, '..', '..', 'examples', 'triumvirate', 'recipes');

const DEFAULT_OPTIONS: BuildOptions = {
  outDir: '/tmp/cook-test',
  noPrompts: true,
  strict: false,
  pinRefs: false,
};

async function loadWalk(name: string): Promise<WalkResult> {
  const path = resolve(RECIPES_DIR, `${name}.json`);
  const recipe = await loadRecipeRaw(path);
  return { path, recipe };
}

describe('generateEnv — triumvirate example', () => {
  test('output contains ANTHROPIC_API_KEY, GITLAB_TOKEN, GITLAB_API_URL', async () => {
    const walks = await Promise.all([
      loadWalk('triumvirate'),
      loadWalk('knowledge-miner'),
      loadWalk('knowledge-reviewer'),
      loadWalk('clerk'),
    ]);
    const sources = detectSources(walks, { strict: false });
    const envVars = collectEnvVars(walks);

    const input: GeneratorInput = {
      walks,
      sources,
      envVars,
      options: DEFAULT_OPTIONS,
    };
    const out = generateEnv(input);

    // Uncommented ANTHROPIC_API_KEY assignment somewhere in the output.
    expect(out).toMatch(/^ANTHROPIC_API_KEY=/m);
    // GITLAB_TOKEN and GITLAB_API_URL each present as `KEY=` lines.
    expect(out).toMatch(/^GITLAB_TOKEN=/m);
    expect(out).toMatch(/^GITLAB_API_URL=/m);
  });

  test('output contains a Required-flavored section heading', async () => {
    const walks = await Promise.all([loadWalk('triumvirate')]);
    const input: GeneratorInput = {
      walks,
      sources: detectSources(walks, { strict: false }),
      envVars: collectEnvVars(walks),
      options: DEFAULT_OPTIONS,
    };
    const out = generateEnv(input);

    // Section heading: `# --- Required ---` with optional trailing dashes.
    expect(out).toMatch(/# --- Required( -+)?( ---)?/);
  });

  test('uses UNIX line endings only — no CRLF anywhere', async () => {
    const walks = await Promise.all([
      loadWalk('triumvirate'),
      loadWalk('knowledge-miner'),
    ]);
    const input: GeneratorInput = {
      walks,
      sources: detectSources(walks, { strict: false }),
      envVars: collectEnvVars(walks),
      options: DEFAULT_OPTIONS,
    };
    const out = generateEnv(input);
    expect(out).not.toContain('\r');
  });
});

describe('generateEnv — build-time secrets', () => {
  test('source.authSecret produces a BuildKit-secret comment near the var', () => {
    const walks: WalkResult[] = [
      {
        path: '/r/parent.json',
        recipe: { name: 'with-secret-source', agent: { systemPrompt: 'p' } },
      },
    ];
    const sources: McpSource[] = [
      {
        key: 'https://internal.example.com/private@main',
        url: 'https://internal.example.com/private.git',
        ref: 'main',
        install: { kind: 'npm' },
        authSecret: 'GITLAB_TOKEN',
        inContainerPath: '/private',
        refs: [{ recipePath: '/r/parent.json', mcpServerName: 'private' }],
      },
    ];
    const envVars: EnvVar[] = [];
    const input: GeneratorInput = {
      walks,
      sources,
      envVars,
      options: DEFAULT_OPTIONS,
    };

    const out = generateEnv(input);

    // The secret line itself.
    expect(out).toMatch(/^GITLAB_TOKEN=/m);
    // BuildKit secret comment in the same neighborhood as the var.
    // Find the index of the GITLAB_TOKEN= line and check the comment appears
    // in the preceding ~6 lines (the build-time secrets block we emit has
    // 3 comment lines directly above the assignment).
    const lines = out.split('\n');
    const tokenIdx = lines.findIndex((l) => l.startsWith('GITLAB_TOKEN='));
    expect(tokenIdx).toBeGreaterThan(0);
    const window = lines.slice(Math.max(0, tokenIdx - 6), tokenIdx).join('\n');
    expect(window).toMatch(/docker build --secret/);
    expect(window).toMatch(/id=GITLAB_TOKEN/);
  });
});

describe('generateEnv — no env vars at all', () => {
  test('still emits ANTHROPIC_API_KEY in the Required section', () => {
    const walks: WalkResult[] = [
      {
        path: '/r/empty.json',
        recipe: { name: 'no-vars', agent: { systemPrompt: 'just text' } },
      },
    ];
    const input: GeneratorInput = {
      walks,
      sources: [],
      envVars: [],
      options: DEFAULT_OPTIONS,
    };

    const out = generateEnv(input);

    expect(out).toMatch(/^ANTHROPIC_API_KEY=/m);
    expect(out).toMatch(/# --- Required/);
    expect(out).not.toContain('\r');
  });
});

describe('generateEnv — optional vars are commented out', () => {
  test('a recipe-referenced MODEL var lands in Optional, commented out', () => {
    const walks: WalkResult[] = [
      {
        path: '/r/model.json',
        recipe: {
          name: 'optional-model',
          agent: { systemPrompt: 'uses ${MODEL}' },
        },
      },
    ];
    const envVars: EnvVar[] = [
      {
        name: 'MODEL',
        usedIn: [{ recipePath: '/r/model.json', jsonPath: 'agent.systemPrompt' }],
      },
    ];
    const input: GeneratorInput = {
      walks,
      sources: [],
      envVars,
      options: DEFAULT_OPTIONS,
    };

    const out = generateEnv(input);

    // Should be commented out, not assigned uncommented.
    expect(out).toMatch(/^# MODEL=/m);
    expect(out).not.toMatch(/^MODEL=/m);
    // Optional section header should also exist.
    expect(out).toMatch(/# --- Optional/);
  });
});
