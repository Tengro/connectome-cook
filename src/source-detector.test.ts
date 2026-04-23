/**
 * Tests for source-detector. Uses bun:test.
 *
 * Loads the three triumvirate child recipes via the vendored loadRecipeRaw
 * (we don't import the walker — it may not exist yet; this file
 * constructs WalkResult objects manually).
 */

import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { detectSources } from './source-detector.js';
import { loadRecipeRaw, type Recipe } from './vendor/recipe.js';
import type { WalkResult } from './types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RECIPES_DIR = resolve(HERE, '..', 'examples', 'triumvirate', 'recipes');

async function loadWalk(name: string): Promise<WalkResult> {
  const path = resolve(RECIPES_DIR, `${name}.json`);
  const recipe = await loadRecipeRaw(path);
  return { path, recipe };
}

describe('detectSources — triumvirate fixtures', () => {
  test('produces a single deduplicated zulip source with two refs', async () => {
    const walks = await Promise.all([
      loadWalk('clerk'),
      loadWalk('knowledge-miner'),
      loadWalk('knowledge-reviewer'),
    ]);

    const sources = detectSources(walks, { strict: true });

    expect(sources).toHaveLength(1);
    const zulip = sources[0]!;

    expect(zulip.url).toBe('https://github.com/antra-tess/zulip_mcp.git');
    expect(zulip.ref).toBe('main');
    expect(zulip.key).toBe('https://github.com/antra-tess/zulip_mcp@main');
    expect(zulip.install).toEqual({ kind: 'npm' });
    expect(zulip.inContainerPath).toBe('/zulip_mcp');
    expect(zulip.refs).toHaveLength(2);

    // Both clerk and miner reference the source under the server name "zulip".
    const recipeNames = zulip.refs.map((r) => r.recipePath.split('/').pop()).sort();
    expect(recipeNames).toEqual(['clerk.json', 'knowledge-miner.json']);
    for (const ref of zulip.refs) {
      expect(ref.mcpServerName).toBe('zulip');
    }
  });

  test('skips mcpServers with command="npx" (miner.gitlab) and contributes nothing for the reviewer', async () => {
    // Reviewer has no mcpServers → should add nothing on its own.
    const reviewerOnly = [await loadWalk('knowledge-reviewer')];
    expect(detectSources(reviewerOnly, { strict: true })).toEqual([]);

    // Miner has zulip + gitlab; gitlab is npx, so only zulip should appear.
    const minerOnly = [await loadWalk('knowledge-miner')];
    const minerSources = detectSources(minerOnly, { strict: true });
    expect(minerSources).toHaveLength(1);
    expect(minerSources[0]!.refs.map((r) => r.mcpServerName)).toEqual(['zulip']);
  });
});

describe('detectSources — missing source fallback', () => {
  /** Synthetic recipe whose only mcpServer lacks both `source` and an
   *  npx/uvx command. Triggers the unresolved code path. */
  function syntheticRecipe(): Recipe {
    return {
      name: 'synthetic-broken',
      agent: { systemPrompt: 'placeholder' },
      mcpServers: {
        'mystery-server': {
          command: 'node',
          args: ['./does-not-exist.js'],
        },
      },
    } as Recipe;
  }

  test('strict mode throws an error naming the recipe path + server name', () => {
    const walk: WalkResult = {
      path: '/synthetic/path/to/recipe.json',
      recipe: syntheticRecipe(),
    };

    expect(() => detectSources([walk], { strict: true })).toThrow();

    // Verify the message names the recipe and server.
    let captured: Error | null = null;
    try {
      detectSources([walk], { strict: true });
    } catch (err) {
      captured = err as Error;
    }
    expect(captured).not.toBeNull();
    expect(captured!.message).toContain('/synthetic/path/to/recipe.json');
    expect(captured!.message).toContain('mystery-server');
  });

  test('non-strict mode produces one sibling-copy entry with the right shape', () => {
    const walk: WalkResult = {
      path: '/synthetic/path/to/recipe.json',
      recipe: syntheticRecipe(),
    };

    const sources = detectSources([walk], { strict: false });
    expect(sources).toHaveLength(1);
    const sibling = sources[0]!;

    expect(sibling.key).toBe('sibling:mystery-server');
    expect(sibling.install).toEqual({
      kind: 'sibling-copy',
      siblingDir: 'mystery-server',
    });
    expect(sibling.inContainerPath).toBe('/mystery-server');
    expect(sibling.url).toBe('');
    expect(sibling.ref).toBe('');
    expect(sibling.refs).toHaveLength(1);
    expect(sibling.refs[0]).toEqual({
      recipePath: '/synthetic/path/to/recipe.json',
      mcpServerName: 'mystery-server',
    });
  });

  test('strict mode aggregates multiple unresolved entries into a single error', () => {
    const walk: WalkResult = {
      path: '/synthetic/multi.json',
      recipe: {
        name: 'multi-broken',
        agent: { systemPrompt: 'p' },
        mcpServers: {
          'first-broken': { command: 'node', args: [] },
          'second-broken': { command: 'python3', args: [] },
        },
      } as Recipe,
    };

    let captured: Error | null = null;
    try {
      detectSources([walk], { strict: true });
    } catch (err) {
      captured = err as Error;
    }
    expect(captured).not.toBeNull();
    expect(captured!.message).toContain('first-broken');
    expect(captured!.message).toContain('second-broken');
  });
});

describe('detectSources — URL normalization', () => {
  test('dedups across `.git` suffix and trailing slash variants', () => {
    const walks: WalkResult[] = [
      {
        path: '/r/a.json',
        recipe: {
          name: 'a',
          agent: { systemPrompt: 'p' },
          mcpServers: {
            srv: {
              command: 'node',
              args: [],
              source: { url: 'https://github.com/x/y.git', install: 'npm' },
            },
          },
        } as Recipe,
      },
      {
        path: '/r/b.json',
        recipe: {
          name: 'b',
          agent: { systemPrompt: 'p' },
          mcpServers: {
            srv: {
              command: 'node',
              args: [],
              source: { url: 'https://github.com/x/y/', install: 'npm' },
            },
          },
        } as Recipe,
      },
      {
        path: '/r/c.json',
        recipe: {
          name: 'c',
          agent: { systemPrompt: 'p' },
          mcpServers: {
            srv: {
              command: 'node',
              args: [],
              source: { url: 'https://github.com/x/y', install: 'npm' },
            },
          },
        } as Recipe,
      },
    ];

    const sources = detectSources(walks, { strict: true });
    expect(sources).toHaveLength(1);
    expect(sources[0]!.refs).toHaveLength(3);
    // First write wins on URL.
    expect(sources[0]!.url).toBe('https://github.com/x/y.git');
  });
});

describe('detectSources — install pattern mapping', () => {
  test('maps `pip-editable`, custom-object, and undefined install fields', () => {
    const walks: WalkResult[] = [
      {
        path: '/r/pip.json',
        recipe: {
          name: 'pip',
          agent: { systemPrompt: 'p' },
          mcpServers: {
            srv: {
              command: 'python3',
              args: [],
              source: {
                url: 'https://example.com/pip-thing.git',
                install: 'pip-editable',
              },
            },
          },
        } as Recipe,
      },
      {
        path: '/r/custom.json',
        recipe: {
          name: 'custom',
          agent: { systemPrompt: 'p' },
          mcpServers: {
            srv: {
              command: 'node',
              args: [],
              source: {
                url: 'https://example.com/custom-thing.git',
                install: { run: 'make build', runtime: 'node' },
              },
            },
          },
        } as Recipe,
      },
      {
        path: '/r/none.json',
        recipe: {
          name: 'none',
          agent: { systemPrompt: 'p' },
          mcpServers: {
            srv: {
              command: 'node',
              args: [],
              source: {
                url: 'https://example.com/no-install.git',
              },
            },
          },
        } as Recipe,
      },
    ];

    const sources = detectSources(walks, { strict: true });
    expect(sources).toHaveLength(3);

    const byUrl = new Map(sources.map((s) => [s.url, s]));
    expect(byUrl.get('https://example.com/pip-thing.git')!.install).toEqual({
      kind: 'pip-editable',
    });
    expect(byUrl.get('https://example.com/custom-thing.git')!.install).toEqual({
      kind: 'custom',
      run: 'make build',
      runtime: 'node',
    });
    expect(byUrl.get('https://example.com/no-install.git')!.install).toEqual({
      kind: 'custom',
      run: '',
      runtime: 'custom',
    });
  });

  test('honors source.inContainer.path when supplied', () => {
    const walks: WalkResult[] = [
      {
        path: '/r/explicit.json',
        recipe: {
          name: 'e',
          agent: { systemPrompt: 'p' },
          mcpServers: {
            srv: {
              command: 'node',
              args: [],
              source: {
                url: 'https://example.com/x.git',
                install: 'npm',
                inContainer: { path: '/opt/custom-location' },
              },
            },
          },
        } as Recipe,
      },
    ];

    const sources = detectSources(walks, { strict: true });
    expect(sources).toHaveLength(1);
    expect(sources[0]!.inContainerPath).toBe('/opt/custom-location');
  });

  test('preserves authSecret and sslBypass when supplied', () => {
    const walks: WalkResult[] = [
      {
        path: '/r/auth.json',
        recipe: {
          name: 'a',
          agent: { systemPrompt: 'p' },
          mcpServers: {
            srv: {
              command: 'node',
              args: [],
              source: {
                url: 'https://internal.example.com/private.git',
                install: 'npm',
                authSecret: 'INTERNAL_GIT_TOKEN',
                sslBypass: true,
              },
            },
          },
        } as Recipe,
      },
    ];

    const sources = detectSources(walks, { strict: true });
    expect(sources).toHaveLength(1);
    expect(sources[0]!.authSecret).toBe('INTERNAL_GIT_TOKEN');
    expect(sources[0]!.sslBypass).toBe(true);
  });
});

describe('detectSources — uvx is also skipped', () => {
  test('command="uvx" is treated like npx', () => {
    const walks: WalkResult[] = [
      {
        path: '/r/uvx.json',
        recipe: {
          name: 'u',
          agent: { systemPrompt: 'p' },
          mcpServers: {
            'uvx-srv': { command: 'uvx', args: ['some-package'] },
          },
        } as Recipe,
      },
    ];

    expect(detectSources(walks, { strict: true })).toEqual([]);
    expect(detectSources(walks, { strict: false })).toEqual([]);
  });
});
