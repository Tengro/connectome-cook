/**
 * Host-machine discovery — the `requirements` block.
 *
 * A requirement is "link against the existing mess on the machine": the
 * recipe names candidate paths (`probe`), cook checks which exist, suggests
 * the first hit, lets the operator confirm/override, and exposes the answer
 * as an env var (`exposeAs`, default: the key upper-snake-cased). The value
 * then flows like any other operator value: `${VAR}` substitution at
 * runtime, install-step environment at build time.
 *
 * Resolution precedence per requirement: env-file value > process.env value
 * > probe hit (confirmed interactively unless --no-prompts) > prompt with
 * no default. Unresolved + required → error; unresolved + optional → warn.
 */

import promptsLib from 'prompts';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { log } from './log.js';
import type { WalkResult } from './types.js';
import type { RecipeRequirement } from './vendor/recipe.js';

export interface ResolvedRequirement {
  /** Requirement key from the recipe. */
  name: string;
  /** Env var the value is exposed as. */
  envName: string;
  /** Resolved value; undefined when unresolved (only legal for optional). */
  value?: string;
  /** Whether the value came from a probe hit, the environment, or a prompt. */
  origin: 'env-file' | 'process-env' | 'probe' | 'prompt' | 'unresolved';
  required: boolean;
  /** Recipes that declared it (diagnostics). */
  declaredIn: string[];
}

export interface RequirementsResult {
  resolved: ResolvedRequirement[];
  cancelled: boolean;
}

/** `spring-engine` → `SPRING_ENGINE`. */
export function defaultEnvName(key: string): string {
  return key.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
}

/** Expand `~`, `$VAR`, and `${VAR}` against an environment map. Unset vars
 *  expand to '' (making the candidate unlikely to exist — correct). */
export function expandProbePath(p: string, env: Record<string, string | undefined>): string {
  let out = p;
  if (out === '~' || out.startsWith('~/')) {
    out = join(homedir(), out.slice(1));
  }
  out = out.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (_m, braced, bare) => env[braced ?? bare] ?? '');
  return out;
}

/** First existing probe candidate, expanded; undefined when none exist. */
export function firstProbeHit(
  probe: string[] | undefined,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  for (const candidate of probe ?? []) {
    const expanded = expandProbePath(candidate, env);
    if (expanded && existsSync(expanded)) return expanded;
  }
  return undefined;
}

/** Collect requirement declarations across the walked recipes, merged by
 *  key. Probe lists union in declaration order; first-write-wins on
 *  prompt/exposeAs; `required` is true if ANY declaration says so. */
export function collectRequirements(
  walks: WalkResult[],
): Array<{ name: string; req: RecipeRequirement; declaredIn: string[] }> {
  const byName = new Map<string, { name: string; req: RecipeRequirement; declaredIn: string[] }>();
  for (const walk of walks) {
    for (const [name, req] of Object.entries(walk.recipe.requirements ?? {})) {
      const existing = byName.get(name);
      if (!existing) {
        byName.set(name, { name, req: { ...req }, declaredIn: [walk.path] });
        continue;
      }
      existing.declaredIn.push(walk.path);
      if (req.probe) {
        existing.req.probe = [...new Set([...(existing.req.probe ?? []), ...req.probe])];
      }
      if (req.required === true) existing.req.required = true;
    }
  }
  return Array.from(byName.values());
}

/**
 * Resolve every requirement. Interactive confirmation of probe hits happens
 * only when a prompt would add information — a value already present in the
 * env-file or process.env is taken as the operator's explicit answer.
 */
export async function resolveRequirements(
  walks: WalkResult[],
  opts: { noPrompts: boolean; envFileValues: Record<string, string> },
): Promise<RequirementsResult> {
  const collected = collectRequirements(walks);
  const resolved: ResolvedRequirement[] = [];

  for (const { name, req, declaredIn } of collected) {
    const envName = req.exposeAs ?? defaultEnvName(name);
    const required = req.required !== false;
    const base: Omit<ResolvedRequirement, 'value' | 'origin'> = {
      name, envName, required, declaredIn,
    };

    const fromEnvFile = opts.envFileValues[envName];
    if (fromEnvFile !== undefined && fromEnvFile !== '') {
      resolved.push({ ...base, value: fromEnvFile, origin: 'env-file' });
      continue;
    }
    const fromProcess = process.env[envName];
    if (fromProcess !== undefined && fromProcess !== '') {
      resolved.push({ ...base, value: fromProcess, origin: 'process-env' });
      continue;
    }

    // Probe expansion sees env-file values too — `$SPRING_HOME/engine`
    // should work whether SPRING_HOME comes from the shell or --env-file.
    const hit = firstProbeHit(req.probe, { ...process.env, ...opts.envFileValues });
    if (opts.noPrompts) {
      if (hit !== undefined) {
        log.info(`requirement ${log.bold(name)}: probed ${log.dim(hit)} → ${envName}`);
        resolved.push({ ...base, value: hit, origin: 'probe' });
      } else {
        resolved.push({ ...base, origin: 'unresolved' });
      }
      continue;
    }

    const answer = await promptsLib({
      type: 'text',
      name: 'value',
      message: req.prompt ?? `Path for requirement "${name}" (exposed as ${envName})`,
      initial: hit ?? '',
    });
    if (answer.value === undefined) {
      // Ctrl+C / aborted prompt.
      return { resolved, cancelled: true };
    }
    const value = String(answer.value).trim();
    if (value === '') {
      resolved.push({ ...base, origin: 'unresolved' });
    } else {
      resolved.push({ ...base, value, origin: value === hit ? 'probe' : 'prompt' });
    }
  }

  return { resolved, cancelled: false };
}

/** Post-resolution policy: throw listing every unresolved REQUIRED
 *  requirement; warn for unresolved optional ones. */
export function enforceRequirements(resolved: ResolvedRequirement[]): void {
  const missing = resolved.filter((r) => r.required && r.value === undefined);
  for (const r of resolved) {
    if (!r.required && r.value === undefined) {
      log.warn(`requirement ${r.name}: unresolved (optional) — ${r.envName} stays unset`);
    }
  }
  if (missing.length > 0) {
    const lines = missing
      .map((r) => `  - ${r.name} (${r.envName}), declared in ${r.declaredIn.join(', ')}`)
      .join('\n');
    throw new Error(
      `Unresolved required requirement(s):\n${lines}\n` +
      `Supply a value (env var, --env-file, or interactive prompt) or mark the requirement "required": false.`,
    );
  }
}
