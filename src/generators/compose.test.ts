/**
 * Tests for the compose generator. Uses bun:test.
 *
 * Three scenarios:
 *   1. Real triumvirate fixture — assert structural shape + expected mounts.
 *   2. Synthetic recipe with no workspace — assert no `volumes:` key.
 *   3. Synthetic recipe with an authSecret source — assert top-level
 *      `secrets:` block is emitted and the service references the secret.
 */

import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { generateCompose, slugify } from './compose.js';
import { walkRecipe } from '../walker.js';
import { detectSources } from '../source-detector.js';
import { collectEnvVars } from '../env-collector.js';
import { loadRecipeRaw, type Recipe } from '../vendor/recipe.js';
import type { BuildOptions, GeneratorInput, McpSource, WalkResult } from '../types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RECIPES_DIR = resolve(HERE, '..', '..', 'examples', 'triumvirate', 'recipes');

function defaultOptions(overrides: Partial<BuildOptions> = {}): BuildOptions {
  return {
    outDir: '/tmp/cook-out',
    noPrompts: true,
    strict: false,
    pinRefs: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helper: regex-based YAML key check (no js-yaml dep). For full structural
// parsing we lean on Bun.YAML.parse when available.
// ---------------------------------------------------------------------------

function tryParseYaml(text: string): unknown | null {
  const yaml = (Bun as unknown as { YAML?: { parse: (s: string) => unknown } }).YAML;
  if (yaml && typeof yaml.parse === 'function') {
    try {
      return yaml.parse(text);
    } catch {
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 1. Triumvirate fixture
// ---------------------------------------------------------------------------

describe('generateCompose — triumvirate fixture', () => {
  async function buildInput(): Promise<GeneratorInput> {
    const walks = await walkRecipe(resolve(RECIPES_DIR, 'triumvirate.json'));
    const sources = detectSources(walks, { strict: false });
    const envVars = collectEnvVars(walks);
    return { walks, sources, envVars, options: defaultOptions() };
  }

  test('emits a parseable document with services key', async () => {
    const out = generateCompose(await buildInput());
    expect(out).toContain('services:');

    const parsed = tryParseYaml(out);
    if (parsed !== null) {
      expect(parsed).toMatchObject({ services: expect.any(Object) });
    }
  });

  test('services map has exactly one service', async () => {
    const out = generateCompose(await buildInput());
    const parsed = tryParseYaml(out);
    if (parsed !== null) {
      const services = (parsed as { services: Record<string, unknown> }).services;
      expect(Object.keys(services)).toHaveLength(1);
    } else {
      // Fallback: count two-space-indent keys directly under `services:`.
      const lines = out.split('\n');
      const startIdx = lines.findIndex((l) => l === 'services:');
      let count = 0;
      for (let i = startIdx + 1; i < lines.length; i++) {
        const line = lines[i]!;
        if (/^[A-Za-z]/.test(line)) break; // next top-level key
        if (/^ {2}[a-zA-Z0-9_-]+:/.test(line)) count++;
      }
      expect(count).toBe(1);
    }
  });

  test('service has stdin_open + tty + stop_grace_period + env_file', async () => {
    const out = generateCompose(await buildInput());
    expect(out).toContain('stdin_open: true');
    expect(out).toContain('tty: true');
    expect(out).toContain('stop_grace_period: 30s');
    expect(out).toMatch(/env_file:\s*\n\s*-\s*\.env/);

    const parsed = tryParseYaml(out);
    if (parsed !== null) {
      const services = (parsed as { services: Record<string, Record<string, unknown>> })
        .services;
      const [svc] = Object.values(services);
      expect(svc!.stdin_open).toBe(true);
      expect(svc!.tty).toBe(true);
      expect(svc!.stop_grace_period).toBe('30s');
      expect(svc!.env_file).toEqual(['.env']);
    }
  });

  test('image and container_name match the slugified parent recipe name', async () => {
    const input = await buildInput();
    const expectedSlug = slugify(input.walks[0]!.recipe.name);

    const out = generateCompose(input);
    expect(out).toContain(`image: ${expectedSlug}:latest`);
    expect(out).toContain(`container_name: ${expectedSlug}`);
    // The triumvirate parent is "Knowledge Mining Triumvirate" → predictable slug.
    expect(expectedSlug).toBe('knowledge-mining-triumvirate');
  });

  test('volumes include the example mounts (data, output, review-output, knowledge-requests, input, .zuliprc)', async () => {
    const out = generateCompose(await buildInput());

    // The example uses these container paths.
    const expectedContainerPaths = [
      '/app/output',
      '/app/review-output',
      '/app/knowledge-requests',
      '/app/input',
      '/app/.zuliprc',
    ];
    for (const p of expectedContainerPaths) {
      expect(out).toContain(p);
    }

    // .zuliprc must be read-only.
    expect(out).toMatch(/\.zuliprc:\/app\/\.zuliprc:ro/);

    // input/ is read-only on the miner recipe.
    expect(out).toMatch(/\/app\/input:ro/);
  });

  test('build context is . and dockerfile is Dockerfile', async () => {
    const out = generateCompose(await buildInput());
    expect(out).toContain('context: .');
    expect(out).toContain('dockerfile: Dockerfile');
    expect(out).not.toContain('args:');
  });

  test('imageName option overrides the derived image name', async () => {
    const input = await buildInput();
    input.options.imageName = 'my-custom-image:v2';
    const out = generateCompose(input);
    expect(out).toContain('image: my-custom-image:v2');
  });
});

// ---------------------------------------------------------------------------
// 2. Recipe with no workspace mounts — no `volumes:` key under the service
// ---------------------------------------------------------------------------

describe('generateCompose — no workspace mounts', () => {
  test('emits no service-level volumes block', () => {
    const recipe: Recipe = {
      name: 'No Mounts Agent',
      agent: { systemPrompt: 'placeholder' },
    } as Recipe;

    const walk: WalkResult = { path: '/synthetic/no-mounts.json', recipe };
    const input: GeneratorInput = {
      walks: [walk],
      sources: [],
      envVars: [],
      options: defaultOptions(),
    };

    const out = generateCompose(input);

    // No "volumes:" key indented as a service field. Top-level "volumes:" we
    // never emit either, but the focused assertion is the per-service one.
    expect(out).not.toMatch(/^ {4}volumes:/m);

    // Sanity: the rest of the shape still renders.
    expect(out).toContain('services:');
    expect(out).toContain('  no-mounts-agent:');
    expect(out).toContain('image: no-mounts-agent:latest');
    expect(out).toContain('stdin_open: true');
    expect(out).toContain('stop_grace_period: 30s');
  });

  test('falls back to cook-app when slug ends up empty', () => {
    const recipe: Recipe = {
      name: '!!!---!!!',
      agent: { systemPrompt: 'placeholder' },
    } as Recipe;
    const walk: WalkResult = { path: '/synthetic/junk.json', recipe };
    const input: GeneratorInput = {
      walks: [walk],
      sources: [],
      envVars: [],
      options: defaultOptions(),
    };

    const out = generateCompose(input);
    expect(out).toContain('  cook-app:');
    expect(out).toContain('image: cook-app:latest');
    expect(out).toContain('container_name: cook-app');
  });
});

// ---------------------------------------------------------------------------
// 3. Source with authSecret → top-level secrets block emitted
// ---------------------------------------------------------------------------

describe('generateCompose — authSecret sources', () => {
  test('emits a top-level secrets: block referencing each secret', () => {
    const recipe: Recipe = {
      name: 'Secret Agent',
      agent: { systemPrompt: 'placeholder' },
    } as Recipe;

    const walk: WalkResult = { path: '/synthetic/secret-agent.json', recipe };
    const sources: McpSource[] = [
      {
        key: 'sample',
        url: 'https://internal.example.com/private.git',
        ref: 'main',
        install: { kind: 'npm' },
        authSecret: 'INTERNAL_GIT_TOKEN',
        inContainerPath: '/private',
        refs: [{ recipePath: '/synthetic/secret-agent.json', mcpServerName: 'private' }],
      },
    ];

    const input: GeneratorInput = {
      walks: [walk],
      sources,
      envVars: [],
      options: defaultOptions(),
    };

    const out = generateCompose(input);

    // Service-level reference.
    expect(out).toMatch(/secrets:\s*\n\s+- INTERNAL_GIT_TOKEN/);

    // Top-level block.
    expect(out).toMatch(/^secrets:\s*$/m);
    expect(out).toMatch(/^ {2}INTERNAL_GIT_TOKEN:\s*\n\s+file: \.\/INTERNAL_GIT_TOKEN/m);

    const parsed = tryParseYaml(out);
    if (parsed !== null) {
      const obj = parsed as { secrets?: Record<string, { file: string }> };
      expect(obj.secrets).toBeDefined();
      expect(obj.secrets!['INTERNAL_GIT_TOKEN']).toEqual({
        file: './INTERNAL_GIT_TOKEN',
      });
    }
  });

  test('does NOT emit a secrets block when no source has authSecret', () => {
    const recipe: Recipe = {
      name: 'Plain Agent',
      agent: { systemPrompt: 'placeholder' },
    } as Recipe;
    const walk: WalkResult = { path: '/synthetic/plain.json', recipe };
    const input: GeneratorInput = {
      walks: [walk],
      sources: [
        {
          key: 'sample',
          url: 'https://github.com/x/y.git',
          ref: 'main',
          install: { kind: 'npm' },
          inContainerPath: '/y',
          refs: [{ recipePath: '/synthetic/plain.json', mcpServerName: 'y' }],
        },
      ],
      envVars: [],
      options: defaultOptions(),
    };

    const out = generateCompose(input);
    // Only the service-level "secrets:" is forbidden too.
    expect(out).not.toContain('secrets:');
  });
});

// ---------------------------------------------------------------------------
// 4. slugify — unit coverage for edge cases
// ---------------------------------------------------------------------------

describe('slugify', () => {
  test.each([
    ['Knowledge Mining Triumvirate', 'knowledge-mining-triumvirate'],
    ['  Lots   of   Spaces  ', 'lots-of-spaces'],
    ['Already-Hyphenated', 'already-hyphenated'],
    ['Mixed_Case_Underscores', 'mixed-case-underscores'],
    ['Punctuation!?:.;', 'punctuation'],
    ['', 'cook-app'],
    ['---', 'cook-app'],
    ['ALLCAPS', 'allcaps'],
  ])('slugify(%j) → %j', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// 5. Credential file binds — declarative `credentialFiles` in a recipe
//    should produce one read-only file-bind per declared file.
// ---------------------------------------------------------------------------

describe('generateCompose — credentialFiles binds', () => {
  test('emits read-only file bind for each declared credential file', async () => {
    const path = resolve(RECIPES_DIR, 'clerk.json');
    const recipe = await loadRecipeRaw(path);
    const walk: WalkResult = { path, recipe };

    const out = generateCompose({
      walks: [walk],
      sources: [],
      envVars: [],
      options: defaultOptions(),
    });

    // The example clerk declares ./.zuliprc as a credential file.
    expect(out).toContain('./.zuliprc:/app/.zuliprc:ro');
  });
});
