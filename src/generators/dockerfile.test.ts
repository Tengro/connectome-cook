/**
 * Tests for the Dockerfile generator. Uses bun:test.
 *
 * Coverage:
 *   1. Real triumvirate fixture: walker → source-detector → env-collector
 *      feeds the generator, then we assert structural invariants on the
 *      generated string.
 *   2. Synthetic input with one pip-editable source: ensures python3 is
 *      apt-installed in the runtime stage and the venv install lines
 *      appear in the builder stage.
 *   3. Synthetic input with one sibling-copy source: ensures the runtime
 *      stage gets a `COPY <siblingDir> <inContainerPath>` line and that
 *      no builder stage is emitted for it.
 */

import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { generateDockerfile } from './dockerfile.js';
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

const TRIUMVIRATE_PARENT = resolve(
  __dirname,
  '..',
  '..',
  'examples',
  'triumvirate',
  'recipes',
  'triumvirate.json',
);

function defaultOptions(overrides: Partial<BuildOptions> = {}): BuildOptions {
  return {
    outDir: '/tmp/cook-out',
    noPrompts: true,
    strict: false,
    pinRefs: false,
    ...overrides,
  };
}

describe('generateDockerfile — triumvirate fixture', () => {
  test('produces a structurally valid Dockerfile from the example recipes', async () => {
    const walks = await walkRecipe(TRIUMVIRATE_PARENT);
    const sources = detectSources(walks, { strict: true });
    const envVars = collectEnvVars(walks);

    const input: GeneratorInput = {
      walks,
      sources,
      envVars,
      options: defaultOptions(),
    };

    const dockerfile = generateDockerfile(input);

    // Header — required for BuildKit syntax extensions (secrets, etc.).
    expect(dockerfile.startsWith('# syntax=docker/dockerfile:1.7')).toBe(true);

    // Exactly one builder stage for zulip — sanitized URL basename.
    const builderMatches = dockerfile.match(/^FROM\s+\S+\s+AS\s+zulip-mcp-build/gm);
    expect(builderMatches).not.toBeNull();
    expect(builderMatches!.length).toBe(1);

    // ch-deps stage with bun install + CH_REPO_URL ARG.
    expect(dockerfile).toContain('AS ch-deps');
    expect(dockerfile).toContain('ARG CH_REPO_URL=');
    expect(dockerfile).toContain('bun install --frozen-lockfile');

    // Runtime stage COPY for zulip into /zulip_mcp.
    expect(dockerfile).toContain('COPY --from=zulip-mcp-build /build/zulip_mcp /zulip_mcp');

    // Required runtime-stage primitives.
    expect(dockerfile).toContain('USER bun');
    expect(dockerfile).toContain('ENTRYPOINT ["tini", "--"]');

    // CMD ends with the parent recipe basename.
    expect(dockerfile).toMatch(/CMD\s+\["bun",\s*"src\/index\.ts",\s*"recipes\/triumvirate\.json"\]/);

    // Node binary copy: triumvirate recipes spawn node + npx, so the
    // runtime stage must include the symlink-recreation dance.
    expect(dockerfile).toContain('/usr/local/bin/node');
    expect(dockerfile).toContain('npm-cli.js');

    // Workspace-mount derived persistent dirs.
    for (const dir of ['data', 'output', 'review-output', 'knowledge-requests', 'input']) {
      expect(dockerfile).toContain(dir);
    }
  });
});

describe('generateDockerfile — pip-editable source', () => {
  test('emits python3 apt install + venv build steps', () => {
    const recipe: Recipe = {
      name: 'pip-test',
      agent: { systemPrompt: 'p' },
      mcpServers: {
        pyserver: {
          command: 'python3',
          args: ['/some/python-thing/main.py'],
          source: {
            url: 'https://example.com/python-thing.git',
            install: 'pip-editable',
          },
        },
      },
    } as Recipe;
    const walks: WalkResult[] = [{ path: '/recipes/pip.json', recipe }];
    const source: McpSource = {
      key: 'https://example.com/python-thing@main',
      url: 'https://example.com/python-thing.git',
      ref: 'main',
      install: { kind: 'pip-editable' },
      inContainerPath: '/python-thing',
      refs: [{ recipePath: '/recipes/pip.json', mcpServerName: 'pyserver' }],
    };

    const input: GeneratorInput = {
      walks,
      sources: [source],
      envVars: [],
      options: defaultOptions(),
    };

    const dockerfile = generateDockerfile(input);

    // python3 must be in the runtime stage's apt install list.
    const runtimeApt = extractRuntimeAptLine(dockerfile);
    expect(runtimeApt).toContain('python3');

    // Builder stage must include the venv install dance.
    expect(dockerfile).toContain('python3 -m venv .venv');
    expect(dockerfile).toContain('.venv/bin/pip install --no-cache-dir -e .');

    // And a COPY into /python-thing in the runtime stage.
    expect(dockerfile).toContain('/build/python-thing /python-thing');
  });
});

describe('generateDockerfile — sibling-copy source', () => {
  test('emits a runtime-stage COPY without any builder stage', () => {
    const recipe: Recipe = {
      name: 'sibling-test',
      agent: { systemPrompt: 'p' },
      mcpServers: {
        local: {
          command: 'node',
          args: ['/local-thing/index.js'],
        },
      },
    } as Recipe;
    const walks: WalkResult[] = [{ path: '/recipes/sib.json', recipe }];
    const source: McpSource = {
      key: 'sibling:local',
      url: '',
      ref: '',
      install: { kind: 'sibling-copy', siblingDir: 'local-thing' },
      inContainerPath: '/local-thing',
      refs: [{ recipePath: '/recipes/sib.json', mcpServerName: 'local' }],
    };

    const input: GeneratorInput = {
      walks,
      sources: [source],
      envVars: [],
      options: defaultOptions(),
    };

    const dockerfile = generateDockerfile(input);

    // Runtime-stage COPY directly from build context.
    expect(dockerfile).toContain('COPY local-thing /local-thing');

    // No builder stage — `FROM ... AS local-build` should NOT appear.
    expect(dockerfile).not.toMatch(/^FROM\s+\S+\s+AS\s+local-build/m);
    expect(dockerfile).not.toContain('--from=local-build');
    // Sanity: ch-deps stage is always present though.
    expect(dockerfile).toContain('AS ch-deps');
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Pull out the apt-install line from the runtime stage so we can inspect
 *  package set without false matches in builder-stage apt blocks. */
function extractRuntimeAptLine(dockerfile: string): string {
  const lines = dockerfile.split('\n');
  let inRuntime = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^FROM\s+\S+\s+AS\s+runtime\b/.test(line)) {
      inRuntime = true;
      continue;
    }
    if (inRuntime && line.includes('apt-get install')) {
      return line;
    }
  }
  throw new Error('Could not find runtime-stage apt-get install line in:\n' + dockerfile);
}
