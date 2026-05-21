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

  test('services map has agent + sidecars (mediawiki + mariadb)', async () => {
    const out = generateCompose(await buildInput());
    const parsed = tryParseYaml(out);
    if (parsed !== null) {
      const services = (parsed as { services: Record<string, unknown> }).services;
      // Agent service + 2 sidecars from the example's services declaration.
      expect(Object.keys(services).sort()).toEqual([
        'knowledge-mining-triumvirate',
        'mariadb',
        'mediawiki',
      ]);
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
      expect(count).toBe(3); // agent + mediawiki + mariadb
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
// 2b. Workspace mount mode-conflict resolution — most-permissive wins
// ---------------------------------------------------------------------------

describe('generateCompose — workspace mount mode conflict', () => {
  test('promotes ro→rw when a later walker declares the same path read-write', () => {
    // Two recipes both mount /app/shared.  Reader is enumerated first,
    // writer second.  Previous policy (first-write-wins on mode) would
    // emit `:ro`, which is the bug that broke encyclopedist writing
    // wiki-updates on prod.  New policy: most-permissive wins.
    const reader: Recipe = {
      name: 'Reader',
      agent: { systemPrompt: 'placeholder' },
      modules: {
        workspace: {
          mounts: [{ name: 'shared', path: './shared', mode: 'read-only' }],
        },
      },
    } as Recipe;
    const writer: Recipe = {
      name: 'Writer',
      agent: { systemPrompt: 'placeholder' },
      modules: {
        workspace: {
          mounts: [{ name: 'shared', path: './shared', mode: 'read-write' }],
        },
      },
    } as Recipe;

    const input: GeneratorInput = {
      walks: [
        { path: '/synthetic/reader.json', recipe: reader },
        { path: '/synthetic/writer.json', recipe: writer },
      ],
      sources: [],
      envVars: [],
      options: defaultOptions(),
    };

    const out = generateCompose(input);

    // The bind must be RW so the writer's writes actually land.
    expect(out).toContain('- ./shared:/app/shared');
    expect(out).not.toMatch(/- \.\/shared:\/app\/shared:ro/);
  });

  test('keeps rw when the reader is enumerated second', () => {
    // Symmetric case: writer first, reader second.  Result is still RW.
    const writer: Recipe = {
      name: 'Writer',
      agent: { systemPrompt: 'placeholder' },
      modules: {
        workspace: {
          mounts: [{ name: 'shared', path: './shared', mode: 'read-write' }],
        },
      },
    } as Recipe;
    const reader: Recipe = {
      name: 'Reader',
      agent: { systemPrompt: 'placeholder' },
      modules: {
        workspace: {
          mounts: [{ name: 'shared', path: './shared', mode: 'read-only' }],
        },
      },
    } as Recipe;

    const input: GeneratorInput = {
      walks: [
        { path: '/synthetic/writer.json', recipe: writer },
        { path: '/synthetic/reader.json', recipe: reader },
      ],
      sources: [],
      envVars: [],
      options: defaultOptions(),
    };

    const out = generateCompose(input);
    expect(out).toContain('- ./shared:/app/shared');
    expect(out).not.toMatch(/- \.\/shared:\/app\/shared:ro/);
  });

  test('stays ro when all walkers declare ro', () => {
    const reader1: Recipe = {
      name: 'Reader1',
      agent: { systemPrompt: 'placeholder' },
      modules: {
        workspace: {
          mounts: [{ name: 'shared', path: './shared', mode: 'read-only' }],
        },
      },
    } as Recipe;
    const reader2: Recipe = {
      name: 'Reader2',
      agent: { systemPrompt: 'placeholder' },
      modules: {
        workspace: {
          mounts: [{ name: 'shared', path: './shared', mode: 'read-only' }],
        },
      },
    } as Recipe;

    const input: GeneratorInput = {
      walks: [
        { path: '/synthetic/r1.json', recipe: reader1 },
        { path: '/synthetic/r2.json', recipe: reader2 },
      ],
      sources: [],
      envVars: [],
      options: defaultOptions(),
    };

    const out = generateCompose(input);
    expect(out).toContain('- ./shared:/app/shared:ro');
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

describe('generateCompose — sidecar services', () => {
  function recipeWithServices(services: Recipe['services']): WalkResult {
    return {
      path: '/tmp/test-recipe.json',
      recipe: {
        name: 'Sidecar Test',
        agent: { systemPrompt: 'x' },
        services,
      } as Recipe,
    };
  }

  test('omits sidecar block when recipe has no services', () => {
    // Synthetic recipe with no services field — only the agent service
    // should appear under the top-level services: key.
    const walk: WalkResult = {
      path: '/tmp/no-sidecars.json',
      recipe: { name: 'No Sidecars', agent: { systemPrompt: 'x' } } as Recipe,
    };
    const out = generateCompose({
      walks: [walk], sources: [], envVars: [], options: defaultOptions(),
    });
    expect(out).not.toContain('container_name: mediawiki');
    expect(out).not.toContain('container_name: mariadb');
  });

  test('emits one service entry per sidecar', () => {
    const walk = recipeWithServices([
      { name: 'mediawiki', image: 'mediawiki:1.42', ports: ['8080:80'], dependsOn: ['mariadb'] },
      { name: 'mariadb', image: 'mariadb:11', restart: 'unless-stopped' },
    ]);
    const out = generateCompose({
      walks: [walk], sources: [], envVars: [], options: defaultOptions(),
    });
    expect(out).toContain('  mediawiki:');
    expect(out).toContain('    image: mediawiki:1.42');
    expect(out).toContain('  mariadb:');
    expect(out).toContain('    image: mariadb:11');
    // depends_on should be on the consumer (mediawiki), not the provider.
    expect(out).toMatch(/mediawiki:[\s\S]*?depends_on:[\s\S]*?- mariadb/);
  });

  test('honors port + environment + volumes + healthcheck on sidecars', () => {
    const walk = recipeWithServices([
      {
        name: 'mediawiki',
        image: 'mediawiki:1.42',
        ports: ['${MW_BIND:-127.0.0.1}:8080:80'],
        environment: { MW_DEBUG: '0' },
        volumes: [{ source: './wiki-db', target: '/var/lib/mysql' }],
        healthcheck: { test: ['CMD', 'curl', '-f', 'http://localhost/'], interval: '30s', retries: 3 },
      },
    ]);
    const out = generateCompose({
      walks: [walk], sources: [], envVars: [], options: defaultOptions(),
    });
    expect(out).toContain('"${MW_BIND:-127.0.0.1}:8080:80"');
    expect(out).toContain('MW_DEBUG: "0"');
    expect(out).toContain('./wiki-db:/var/lib/mysql');
    expect(out).toMatch(/test: \["CMD","curl","-f","http:\/\/localhost\/"\]/);
    expect(out).toContain('interval: 30s');
    expect(out).toContain('retries: 3');
  });

  test('top-level secrets block is union of build-time + sidecar secrets', () => {
    // Build-time secret on a source.
    const sourceWithAuth: McpSource = {
      key: 'https://github.com/x/y@main',
      url: 'https://github.com/x/y.git',
      ref: 'main',
      install: { kind: 'npm' },
      authSecret: 'GITLAB_TOKEN',
      sslBypass: false,
      inContainerPath: '/y',
      refs: [{ recipePath: '/r/a.json', mcpServerName: 'srv' }],
    };
    // Sidecar with an additional runtime secret.
    const walk = recipeWithServices([
      { name: 'mariadb', image: 'mariadb:11', secrets: ['WIKI_DB_PASSWORD'] },
    ]);
    const out = generateCompose({
      walks: [walk], sources: [sourceWithAuth], envVars: [], options: defaultOptions(),
    });
    // Top-level secrets block lists both, sorted.
    expect(out).toMatch(/secrets:\n\s+GITLAB_TOKEN:\n\s+file: \.\/GITLAB_TOKEN/);
    expect(out).toMatch(/WIKI_DB_PASSWORD:\n\s+file: \.\/WIKI_DB_PASSWORD/);
    // Service-level on the sidecar references it.
    expect(out).toMatch(/mariadb:[\s\S]*?secrets:[\s\S]*?- WIKI_DB_PASSWORD/);
  });
});

// ---------------------------------------------------------------------------
// 5. modules.webui — main-service port mapping
// ---------------------------------------------------------------------------

describe('generateCompose — webui port mapping', () => {
  function singleRecipe(modules: Recipe['modules']): GeneratorInput {
    const recipe: Recipe = {
      name: 'webui-test',
      agent: { systemPrompt: 'placeholder' },
      modules,
    } as Recipe;
    return {
      walks: [{ path: '/synthetic/webui.json', recipe }],
      sources: [],
      envVars: [],
      options: defaultOptions(),
    };
  }

  test('no ports: block on main service when no recipe enables webui', () => {
    const out = generateCompose(singleRecipe(undefined as unknown as Recipe['modules']));
    // No ports: line on the main service.  (Sidecar tests cover sidecar
    // ports separately; this checks the gap-2 main-service emission only.)
    expect(out).not.toMatch(/^ {4}ports:/m);
  });

  test('emits 127.0.0.1 loopback port mapping when modules.webui is true', () => {
    const out = generateCompose(singleRecipe({ webui: true } as Recipe['modules']));
    // Default port 7340 matches connectome-host's WebUiModule default.
    expect(out).toMatch(/^ {4}ports:\n {6}- "127\.0\.0\.1:7340:7340"$/m);
  });

  test('emits the declared port when modules.webui is an object with explicit port', () => {
    const out = generateCompose(
      singleRecipe({
        webui: { host: '0.0.0.0', port: 8888, basicAuth: { username: 'a', password: 'b' } },
      } as Recipe['modules']),
    );
    expect(out).toMatch(/^ {4}ports:\n {6}- "127\.0\.0\.1:8888:8888"$/m);
  });

  test('falls back to default port when object form omits port', () => {
    const out = generateCompose(
      singleRecipe({ webui: { host: '0.0.0.0' } } as Recipe['modules']),
    );
    expect(out).toMatch(/^ {4}ports:\n {6}- "127\.0\.0\.1:7340:7340"$/m);
  });

  test('detects webui declared on a fleet child (not just the parent)', () => {
    const parent: Recipe = {
      name: 'fleet-parent',
      agent: { systemPrompt: 'placeholder' },
    } as Recipe;
    const child: Recipe = {
      name: 'fleet-child',
      agent: { systemPrompt: 'placeholder' },
      modules: { webui: { port: 9999 } },
    } as Recipe;
    const input: GeneratorInput = {
      walks: [
        { path: '/synthetic/parent.json', recipe: parent },
        { path: '/synthetic/child.json', recipe: child },
      ],
      sources: [],
      envVars: [],
      options: defaultOptions(),
    };
    const out = generateCompose(input);
    expect(out).toMatch(/^ {4}ports:\n {6}- "127\.0\.0\.1:9999:9999"$/m);
  });

  test('modules.webui: false leaves the main service portless', () => {
    const out = generateCompose(singleRecipe({ webui: false } as Recipe['modules']));
    expect(out).not.toMatch(/^ {4}ports:/m);
  });
});
