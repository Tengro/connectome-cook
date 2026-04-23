/**
 * Tests for the overlay generator. Uses bun:test.
 *
 * Coverage:
 *   1. Triumvirate example — relative paths happen to resolve under the
 *      assumed in-container CWD (/app), so no overlay needed.  Empty Map.
 *   2. Synthetic pip-editable source — overlay rewrites command to the
 *      venv binary (regardless of where args point).
 *   3. Synthetic recipe with absolute args[0] outside the source's
 *      inContainerPath — overlay rewrites args[0].
 *   4. Synthetic recipe with `command: "npx"` — no overlay.
 */

import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { generateOverlays } from './overlay.js';
import { walkRecipe } from '../walker.js';
import { detectSources } from '../source-detector.js';
import { collectEnvVars } from '../env-collector.js';
import type {
  BuildOptions,
  GeneratorInput,
  McpSource,
  WalkResult,
} from '../types.js';
import type { Recipe } from '../vendor/recipe.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const TRIUMVIRATE = resolve(
  HERE,
  '..',
  '..',
  'examples',
  'triumvirate',
  'recipes',
  'triumvirate.json',
);

function makeOptions(overrides: Partial<BuildOptions> = {}): BuildOptions {
  return {
    outDir: '/tmp/cook-out',
    noPrompts: true,
    strict: false,
    pinRefs: false,
    ...overrides,
  };
}

describe('generateOverlays — triumvirate example', () => {
  test('returns an empty map (relative paths resolve under /app)', async () => {
    const walks = await walkRecipe(TRIUMVIRATE);
    const sources = detectSources(walks, { strict: false });
    const envVars = collectEnvVars(walks);

    const overlays = generateOverlays({
      walks,
      sources,
      envVars,
      options: makeOptions(),
    });

    // None of the example recipes need an overlay: clerk and miner both
    // reference `../zulip_mcp/build/index.js`, which resolves to
    // `/zulip_mcp/build/index.js` from the conductor's CWD `/app` — and
    // that's exactly where the source ends up.  The reviewer has no
    // mcpServers; the parent triumvirate.json has none either.
    expect(overlays.size).toBe(0);
  });
});

describe('generateOverlays — pip-editable rewrites command to venv binary', () => {
  test('always emits an overlay even if args path is fine', () => {
    const recipePath = '/synthetic/pipy/recipe.json';
    const recipe: Recipe = {
      name: 'pipy-svc',
      agent: { systemPrompt: 'p' },
      mcpServers: {
        pipy: {
          command: 'python3',
          args: ['-m', 'pipy_svc'],
          source: {
            url: 'https://example.com/pipy.git',
            install: 'pip-editable',
          },
        },
      },
    };

    const walk: WalkResult = { path: recipePath, recipe };
    const sources = detectSources([walk], { strict: false });
    expect(sources).toHaveLength(1);
    expect(sources[0]!.install).toEqual({ kind: 'pip-editable' });
    expect(sources[0]!.inContainerPath).toBe('/pipy');

    const overlays = generateOverlays({
      walks: [walk],
      sources,
      envVars: [],
      options: makeOptions(),
    });

    expect(overlays.size).toBe(1);
    const overlay = overlays.get(recipePath)!;
    expect(overlay).toBeDefined();
    expect(overlay.mcpServers).toEqual({
      pipy: {
        command: '/pipy/.venv/bin/python3',
      },
    });
  });

  test('does not double-rewrite when command already points at the venv', () => {
    const recipePath = '/synthetic/already/recipe.json';
    const recipe: Recipe = {
      name: 'already-correct',
      agent: { systemPrompt: 'p' },
      mcpServers: {
        srv: {
          command: '/foo/.venv/bin/python3',
          args: ['-m', 'foo'],
          source: {
            url: 'https://example.com/foo.git',
            install: 'pip-editable',
            inContainer: { path: '/foo' },
          },
        },
      },
    };

    const walk: WalkResult = { path: recipePath, recipe };
    const sources = detectSources([walk], { strict: false });

    const overlays = generateOverlays({
      walks: [walk],
      sources,
      envVars: [],
      options: makeOptions(),
    });

    expect(overlays.size).toBe(0);
  });
});

describe('generateOverlays — args path rewrites for non-matching layout', () => {
  test('absolute args[0] outside inContainerPath gets rewritten', () => {
    const recipePath = '/synthetic/abs/recipe.json';
    const recipe: Recipe = {
      name: 'abs-mismatch',
      agent: { systemPrompt: 'p' },
      mcpServers: {
        thing: {
          command: 'node',
          // Operator wrote an absolute path; cook will install at /thing,
          // not /opt/wrong/thing.
          args: ['/opt/wrong/thing/build/index.js'],
          source: {
            url: 'https://example.com/thing.git',
            install: 'npm',
            inContainer: { path: '/thing' },
          },
        },
      },
    };

    const walk: WalkResult = { path: recipePath, recipe };
    const sources = detectSources([walk], { strict: false });
    expect(sources[0]!.inContainerPath).toBe('/thing');

    const overlays = generateOverlays({
      walks: [walk],
      sources,
      envVars: [],
      options: makeOptions(),
    });

    expect(overlays.size).toBe(1);
    const overlay = overlays.get(recipePath)!;
    expect(overlay.mcpServers).toEqual({
      thing: {
        args: ['/thing/build/index.js'],
      },
    });
  });

  test('relative args[0] that resolves wrong gets rewritten', () => {
    const recipePath = '/synthetic/relwrong/recipe.json';
    const recipe: Recipe = {
      name: 'rel-wrong',
      agent: { systemPrompt: 'p' },
      mcpServers: {
        thing: {
          command: 'node',
          // From CWD=/app, `./thing/build/index.js` resolves to
          // /app/thing/build/index.js — but cook installs at /thing.
          args: ['./thing/build/index.js'],
          source: {
            url: 'https://example.com/thing.git',
            install: 'npm',
          },
        },
      },
    };

    const walk: WalkResult = { path: recipePath, recipe };
    const sources = detectSources([walk], { strict: false });

    const overlays = generateOverlays({
      walks: [walk],
      sources,
      envVars: [],
      options: makeOptions(),
    });

    expect(overlays.size).toBe(1);
    const overlay = overlays.get(recipePath)!;
    expect(overlay.mcpServers).toEqual({
      thing: {
        args: ['/thing/build/index.js'],
      },
    });
  });
});

describe('generateOverlays — npx/uvx never get an overlay', () => {
  test('command="npx" yields no overlay even with weird args', () => {
    const recipePath = '/synthetic/npx/recipe.json';
    const recipe: Recipe = {
      name: 'npx-thing',
      agent: { systemPrompt: 'p' },
      mcpServers: {
        gitlab: {
          command: 'npx',
          args: ['-y', '@zereight/mcp-gitlab'],
        },
      },
    };

    const walk: WalkResult = { path: recipePath, recipe };
    const sources = detectSources([walk], { strict: false });

    // npx commands without a `source` block are skipped by source-detector,
    // so there's no source → no overlay candidate.
    expect(sources).toEqual([]);

    const overlays = generateOverlays({
      walks: [walk],
      sources,
      envVars: [],
      options: makeOptions(),
    });

    expect(overlays.size).toBe(0);
  });

  test('command="npx" with an explicit source still yields no overlay', () => {
    // Edge case: operator added a source block to an npx server (perhaps
    // by mistake or for build-time pre-cache).  Source-detector keeps the
    // source; overlay generator should still skip because runtime fetch
    // means args don't reference disk paths.
    const recipePath = '/synthetic/npx-src/recipe.json';
    const recipe: Recipe = {
      name: 'npx-with-source',
      agent: { systemPrompt: 'p' },
      mcpServers: {
        gitlab: {
          command: 'npx',
          args: ['-y', '@zereight/mcp-gitlab'],
          source: {
            url: 'https://github.com/zereight/mcp-gitlab.git',
            install: 'npm',
          },
        },
      },
    };

    const walk: WalkResult = { path: recipePath, recipe };
    const sources: McpSource[] = detectSources([walk], { strict: false });
    expect(sources).toHaveLength(1);

    const overlays = generateOverlays({
      walks: [walk],
      sources,
      envVars: [],
      options: makeOptions(),
    });

    expect(overlays.size).toBe(0);
  });
});

describe('generateOverlays — http/websocket transports skipped', () => {
  test('mcpServer with `url` but no `command` yields no overlay', () => {
    const recipePath = '/synthetic/http/recipe.json';
    const recipe: Recipe = {
      name: 'http-thing',
      agent: { systemPrompt: 'p' },
      mcpServers: {
        api: {
          url: 'http://localhost:8080/mcp',
          transport: 'websocket',
        },
      },
    };

    const walk: WalkResult = { path: recipePath, recipe };
    // source-detector emits a sibling-copy entry for any non-npx/uvx
    // server lacking a source block — including url-only (no-command)
    // entries.  The overlay generator must skip them anyway because
    // there's no command to rewrite.
    const sources = detectSources([walk], { strict: false });

    const overlays = generateOverlays({
      walks: [walk],
      sources,
      envVars: [],
      options: makeOptions(),
    });

    expect(overlays.size).toBe(0);
  });
});
