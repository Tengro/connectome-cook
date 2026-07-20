/**
 * Tests for host-mode sidecars + --pin-refs: the sidecars-only compose
 * file, launcher orchestration, shared runtime-file rendering, and ref
 * pinning (against a local file:// git repo — no network).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSidecarCompose } from './generators/compose.js';
import { gitCheckoutCommand } from './runtimes/index.js';
import { renderLauncher } from './backends/host.js';
import {
  buildValueBag,
  renderRuntimeFiles,
} from './backends/runtime-files.js';
import {
  candidateRefNames,
  looksLikeSha,
  pinSources,
  resolveRemoteRef,
} from './pin-refs.js';
import type { GeneratorInput, McpSource, WalkResult } from './types.js';
import type { InstallPlan } from './plan.js';
import type { Recipe } from './vendor/recipe.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cook-sidecar-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function walkWith(recipe: Partial<Recipe>): WalkResult {
  return {
    path: '/r/parent.json',
    recipe: { name: 'T', agent: { systemPrompt: 'x' }, ...recipe } as Recipe,
  };
}

function planWith(recipe: Partial<Recipe>, values: Record<string, string> = {}): InstallPlan {
  const walk = walkWith(recipe);
  return {
    recipePath: '/r/parent.json',
    walks: [walk],
    parentWalk: walk,
    sources: [],
    localExtensions: [],
    envVars: [],
    runtimeOnlyVars: [],
    credentialFiles: [],
    requirements: [],
    values,
    envFileValues: {},
    credentialValues: {},
    options: { strict: false, noPrompts: true },
  };
}

const GEN_OPTIONS = { outDir: '/out', noPrompts: true, strict: false, pinRefs: false };

describe('generateSidecarCompose', () => {
  test('null when no services declared', () => {
    const input: GeneratorInput = {
      walks: [walkWith({})], sources: [], envVars: [], options: GEN_OPTIONS,
    };
    expect(generateSidecarCompose(input)).toBeNull();
  });

  test('renders sidecar services and their secrets, no agent service', () => {
    const input: GeneratorInput = {
      walks: [walkWith({
        services: [
          {
            name: 'mariadb',
            image: 'mariadb:11',
            secrets: ['WIKI_DB_PASSWORD'],
            healthcheck: { test: ['CMD', 'healthcheck.sh'], interval: '5s' },
          },
          { name: 'mediawiki', image: 'mediawiki:1.42', ports: ['8080:80'], dependsOn: ['mariadb'] },
        ],
      })],
      sources: [],
      envVars: [],
      options: GEN_OPTIONS,
    };
    const compose = generateSidecarCompose(input)!;
    expect(compose).toContain('  mariadb:');
    expect(compose).toContain('  mediawiki:');
    expect(compose).toContain('    image: mariadb:11');
    expect(compose).toContain('WIKI_DB_PASSWORD:');
    expect(compose).toContain('file: ./WIKI_DB_PASSWORD');
    expect(compose).toContain('depends_on:');
    // No agent/build service — sidecars only.
    expect(compose).not.toContain('build:');
    expect(compose).not.toContain('dockerfile:');
  });
});

describe('renderLauncher', () => {
  test('plain launcher has no sidecar or envsubst steps', () => {
    const sh = renderLauncher('r.json', { hasSidecars: false, envsubstFiles: [] });
    expect(sh).not.toContain('docker compose');
    expect(sh).not.toContain('envsubst');
    expect(sh).toContain('exec bun src/index.ts "../recipes/r.json" "$@"');
  });

  test('sidecars bring-up precedes the agent exec and honors the skip env', () => {
    const sh = renderLauncher('r.json', { hasSidecars: true, envsubstFiles: [] });
    expect(sh).toContain('docker compose -f docker-compose.sidecars.yml up -d --wait');
    expect(sh).toContain('COOK_SKIP_SIDECARS');
    expect(sh.indexOf('docker compose')).toBeLessThan(sh.indexOf('exec bun'));
  });

  test('envsubst steps render tmpl → target with mode', () => {
    const sh = renderLauncher('r.json', {
      hasSidecars: false,
      envsubstFiles: [{ tmpl: 'app/cfg.json.tmpl', target: 'app/cfg.json', mode: '644' }],
    });
    expect(sh).toContain('envsubst < "app/cfg.json.tmpl" > "app/cfg.json"');
    expect(sh).toContain('chmod 644 "app/cfg.json"');
    expect(sh).toContain('command -v envsubst');
  });
});

describe('renderRuntimeFiles', () => {
  test('renders sidecar templates fully and container templates per runtime flags', () => {
    const plan = planWith({
      services: [{
        name: 'wiki', image: 'mediawiki:1.42',
        volumes: [{ source: './wiki-config/LocalSettings.php', target: '/x' }],
        templateFiles: [{ path: './wiki-config/LocalSettings.php', template: 'key=${SECRET}' }],
      }],
      containerTemplateFiles: [
        { hostPath: './full.json', inContainer: '/app/full.json', template: 'v=${SECRET}' },
        { hostPath: './rt.json', inContainer: '/app/rt.json', template: 'v=${BOT_PW}', runtimeRender: true },
        { hostPath: './mix.json', inContainer: '/app/mix.json', template: 'a=${SECRET} b=${BOT_PW}', runtimeVars: ['BOT_PW'] },
      ],
    }, { SECRET: 's3cret' });
    const files = renderRuntimeFiles(plan, buildValueBag(plan));

    const sidecar = files.find((f) => f.kind === 'sidecar-template')!;
    expect(sidecar.content).toBe('key=s3cret');
    expect(sidecar.runtime).toBe(false);

    const full = files.find((f) => f.relPath === './full.json')!;
    expect(full.content).toBe('v=s3cret');
    expect(full.runtime).toBe(false);
    expect(full.inContainer).toBe('/app/full.json');

    const rt = files.find((f) => f.relPath === './rt.json')!;
    expect(rt.content).toBe('v=${BOT_PW}');
    expect(rt.runtime).toBe(true);

    const mix = files.find((f) => f.relPath === './mix.json')!;
    expect(mix.content).toBe('a=s3cret b=${BOT_PW}');
    expect(mix.runtime).toBe(true);
    expect(mix.missing).toEqual([]);
  });
});

describe('pin-refs', () => {
  test('looksLikeSha and candidateRefNames', () => {
    expect(looksLikeSha('a'.repeat(40))).toBe(true);
    expect(looksLikeSha('abc1234')).toBe(true);
    expect(looksLikeSha('main')).toBe(false);
    expect(candidateRefNames('dev')).toEqual(['refs/heads/dev', 'refs/tags/dev', 'dev']);
    expect(candidateRefNames('refs/merge-requests/1/head')).toEqual(['refs/merge-requests/1/head']);
  });

  test('resolveRemoteRef resolves branches in a local repo; null for unknown', () => {
    const repo = join(dir, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    writeFileSync(join(repo, 'f.txt'), 'hello');
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
    };
    execFileSync('git', ['add', '.'], { cwd: repo, env });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo, env });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();

    expect(resolveRemoteRef(repo, 'main')).toBe(head);
    expect(resolveRemoteRef(repo, 'no-such-branch')).toBeNull();
    // Already a SHA — returned verbatim, no ls-remote.
    expect(resolveRemoteRef('https://invalid.invalid/x.git', head)).toBe(head);
  });

  test('pinSources pins plain git sources, skips private/registry/pinned', () => {
    const repo = join(dir, 'repo2');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    writeFileSync(join(repo, 'f.txt'), 'x');
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
    };
    execFileSync('git', ['add', '.'], { cwd: repo, env });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo, env });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();

    const mk = (over: Partial<McpSource>): McpSource => ({
      key: 'k', url: repo, ref: 'main', install: { kind: 'npm' },
      inContainerPath: '/x', refs: [], ...over,
    });
    const plain = mk({});
    const priv = mk({ key: 'priv', authSecret: 'TOKEN' });
    const registry = mk({ key: 'npm:p', url: '', install: { kind: 'npm-global', package: 'p' } });
    const shaRef = mk({ key: 'sha', ref: head });
    pinSources([plain, priv, registry, shaRef]);

    expect(plain.commit).toBe(head);
    expect(priv.commit).toBeUndefined();
    expect(registry.commit).toBeUndefined();
    expect(shaRef.commit).toBe(head);
  });

  test('gitCheckoutCommand prefers the pinned commit', () => {
    const source: McpSource = {
      key: 'k', url: 'https://g/x.git', ref: 'main', commit: 'abc1234def',
      install: { kind: 'npm' }, inContainerPath: '/x', refs: [],
    };
    expect(gitCheckoutCommand(source)).toBe(' && git checkout abc1234def');
    delete source.commit;
    expect(gitCheckoutCommand(source)).toBe('');
  });
});
