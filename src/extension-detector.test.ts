/**
 * Tests for the extension detector: git-sourced extensions become
 * role:'extension' McpSources targeting /app/extensions/<name>; source-less
 * relative paths become LocalExtension bundles; absolute source-less paths
 * warn (non-strict) or error (strict); URL recipes reject local extensions.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectExtensions } from './extension-detector.js';
import type { WalkResult } from './types.js';
import type { Recipe } from './vendor/recipe.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cook-ext-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function walk(path: string, extensions: Recipe['extensions']): WalkResult {
  return {
    path,
    recipe: { name: 'T', agent: { systemPrompt: 'x' }, extensions } as Recipe,
  };
}

describe('detectExtensions — git-sourced', () => {
  test('emits a role:extension source targeting /app/extensions/<name>', () => {
    const result = detectExtensions([walk(join(dir, 'r.json'), {
      zk: {
        kind: 'strategy',
        path: './src/index.ts',
        source: { url: 'https://github.com/x/zk-ext.git', ref: 'dev', install: 'npm' },
      },
    })], { strict: false });

    expect(result.localExtensions).toEqual([]);
    expect(result.gitExtensions.length).toBe(1);
    const ext = result.gitExtensions[0]!;
    expect(ext.role).toBe('extension');
    expect(ext.extensionName).toBe('zk');
    expect(ext.key).toBe('ext:zk');
    expect(ext.url).toBe('https://github.com/x/zk-ext.git');
    expect(ext.ref).toBe('dev');
    expect(ext.install).toEqual({ kind: 'npm' });
    expect(ext.inContainerPath).toBe('/app/extensions/zk');
    expect(ext.entry).toBe('src/index.ts');
  });

  test('defaults to clone-only bun custom install when install is omitted', () => {
    const result = detectExtensions([walk(join(dir, 'r.json'), {
      zk: { kind: 'module', path: 'index.ts', source: { url: 'https://github.com/x/zk.git' } },
    })], { strict: false });
    expect(result.gitExtensions[0]!.install).toEqual({ kind: 'custom', run: '', runtime: 'bun' });
    expect(result.gitExtensions[0]!.ref).toBe('main');
  });

  test('carries authSecret, sslBypass, systemPackages through', () => {
    const result = detectExtensions([walk(join(dir, 'r.json'), {
      skirmish: {
        kind: 'strategy',
        path: 'index.ts',
        source: {
          url: 'https://git.internal/skirmish.git',
          authSecret: 'GIT_TOKEN',
          sslBypass: true,
          systemPackages: ['cmake', 'libsdl2-dev'],
          install: { run: 'make engine', runtime: 'custom' },
        },
      },
    })], { strict: false });
    const ext = result.gitExtensions[0]!;
    expect(ext.authSecret).toBe('GIT_TOKEN');
    expect(ext.sslBypass).toBe(true);
    expect(ext.systemPackages).toEqual(['cmake', 'libsdl2-dev']);
    expect(ext.install).toEqual({ kind: 'custom', run: 'make engine', runtime: 'custom' });
  });

  test('dedups same-name extensions across fleet recipes', () => {
    const src = { url: 'https://github.com/x/zk.git' };
    const result = detectExtensions([
      walk(join(dir, 'parent.json'), { zk: { kind: 'strategy', path: 'i.ts', source: src } }),
      walk(join(dir, 'child.json'), { zk: { kind: 'strategy', path: 'i.ts', source: src } }),
    ], { strict: false });
    expect(result.gitExtensions.length).toBe(1);
    expect(result.gitExtensions[0]!.refs.length).toBe(2);
  });

  test('rejects absolute path combined with source', () => {
    expect(() => detectExtensions([walk(join(dir, 'r.json'), {
      zk: { kind: 'strategy', path: '/abs/index.ts', source: { url: 'https://x/y.git' } },
    })], { strict: false })).toThrow(/must be relative to the cloned repo root/);
  });
});

describe('detectExtensions — local bundles', () => {
  test('bundles the entry file directory', () => {
    mkdirSync(join(dir, 'exts', 'zk'), { recursive: true });
    writeFileSync(join(dir, 'exts', 'zk', 'index.ts'), 'export function register() {}');
    const result = detectExtensions([walk(join(dir, 'r.json'), {
      zk: { kind: 'strategy', path: './exts/zk/index.ts' },
    })], { strict: false });

    expect(result.gitExtensions).toEqual([]);
    expect(result.localExtensions.length).toBe(1);
    const ext = result.localExtensions[0]!;
    expect(ext.name).toBe('zk');
    expect(ext.hostDir).toBe(join(dir, 'exts', 'zk'));
    expect(ext.entryBasename).toBe('index.ts');
    expect(ext.inContainerPath).toBe('/app/extensions/zk');
    expect(ext.hasPackageJson).toBe(false);
  });

  test('detects package.json presence', () => {
    mkdirSync(join(dir, 'zk'));
    writeFileSync(join(dir, 'zk', 'index.ts'), '');
    writeFileSync(join(dir, 'zk', 'package.json'), '{}');
    const result = detectExtensions([walk(join(dir, 'r.json'), {
      zk: { kind: 'module', path: './zk/index.ts' },
    })], { strict: false });
    expect(result.localExtensions[0]!.hasPackageJson).toBe(true);
  });

  test('errors when the entry file does not exist', () => {
    expect(() => detectExtensions([walk(join(dir, 'r.json'), {
      zk: { kind: 'module', path: './missing/index.ts' },
    })], { strict: false })).toThrow(/entry file not found/);
  });

  test('errors on relative path in a URL-loaded recipe', () => {
    expect(() => detectExtensions([walk('https://example.com/r.json', {
      zk: { kind: 'module', path: './zk/index.ts' },
    })], { strict: false })).toThrow(/URL-loaded recipe/);
  });

  test('errors when one name mixes git and local modes across recipes', () => {
    mkdirSync(join(dir, 'zk'));
    writeFileSync(join(dir, 'zk', 'index.ts'), '');
    expect(() => detectExtensions([
      walk(join(dir, 'a.json'), { zk: { kind: 'module', path: './zk/index.ts' } }),
      walk(join(dir, 'b.json'), { zk: { kind: 'module', path: 'i.ts', source: { url: 'https://x/y.git' } } }),
    ], { strict: false })).toThrow(/both with and without a 'source' block/);
  });
});

describe('detectExtensions — absolute source-less paths', () => {
  test('non-strict: warns and skips (not baked)', () => {
    const result = detectExtensions([walk(join(dir, 'r.json'), {
      host: { kind: 'module', path: '/opt/host-ext/index.ts' },
    })], { strict: false });
    expect(result.gitExtensions).toEqual([]);
    expect(result.localExtensions).toEqual([]);
  });

  test('strict: errors', () => {
    expect(() => detectExtensions([walk(join(dir, 'r.json'), {
      host: { kind: 'module', path: '/opt/host-ext/index.ts' },
    })], { strict: true })).toThrow(/cannot be baked into the image \(strict mode\)/);
  });
});
