import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { walkRecipe } from './walker.js';

const examplesRoot = resolve(
  import.meta.dir,
  '..',
  'examples',
  'triumvirate',
  'recipes',
);

describe('walkRecipe', () => {
  test('walks the triumvirate parent + 4 fleet children in order', async () => {
    const parent = join(examplesRoot, 'triumvirate.json');
    const results = await walkRecipe(parent);

    expect(results).toHaveLength(5);  // parent + miner + reviewer + clerk + encyclopedist

    expect(results[0]?.path).toBe(parent);
    expect(results[0]?.recipe.name).toBe('Knowledge Mining Triumvirate');

    expect(results[1]?.path).toBe(join(examplesRoot, 'knowledge-miner.json'));
    expect(results[1]?.recipe.name).toBe(
      'Knowledge Miner (generic Triumvirate example)',
    );
    expect(results[2]?.path).toBe(join(examplesRoot, 'knowledge-reviewer.json'));
    expect(results[2]?.recipe.name).toBe('Knowledge Reviewer');
    expect(results[3]?.path).toBe(join(examplesRoot, 'clerk.json'));
    expect(results[3]?.recipe.name).toBe('Library Frontdesk');
    expect(results[4]?.path).toBe(join(examplesRoot, 'encyclopedist.json'));
    expect(results[4]?.recipe.name).toBe('Knowledge Encyclopedist');
  });

  test('walks a leaf recipe and returns a single entry', async () => {
    const leaf = join(examplesRoot, 'clerk.json');
    const results = await walkRecipe(leaf);

    expect(results).toHaveLength(1);
    expect(results[0]?.path).toBe(leaf);
    expect(results[0]?.recipe.name).toBe('Library Frontdesk');
  });

  describe('cycle handling', () => {
    let tmp: string;
    let aPath: string;
    let bPath: string;

    beforeAll(() => {
      tmp = mkdtempSync(join(tmpdir(), 'cook-walker-cycle-'));
      aPath = join(tmp, 'a.json');
      bPath = join(tmp, 'b.json');

      const stub = (name: string, childRecipe: string) => ({
        name,
        agent: { systemPrompt: 'stub' },
        modules: {
          fleet: {
            children: [
              { name: 'partner', recipe: childRecipe },
            ],
          },
        },
      });

      writeFileSync(aPath, JSON.stringify(stub('A', 'b.json')));
      writeFileSync(bPath, JSON.stringify(stub('B', 'a.json')));
    });

    afterAll(() => {
      rmSync(tmp, { recursive: true, force: true });
    });

    test('A → B → A produces exactly two entries with no infinite loop', async () => {
      const results = await walkRecipe(aPath);

      expect(results).toHaveLength(2);
      expect(results[0]?.path).toBe(aPath);
      expect(results[0]?.recipe.name).toBe('A');
      expect(results[1]?.path).toBe(bPath);
      expect(results[1]?.recipe.name).toBe('B');
    });
  });
});
