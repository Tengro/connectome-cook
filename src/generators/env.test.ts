/**
 * Tests for the `.env.example` generator.
 *
 * Coverage:
 *   1. Diff-test against the triumvirate example: assert structural content
 *      (ANTHROPIC_API_KEY, GITLAB_TOKEN, GITLAB_API_URL all present;
 *      Required heading present; UNIX newlines only).
 *   2. Synthetic input with a source that has `authSecret: GITLAB_TOKEN`:
 *      assert a comment mentioning BuildKit secrets appears near the secret.
 *   3. Synthetic input with no env vars: assert ANTHROPIC_API_KEY still
 *      appears (it's hardcoded for membrane), with the commented
 *      ANTHROPIC_AUTH_TOKEN alternative alongside it.
 */

import { afterEach, beforeEach, describe, expect, test, spyOn } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolvePlan } from '../plan.js';
import { log } from '../log.js';
import { deriveRequiredVars, resolvePresent } from '../prompts.js';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { generateEnv } from './env.js';
import { collectEnvVars } from '../env-collector.js';
import { detectSources } from '../source-detector.js';
import { loadRecipeRaw } from '../vendor/recipe.js';
import type {
  BuildOptions,
  EnvVar,
  GeneratorInput,
  McpSource,
  WalkResult,
} from '../types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RECIPES_DIR = resolve(HERE, '..', '..', 'examples', 'triumvirate', 'recipes');

const DEFAULT_OPTIONS: BuildOptions = {
  outDir: '/tmp/cook-test',
  noPrompts: true,
  strict: false,
  pinRefs: false,
};

describe('provider auth — planner and generated env', () => {
  const envVars = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'BUILD_SECRET', 'SIDECAR_SECRET'] as const;
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved = {};
    for (const name of envVars) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const name of envVars) {
      if (saved[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = saved[name];
      }
    }
  });

  async function check(provider: string | undefined, prompt = 'stub', childProvider?: string, secrets = false) {
    const dir = mkdtempSync(join(tmpdir(), 'provider-auth-'));
    const agent = (provider: string | undefined) => ({
      ...(provider === undefined ? {} : { provider }),
      model: provider === 'openai-codex' ? 'gpt-6.1-sol' : 'claude-sonnet-5',
      systemPrompt: prompt,
    });
    const warn = spyOn(log, 'warn').mockImplementation(() => {});
    try {
      writeFileSync(`${dir}/parent.json`, JSON.stringify({
        name: 'parent', agent: agent(provider),
        ...(childProvider ? { modules: { fleet: { children: [{ name: 'child', recipe: './child.json' }] } } } : {}),
        ...(secrets ? {
          services: [{ name: 'sidecar', image: 'example:1', secrets: ['SIDECAR_SECRET'] }],
          mcpServers: { tool: { command: 'bun', source: {
            url: 'https://example.com/tool.git', authSecret: 'BUILD_SECRET',
            install: { runtime: 'bun', run: 'bun install' },
          } } },
        } : {}),
      }));
      if (childProvider) writeFileSync(`${dir}/child.json`, JSON.stringify({ name: 'child', agent: agent(childProvider) }));
      const result = await resolvePlan(`${dir}/parent.json`, { strict: true, noPrompts: true });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('plan failed');
      const plan = result.plan;
      const out = generateEnv({ walks: plan.walks, sources: plan.sources, envVars: plan.envVars, options: DEFAULT_OPTIONS });
      const allWarnings = warn.mock.calls.map(([message]) => message);
      const codexWarnings = allWarnings.filter(message => message.startsWith('Codex inference requires'));
      if (plan.walks.some(walk => walk.recipe.agent.provider === 'openai-codex')) {
        expect(codexWarnings).toHaveLength(1);
        expect(codexWarnings[0]).toContain('codex executable on PATH');
        expect(codexWarnings[0]).toContain('writable persistent CODEX_HOME');
        expect(codexWarnings[0]).toContain('codex login');
        expect(codexWarnings[0]).toContain('does not supply');
      } else {
        expect(codexWarnings).toEqual([]);
      }
      // Keep credential/missing-value assertions independent of the added
      // inference prerequisite warning; all other warnings remain visible.
      return { out, warnings: allWarnings.filter(message => !message.startsWith('Codex inference requires')), plan };
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test('explicit Codex-only tree has no implicit credential or missing-value warning', async () => {
    const { out, warnings, plan } = await check('openai-codex', 'stub', 'openai-codex');
    expect(plan.walks).toHaveLength(2);
    expect(out).not.toContain('ANTHROPIC_');
    expect(out).toContain('# No required variables in this section. Check build-time secrets and notes below.');
    expect(out).toContain('writable persistent CODEX_HOME');
    expect(out).toContain('codex login');
    expect(warnings).toEqual([]);
  });

  for (const provider of [undefined, 'anthropic', 'unknown-route']) {
    // Unknown routes are defensive Cook inputs; the host rejects them.
    const label = provider === 'unknown-route'
      ? 'defensive Cook input unknown-route (unsupported by host)'
      : `provider ${provider ?? '(omitted)'}`;
    test(`${label} retains either/or requirement`, async () => {
      const { out, warnings } = await check(provider);
      expect(out).toMatch(/^ANTHROPIC_API_KEY=/m);
      expect(out).toMatch(/^# ANTHROPIC_AUTH_TOKEN=/m);
      expect(out).not.toContain('No required variables in this section.');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('1 required value');
    });
  }

  test('Anthropic descendant retains the credential in a mixed fleet', async () => {
    const { out, warnings } = await check('openai-codex', 'stub', 'anthropic');
    expect(out).toMatch(/^ANTHROPIC_API_KEY=/m);
    expect(out).toMatch(/^# ANTHROPIC_AUTH_TOKEN=/m);
    expect(warnings[0]).toContain('1 required value');
  });

  for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) {
    test(`Codex explicit ${name} is required by exact name`, async () => {
      const { out, warnings, plan } = await check('openai-codex', '${' + name + '}');
      expect(out).toMatch(new RegExp(`^${name}=`, 'm'));
      expect(out).not.toContain('No required variables in this section.');
      expect(warnings[0]).toContain('1 required value');
      // Exact references cannot be satisfied by the other credential.
      const other = name === 'ANTHROPIC_API_KEY' ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY';
      const { missing } = resolvePresent(deriveRequiredVars(plan.envVars, [], [], plan.walks), { [other]: 'fixture-only' });
      expect(missing.map((v) => v.name)).toContain(name);
    });

    test(`Codex default-valued ${name} remains optional`, async () => {
      const { out, warnings, plan } = await check('openai-codex', '${' + name + ':-fixture-default}');
      expect(out).toMatch(new RegExp(`^# ${name}=fixture-default$`, 'm'));
      expect(out).not.toMatch(new RegExp(`^${name}=`, 'm'));
      expect(out).toContain('# No required variables in this section. Check build-time secrets and notes below.');
      expect(out).toContain('# --- Optional ---');
      expect(out).toContain('writable persistent CODEX_HOME');
      expect(out).toContain('codex login');
      // Existing noPrompts behavior also warns for missing optional references.
      expect(warnings[0]).toContain('1 required value');
      const required = deriveRequiredVars(plan.envVars, [], [], plan.walks);
      expect(required).toHaveLength(1);
      expect(required[0]!.name).toBe(name);
      expect(required[0]!.defaultValue).toBe('fixture-default');
    });
  }

  test('Codex still reports unrelated build and sidecar secrets', async () => {
    const { out, warnings } = await check('openai-codex', 'stub', undefined, true);
    expect(out).not.toContain('ANTHROPIC_');
    expect(out).toMatch(/^BUILD_SECRET=/m);
    expect(out).toContain('# --- Build-time secrets ---');
    expect(out).toContain('# No required variables in this section. Check build-time secrets and notes below.');
    expect(warnings[0]).toContain('2 required values');
  });
});

async function loadWalk(name: string): Promise<WalkResult> {
  const path = resolve(RECIPES_DIR, `${name}.json`);
  const recipe = await loadRecipeRaw(path);
  return { path, recipe };
}

describe('generateEnv — triumvirate example', () => {
  test('output contains ANTHROPIC_API_KEY, GITLAB_TOKEN, GITLAB_API_URL', async () => {
    const walks = await Promise.all([
      loadWalk('triumvirate'),
      loadWalk('knowledge-miner'),
      loadWalk('knowledge-reviewer'),
      loadWalk('clerk'),
    ]);
    const sources = detectSources(walks, { strict: false });
    const envVars = collectEnvVars(walks);

    const input: GeneratorInput = {
      walks,
      sources,
      envVars,
      options: DEFAULT_OPTIONS,
    };
    const out = generateEnv(input);

    // Uncommented ANTHROPIC_API_KEY assignment somewhere in the output.
    expect(out).toMatch(/^ANTHROPIC_API_KEY=/m);
    // Commented ANTHROPIC_AUTH_TOKEN alternative alongside it.
    expect(out).toMatch(/^# ANTHROPIC_AUTH_TOKEN=/m);
    // GITLAB_TOKEN and GITLAB_API_URL each present as `KEY=` lines.
    expect(out).toMatch(/^GITLAB_TOKEN=/m);
    expect(out).toMatch(/^GITLAB_API_URL=/m);
  });

  test('output contains a Required-flavored section heading', async () => {
    const walks = await Promise.all([loadWalk('triumvirate')]);
    const input: GeneratorInput = {
      walks,
      sources: detectSources(walks, { strict: false }),
      envVars: collectEnvVars(walks),
      options: DEFAULT_OPTIONS,
    };
    const out = generateEnv(input);

    // Section heading: `# --- Required ---` with optional trailing dashes.
    expect(out).toMatch(/# --- Required( -+)?( ---)?/);
  });

  test('uses UNIX line endings only — no CRLF anywhere', async () => {
    const walks = await Promise.all([
      loadWalk('triumvirate'),
      loadWalk('knowledge-miner'),
    ]);
    const input: GeneratorInput = {
      walks,
      sources: detectSources(walks, { strict: false }),
      envVars: collectEnvVars(walks),
      options: DEFAULT_OPTIONS,
    };
    const out = generateEnv(input);
    expect(out).not.toContain('\r');
  });
});

describe('generateEnv — build-time secrets', () => {
  test('source.authSecret produces a BuildKit-secret comment near the var', () => {
    const walks: WalkResult[] = [
      {
        path: '/r/parent.json',
        recipe: { name: 'with-secret-source', agent: { systemPrompt: 'p' } },
      },
    ];
    const sources: McpSource[] = [
      {
        key: 'https://internal.example.com/private@main',
        url: 'https://internal.example.com/private.git',
        ref: 'main',
        install: { kind: 'npm' },
        authSecret: 'GITLAB_TOKEN',
        inContainerPath: '/private',
        refs: [{ recipePath: '/r/parent.json', mcpServerName: 'private' }],
      },
    ];
    const envVars: EnvVar[] = [];
    const input: GeneratorInput = {
      walks,
      sources,
      envVars,
      options: DEFAULT_OPTIONS,
    };

    const out = generateEnv(input);

    // The secret line itself.
    expect(out).toMatch(/^GITLAB_TOKEN=/m);
    // BuildKit secret comment in the same neighborhood as the var.
    // Find the index of the GITLAB_TOKEN= line and check the comment appears
    // in the preceding ~6 lines (the build-time secrets block we emit has
    // 3 comment lines directly above the assignment).
    const lines = out.split('\n');
    const tokenIdx = lines.findIndex((l) => l.startsWith('GITLAB_TOKEN='));
    expect(tokenIdx).toBeGreaterThan(0);
    const window = lines.slice(Math.max(0, tokenIdx - 6), tokenIdx).join('\n');
    expect(window).toMatch(/docker build --secret/);
    expect(window).toMatch(/id=GITLAB_TOKEN/);
  });
});

describe('generateEnv — no env vars at all', () => {
  test('still emits the Anthropic credential in the Required section', () => {
    const walks: WalkResult[] = [
      {
        path: '/r/empty.json',
        recipe: { name: 'no-vars', agent: { systemPrompt: 'just text' } },
      },
    ];
    const input: GeneratorInput = {
      walks,
      sources: [],
      envVars: [],
      options: DEFAULT_OPTIONS,
    };

    const out = generateEnv(input);

    expect(out).toMatch(/^ANTHROPIC_API_KEY=/m);
    expect(out).toMatch(/# --- Required/);
    expect(out).not.toContain('\r');
  });

  test('emits ANTHROPIC_AUTH_TOKEN as a commented alternative with either/or guidance', () => {
    const walks: WalkResult[] = [
      {
        path: '/r/empty.json',
        recipe: { name: 'no-vars', agent: { systemPrompt: 'just text' } },
      },
    ];
    const input: GeneratorInput = {
      walks,
      sources: [],
      envVars: [],
      options: DEFAULT_OPTIONS,
    };

    const out = generateEnv(input);

    // The alternative is commented out (operator uncomments to use it) —
    // never an uncommented assignment.
    expect(out).toMatch(/^# ANTHROPIC_AUTH_TOKEN=/m);
    expect(out).not.toMatch(/^ANTHROPIC_AUTH_TOKEN=/m);
    // Either/or guidance: set ONE; both-set preference is documented.
    expect(out).toMatch(/set ONE/);
    expect(out).toMatch(/prefers the auth token/);
    // The bearer-token nature is explained near the alternative.
    expect(out).toMatch(/OAuth bearer/);
  });
});

describe('generateEnv — recipe explicitly references a credential', () => {
  const walks: WalkResult[] = [
    {
      path: '/r/explicit.json',
      recipe: { name: 'explicit', agent: { systemPrompt: 'text' } },
    },
  ];

  test('explicit ${ANTHROPIC_AUTH_TOKEN} is emitted uncommented, no either/or guidance', () => {
    const envVars: EnvVar[] = [
      {
        name: 'ANTHROPIC_AUTH_TOKEN',
        usedIn: [{ recipePath: '/r/explicit.json', jsonPath: 'mcpServers.x.env.TOKEN' }],
      },
    ];
    const out = generateEnv({ walks, sources: [], envVars, options: DEFAULT_OPTIONS });

    // Demanded by name: uncommented assignment with a required-by-name note.
    expect(out).toMatch(/^ANTHROPIC_AUTH_TOKEN=/m);
    expect(out).not.toMatch(/^# ANTHROPIC_AUTH_TOKEN=/m);
    expect(out).toMatch(/required by name/);
    // The either/or guidance is dropped (conhost throws if the referenced
    // name is missing, so "set ONE" would mislead), and the API key is not
    // presented as required.
    expect(out).not.toMatch(/set ONE/);
    expect(out).not.toMatch(/^ANTHROPIC_API_KEY=/m);
  });

  test('explicit ${ANTHROPIC_API_KEY} is emitted uncommented by name, no either/or guidance', () => {
    const envVars: EnvVar[] = [
      {
        name: 'ANTHROPIC_API_KEY',
        usedIn: [{ recipePath: '/r/explicit.json', jsonPath: 'agent.env.KEY' }],
      },
    ];
    const out = generateEnv({ walks, sources: [], envVars, options: DEFAULT_OPTIONS });

    expect(out).toMatch(/^ANTHROPIC_API_KEY=/m);
    expect(out).toMatch(/required by name/);
    expect(out).not.toMatch(/set ONE/);
    // The auth token isn't offered as an alternative — it wouldn't satisfy
    // the recipe's explicit reference.
    expect(out).not.toMatch(/^#? ?ANTHROPIC_AUTH_TOKEN=/m);
  });

  test('defaulted ${ANTHROPIC_API_KEY:-x} keeps the either/or block', () => {
    const envVars: EnvVar[] = [
      {
        name: 'ANTHROPIC_API_KEY',
        usedIn: [{ recipePath: '/r/explicit.json', jsonPath: 'agent.env.KEY' }],
        defaultValue: 'unset',
      },
    ];
    const out = generateEnv({ walks, sources: [], envVars, options: DEFAULT_OPTIONS });

    // A defaulted reference never throws at startup, so the choice stays open.
    expect(out).toMatch(/set ONE/);
    expect(out).toMatch(/^# ANTHROPIC_AUTH_TOKEN=/m);
  });
});

describe('generateEnv — optional vars are commented out', () => {
  test('a recipe-referenced MODEL var lands in Optional, commented out', () => {
    const walks: WalkResult[] = [
      {
        path: '/r/model.json',
        recipe: {
          name: 'optional-model',
          agent: { systemPrompt: 'uses ${MODEL}' },
        },
      },
    ];
    const envVars: EnvVar[] = [
      {
        name: 'MODEL',
        usedIn: [{ recipePath: '/r/model.json', jsonPath: 'agent.systemPrompt' }],
      },
    ];
    const input: GeneratorInput = {
      walks,
      sources: [],
      envVars,
      options: DEFAULT_OPTIONS,
    };

    const out = generateEnv(input);

    // Should be commented out, not assigned uncommented.
    expect(out).toMatch(/^# MODEL=/m);
    expect(out).not.toMatch(/^MODEL=/m);
    // Optional section header should also exist.
    expect(out).toMatch(/# --- Optional/);
  });
});
