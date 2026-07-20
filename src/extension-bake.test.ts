/**
 * Generator-level tests for extension baking: Dockerfile stages/COPYs and
 * overlay path rewrites for both git-sourced and local-bundle extensions.
 */
import { describe, test, expect } from 'bun:test';
import { generateDockerfile } from './generators/dockerfile.js';
import { generateOverlays } from './generators/overlay.js';
import type { GeneratorInput, LocalExtension, McpSource, WalkResult } from './types.js';
import type { Recipe } from './vendor/recipe.js';

const OPTIONS = {
  outDir: '/tmp/out',
  noPrompts: true,
  strict: false,
  pinRefs: false,
};

function walkWith(extensions: Recipe['extensions']): WalkResult {
  return {
    path: '/recipes/parent.json',
    recipe: { name: 'Ext Image', agent: { systemPrompt: 'x' }, extensions } as Recipe,
  };
}

function gitExt(name: string, entry: string, overrides: Partial<McpSource> = {}): McpSource {
  return {
    role: 'extension',
    extensionName: name,
    entry,
    key: `ext:${name}`,
    url: `https://github.com/x/${name}.git`,
    ref: 'main',
    install: { kind: 'custom', run: '', runtime: 'bun' },
    inContainerPath: `/app/extensions/${name}`,
    refs: [{ recipePath: '/recipes/parent.json', mcpServerName: name }],
    ...overrides,
  };
}

function localExt(name: string, entryBasename = 'index.ts', hasPackageJson = false): LocalExtension {
  return {
    name,
    hostDir: `/home/op/exts/${name}`,
    entryBasename,
    inContainerPath: `/app/extensions/${name}`,
    hasPackageJson,
    refs: [{ recipePath: '/recipes/parent.json', mcpServerName: name }],
  };
}

describe('generateDockerfile with extensions', () => {
  test('git extension gets a builder stage cloning to /app/extensions/<name> and a runtime COPY', () => {
    const input: GeneratorInput = {
      walks: [walkWith({ zk: { kind: 'strategy', path: './src/index.ts', sourceMeta: { url: 'x' } } })],
      sources: [gitExt('zk', 'src/index.ts')],
      envVars: [],
      options: OPTIONS,
    };
    const dockerfile = generateDockerfile(input);
    expect(dockerfile).toContain('git clone https://github.com/x/zk.git /app/extensions/zk');
    expect(dockerfile).toContain('COPY --from=zk-build /app/extensions/zk /app/extensions/zk');
  });

  test('local extension gets a context COPY, and bun install when it has a package.json', () => {
    const input: GeneratorInput = {
      walks: [walkWith({
        plain: { kind: 'module', path: './exts/plain/index.ts' },
        deps: { kind: 'module', path: './exts/deps/index.ts' },
      })],
      sources: [],
      localExtensions: [localExt('plain'), localExt('deps', 'index.ts', true)],
      envVars: [],
      options: OPTIONS,
    };
    const dockerfile = generateDockerfile(input);
    expect(dockerfile).toContain('COPY extensions/plain /app/extensions/plain');
    expect(dockerfile).toContain('COPY extensions/deps /app/extensions/deps');
    expect(dockerfile).toContain('RUN cd /app/extensions/deps && bun install');
    expect(dockerfile).not.toContain('RUN cd /app/extensions/plain && bun install');
  });

  test('extension systemPackages land on the runtime apt line', () => {
    const input: GeneratorInput = {
      walks: [walkWith({ sk: { kind: 'strategy', path: 'i.ts' } })],
      sources: [gitExt('sk', 'i.ts', { systemPackages: ['libsdl2-2.0-0'] })],
      envVars: [],
      options: OPTIONS,
    };
    expect(generateDockerfile(input)).toMatch(/apt-get install .*libsdl2-2\.0-0/);
  });
});

describe('generateOverlays with extensions', () => {
  test('rewrites git extension path to inContainerPath/entry', () => {
    const input: GeneratorInput = {
      walks: [walkWith({ zk: { kind: 'strategy', path: './src/index.ts', source: { url: 'https://github.com/x/zk.git' } } })],
      sources: [gitExt('zk', 'src/index.ts')],
      envVars: [],
      options: OPTIONS,
    };
    const overlays = generateOverlays(input);
    const overlay = overlays.get('/recipes/parent.json');
    expect(overlay?.extensions?.zk).toEqual({ path: '/app/extensions/zk/src/index.ts' } as never);
  });

  test('rewrites local extension path to inContainerPath/entryBasename', () => {
    const input: GeneratorInput = {
      walks: [walkWith({ plain: { kind: 'module', path: './exts/plain/index.ts' } })],
      sources: [],
      localExtensions: [localExt('plain')],
      envVars: [],
      options: OPTIONS,
    };
    const overlay = generateOverlays(input).get('/recipes/parent.json');
    expect(overlay?.extensions?.plain).toEqual({ path: '/app/extensions/plain/index.ts' } as never);
  });

  test('leaves unbaked (absolute-path) extensions untouched', () => {
    const input: GeneratorInput = {
      walks: [walkWith({ host: { kind: 'module', path: '/opt/host/index.ts' } })],
      sources: [],
      localExtensions: [],
      envVars: [],
      options: OPTIONS,
    };
    expect(generateOverlays(input).size).toBe(0);
  });

  test('never rewrites an absolute source-less path even when a same-named target exists', () => {
    // The detector errors on this mix at build time; the overlay guard keeps
    // the invariant independently (defense in depth for direct callers).
    const input: GeneratorInput = {
      walks: [walkWith({ zk: { kind: 'module', path: '/opt/zk/index.ts' } })],
      sources: [gitExt('zk', 'src/index.ts')],
      envVars: [],
      options: OPTIONS,
    };
    expect(generateOverlays(input).size).toBe(0);
  });

  test('no overlay when the recipe already points at the baked path', () => {
    const input: GeneratorInput = {
      walks: [walkWith({ zk: { kind: 'strategy', path: '/app/extensions/zk/src/index.ts' } })],
      sources: [gitExt('zk', 'src/index.ts')],
      envVars: [],
      options: OPTIONS,
    };
    expect(generateOverlays(input).size).toBe(0);
  });
});
