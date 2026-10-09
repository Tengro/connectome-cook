import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { generateReadme } from '../src/generators/readme.js';
import { generateEnv } from '../src/generators/env.js';
import { deriveRequiredVars, requiresAnthropicCredential } from '../src/prompts.js';
import type { GeneratorInput, WalkResult } from '../src/types.js';
import type { RecipeFleet } from '../src/vendor/recipe.js';

function walks(provider: string | undefined = 'openai-codex', fleet?: boolean | RecipeFleet): WalkResult[] {
  return [{ path: '/tmp/parent.json', recipe: {
    name: 'Provider test', agent: { provider, systemPrompt: 'Test prompt' },
    ...(fleet === undefined ? {} : { modules: { fleet } }),
  } }];
}

function input(tree: WalkResult[]): GeneratorInput {
  return { walks: tree, sources: [], envVars: [], options: {
    outDir: '/tmp/unused', noPrompts: true, strict: false, pinRefs: false,
  } };
}

test('Codex README and env describe inference prerequisites without demanding Anthropic', () => {
  const readme = generateReadme(input(walks()));
  expect(readme).not.toContain('Anthropic credential');
  expect(readme).not.toContain('ANTHROPIC_API_KEY');
  for (const text of [readme, generateEnv(input(walks()))]) {
    expect(text).toContain('codex');
    expect(text).toContain('writable persistent CODEX_HOME');
    expect(text).toContain('codex login');
    expect(text).toContain('does not supply');
  }
  expect(readme).toContain('Container exits immediately');
});

test('mixed and default README retain Anthropic prerequisites and exit advice', () => {
  for (const tree of [walks().map(w => ({ ...w, recipe: { ...w.recipe, agent: { systemPrompt: 'Default prompt' } } })), [...walks(), ...walks('anthropic')]]) {
    const readme = generateReadme(input(tree));
    expect(readme).toContain('An Anthropic credential');
    expect(readme).toContain('set `ANTHROPIC_API_KEY`');
  }
});

test('launchable unknown fleet providers require conservative credentials', () => {
  for (const fleet of [true, {}, { children: [] }, { allowedRecipes: ['*'] },
    { allowedRecipes: ['recipes/*'] }, { allowedRecipes: ['./unknown.json'] },
    { children: [{ name: 'child', recipe: './child.json' }], allowedRecipes: ['./other.json'] }]) {
    const tree = walks('openai-codex', fleet);
    expect(requiresAnthropicCredential(tree)).toBe(true);
    expect(deriveRequiredVars([], [], [], tree).map(v => v.name)).toContain('ANTHROPIC_API_KEY');
    expect(generateReadme(input(tree))).toContain('An Anthropic credential');
    expect(generateEnv(input(tree))).toContain('ANTHROPIC_API_KEY=');
  }
});

test('closed Codex fleets and disabled fleets do not demand Anthropic', () => {
  const child = { name: 'child', recipe: './child.json', autoStart: false };
  for (const fleet of [false, { allowedRecipes: [] }, { children: [child] },
    { children: [child], allowedRecipes: ['./child.json'] }]) {
    const tree = [...walks('openai-codex', fleet), {
      ...walks()[0]!, path: '/tmp/child.json',
    }];
    expect(requiresAnthropicCredential(tree)).toBe(false);
  }
  expect(requiresAnthropicCredential([])).toBe(true);
  expect(requiresAnthropicCredential(walks('unknown'))).toBe(true);
});

test('no-value Codex bundle passes Compose config and preserves existing env', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cook-pr12-'));
  try {
    const recipe = join(dir, 'codex.json');
    const out = join(dir, 'bundle');
    writeFileSync(recipe, JSON.stringify(walks()[0]!.recipe));
    const build = (extra: string[] = []) => spawnSync(process.execPath, [
      join(import.meta.dir, '../bin/cook'), 'build', recipe, '--out', out, '--no-prompts', ...extra,
    ], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir } });
    const result = build();
    expect(result.status).toBe(0);
    const compose = spawnSync('docker', ['compose', 'config'], { cwd: out, encoding: 'utf8' });
    if (compose.error?.message.includes('ENOENT')) {
      console.warn('Docker CLI unavailable; artifact assertions passed, Compose validation unavailable.');
    } else {
      expect(compose.status).toBe(0);
    }
    expect(readFileSync(join(out, '.env'), 'utf8')).toBe('');
    expect(result.stderr).toContain('writable persistent CODEX_HOME');
    expect(result.stderr).toContain('codex login');
    expect(result.stderr).toContain('does not supply');
    writeFileSync(join(out, '.env'), 'KEEP=operator-value\n');
    expect(build().status).toBe(0);
    expect(readFileSync(join(out, '.env'), 'utf8')).toBe('KEEP=operator-value\n');
    // Explicit recipe values still overwrite the env file through the existing path.
    const r = walks()[0]!.recipe;
    r.agent.systemPrompt = 'Test ${EXAMPLE_VALUE}';
    writeFileSync(recipe, JSON.stringify(r));
    const values = join(dir, 'values.env');
    writeFileSync(values, 'EXAMPLE_VALUE=sample-value\n');
    expect(build(['--env-file', values]).status).toBe(0);
    expect(readFileSync(join(out, '.env'), 'utf8')).toBe('EXAMPLE_VALUE=sample-value\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Codex env template states prerequisites', () => {
  const text = generateEnv(input(walks()));
  expect(text).toContain('codex executable');
  expect(text).toContain('writable persistent CODEX_HOME');
  expect(text).toContain('codex login');
  expect(text).toContain('does not supply');
});
