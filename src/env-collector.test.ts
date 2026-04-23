/**
 * Tests for env-collector.
 *
 * Coverage:
 *   1. Real recipe (knowledge-miner.json) — detects GITLAB_TOKEN and
 *      GITLAB_API_URL with the right jsonPath/recipePath.
 *   2. Synthetic recipe with `${API_KEY}` referenced from 3 distinct sites —
 *      collapses to one EnvVar with `usedIn.length === 3`, all jsonPaths
 *      distinct.
 *   3. Recipe with no `${VAR}` references — empty array.
 */

import { describe, it, expect } from 'bun:test';
import { resolve } from 'node:path';
import { collectEnvVars } from './env-collector.js';
import { loadRecipeRaw, validateRecipe } from './vendor/recipe.js';
import type { Recipe, WalkResult } from './types.js';

const KNOWLEDGE_MINER = resolve(
  __dirname,
  '../examples/triumvirate/recipes/knowledge-miner.json',
);

describe('collectEnvVars', () => {
  it('finds GITLAB_TOKEN and GITLAB_API_URL in the knowledge-miner recipe', async () => {
    const recipe = await loadRecipeRaw(KNOWLEDGE_MINER);
    const walks: WalkResult[] = [{ path: KNOWLEDGE_MINER, recipe }];

    const vars = collectEnvVars(walks);
    const names = vars.map((v) => v.name);

    expect(names).toContain('GITLAB_TOKEN');
    expect(names).toContain('GITLAB_API_URL');

    const token = vars.find((v) => v.name === 'GITLAB_TOKEN')!;
    expect(token.usedIn).toHaveLength(1);
    expect(token.usedIn[0]!.recipePath).toBe(KNOWLEDGE_MINER);
    expect(token.usedIn[0]!.jsonPath).toBe(
      'mcpServers.gitlab.env.GITLAB_PERSONAL_ACCESS_TOKEN',
    );

    const apiUrl = vars.find((v) => v.name === 'GITLAB_API_URL')!;
    expect(apiUrl.usedIn).toHaveLength(1);
    expect(apiUrl.usedIn[0]!.recipePath).toBe(KNOWLEDGE_MINER);
    expect(apiUrl.usedIn[0]!.jsonPath).toBe('mcpServers.gitlab.env.GITLAB_API_URL');
  });

  it('returns sorted output', async () => {
    const recipe = await loadRecipeRaw(KNOWLEDGE_MINER);
    const vars = collectEnvVars([{ path: KNOWLEDGE_MINER, recipe }]);
    const names = vars.map((v) => v.name);
    const sorted = [...names].sort();
    expect(names).toEqual(sorted);
  });

  it('dedupes a variable referenced from 3 distinct sites into one EnvVar', () => {
    const raw: Recipe = validateRecipe({
      name: 'synthetic',
      agent: {
        // Site 1: reference inside the system prompt string.
        systemPrompt: 'Use the api with key ${API_KEY} please.',
      },
      mcpServers: {
        // Site 2: nested env var.
        alpha: {
          command: 'node',
          env: { ALPHA_KEY: '${API_KEY}' },
        },
        // Site 3: another nested env var, different server.
        beta: {
          command: 'node',
          env: { BETA_KEY: '${API_KEY}' },
        },
      },
    });

    const recipePath = '/synthetic/recipe.json';
    const vars = collectEnvVars([{ path: recipePath, recipe: raw }]);

    expect(vars).toHaveLength(1);
    const apiKey = vars[0]!;
    expect(apiKey.name).toBe('API_KEY');
    expect(apiKey.usedIn).toHaveLength(3);

    // All three usedIn entries point at the same recipe...
    for (const use of apiKey.usedIn) {
      expect(use.recipePath).toBe(recipePath);
    }

    // ...but at three distinct jsonPaths.
    const paths = apiKey.usedIn.map((u) => u.jsonPath);
    expect(new Set(paths).size).toBe(3);
    expect(paths).toContain('agent.systemPrompt');
    expect(paths).toContain('mcpServers.alpha.env.ALPHA_KEY');
    expect(paths).toContain('mcpServers.beta.env.BETA_KEY');
  });

  it('returns an empty array when no ${VAR} references are present', () => {
    const raw: Recipe = validateRecipe({
      name: 'plain',
      agent: { systemPrompt: 'No variables here, just plain text.' },
      mcpServers: {
        plain: {
          command: 'node',
          args: ['./build/index.js'],
          env: { LITERAL: 'hello-world' },
        },
      },
    });

    const vars = collectEnvVars([{ path: '/plain/recipe.json', recipe: raw }]);
    expect(vars).toEqual([]);
  });
});
