/**
 * Interactive prompts for cook build.
 *
 * Default mode: walk the missing required env vars + build-time secrets,
 * prompt the operator for each, return a Record<name, value> the caller
 * splices into a generated .env file.
 *
 * --no-prompts mode: scan process.env (and optionally an env-file), throw
 * on any missing required value.  No interactive output.
 *
 * The implicit provider requirement is intentionally short:
 *   - the Anthropic credential (membrane reads it directly from process.env):
 *     ANTHROPIC_API_KEY, satisfiable by the ANTHROPIC_AUTH_TOKEN alternative
 *     (long-lived OAuth bearer; connectome-host prefers it when both are set)
 *
 * Plus everything in input.envVars (recipe ${VAR} references) and every
 * source.authSecret (BuildKit secrets used at image-build time).
 */

import promptsLib from 'prompts';
import { existsSync, readFileSync } from 'node:fs';
import type { EnvVar, McpSource, WalkResult } from './types.js';

/** Only an explicitly Codex-only tree is known to need no Anthropic auth.
 * Omitted providers default to Anthropic at runtime; unknown routes and an
 * absent tree retain the existing requirement conservatively. Fleets that can
 * launch unwalked recipes also retain it; their providers are unknown. */
export function requiresAnthropicCredential(walks: WalkResult[]): boolean {
  return walks.length === 0 || walks.some((walk) => {
    if (walk.recipe.agent.provider !== 'openai-codex') return true;
    const fleet = walk.recipe.modules?.fleet;
    if (!fleet) return false;
    if (fleet === true) return true;
    const children = fleet.children ?? [];
    // Host disables its allowlist when neither explicit entries nor children
    // exist. Extra entries (including wildcards) permit unwalked providers.
    if (children.length === 0 && fleet.allowedRecipes === undefined) return true;
    return (fleet.allowedRecipes ?? []).some((entry) =>
      entry.includes('*') || !children.some((child) => child.recipe === entry),
    );
  });
}

/** A variable cook needs a value for. */
export interface RequiredVar {
  name: string;
  /** Where the value will be used — shown in the prompt. */
  consumer: string;
  /** What the value is for, in cook's pipeline:
   *   - 'runtime'         — recipe ${VAR}, ends up in .env, read by the agent
   *   - 'build-secret'    — mcpServers[*].source.authSecret, mounted via
   *                         BuildKit at clone-time
   *   - 'sidecar-secret'  — services[*].secrets[*], file at <outDir>/<NAME>
   *                         that compose mounts as a runtime secret */
  scope: 'runtime' | 'build-secret' | 'sidecar-secret';
  /** Optional placeholder shown as the default-but-don't-use suggestion. */
  placeholder?: string;
  /** When set, the recipe references this var as `${VAR:-default}` —
   *  cook treats it as optional (skipping prompts to that var doesn't
   *  block the build; the recipe loader applies the default at runtime). */
  defaultValue?: string;
  /** Alternative variable names that ALSO satisfy this requirement — e.g.
   *  ANTHROPIC_AUTH_TOKEN satisfies the ANTHROPIC_API_KEY requirement
   *  (connectome-host accepts either, preferring the auth token when both
   *  are set).  resolvePresent checks these after the primary name;
   *  promptForVars offers each in turn when the primary is skipped. */
  altNames?: string[];
}

/** Result: collected values plus a flag set when the user cancelled
 *  (Ctrl+C or empty input on a required field). */
export interface PromptResult {
  values: Record<string, string>;
  cancelled: boolean;
}

/** Build the list of variables that need a value, deduped by name.
 *  Includes:
 *    - ANTHROPIC_API_KEY (unless the tree is explicitly Codex-only), with
 *      ANTHROPIC_AUTH_TOKEN as an accepted alternative (altNames)
 *    - every envVar (recipe `${VAR}`)
 *    - every authSecret across sources (clone-time)
 *    - every sidecar service's secrets[] entries (runtime, written by cook
 *      to <outDir>/<NAME> for compose to bind into the sidecar)
 *
 *  Dedup keeps the first occurrence — runtime vars take precedence over
 *  build-secrets which take precedence over sidecar-secrets when names
 *  collide.  Cook's value-write paths still land the resolved value in
 *  every place it's needed (build-time secret file + .env), so the same
 *  operator-supplied value reaches each consumer. */
export function deriveRequiredVars(
  envVars: EnvVar[],
  sources: McpSource[],
  sidecarSecretNames: string[] = [],
  walks: WalkResult[] = [],
): RequiredVar[] {
  const out: RequiredVar[] = requiresAnthropicCredential(walks) ? [
    {
      name: 'ANTHROPIC_API_KEY',
      consumer: 'Anthropic SDK (membrane)',
      scope: 'runtime',
      placeholder: 'sk-ant-...',
      // OAuth bearer alternative — connectome-host accepts either credential
      // (and prefers the auth token when both are set).
      altNames: ['ANTHROPIC_AUTH_TOKEN'],
    },
  ] : [];
  for (const v of envVars) {
    const consumer = v.usedIn[0]
      ? `${v.usedIn[0].recipePath.split('/').pop()}:${v.usedIn[0].jsonPath}`
      : '<unknown>';
    const required: RequiredVar = {
      name: v.name,
      consumer,
      scope: 'runtime',
      placeholder: placeholderFor(v.name),
    };
    if (v.defaultValue !== undefined) required.defaultValue = v.defaultValue;
    out.push(required);
  }
  const seenSecrets = new Set<string>();
  for (const src of sources) {
    if (!src.authSecret || seenSecrets.has(src.authSecret)) continue;
    seenSecrets.add(src.authSecret);
    out.push({
      name: src.authSecret,
      consumer: `${src.url || src.key} (clone secret)`,
      scope: 'build-secret',
      placeholder: placeholderFor(src.authSecret),
    });
  }
  for (const name of sidecarSecretNames) {
    out.push({
      name,
      consumer: `sidecar runtime secret`,
      scope: 'sidecar-secret',
      placeholder: placeholderFor(name),
    });
  }
  // Dedupe by name (envVar may collide with a runtime var declared by us).
  // A collision without a recipe default means something demands this EXACT
  // name — conhost's substituteEnvVars throws at container start on a
  // truly-missing `${VAR}` — so an alternative name can no longer satisfy
  // the requirement: strip altNames from the kept entry.  (A `${VAR:-x}`
  // reference carries defaultValue and doesn't throw, so alternatives still
  // satisfy it.)
  const byName = new Map<string, RequiredVar>();
  for (const v of out) {
    const existing = byName.get(v.name);
    if (existing === undefined) {
      byName.set(v.name, v);
    } else if (existing.altNames !== undefined && v.defaultValue === undefined) {
      delete existing.altNames;
    }
  }
  return Array.from(byName.values());
}

/** Heuristic placeholder, mirrors env.ts's logic (loose duplication is OK
 *  here — env.ts produces .env.example, prompts produces .env). */
function placeholderFor(name: string): string {
  if (name === 'ANTHROPIC_API_KEY') return 'sk-ant-...';
  if (name === 'ANTHROPIC_AUTH_TOKEN') return 'sk-ant-oat...';
  if (/URL/.test(name)) return 'https://...';
  if (name.startsWith('GITLAB_')) return 'glpat-...';
  if (name.startsWith('GITHUB_')) return 'ghp_...';
  if (/(TOKEN|SECRET|KEY|PASSWORD)/i.test(name)) return '<secret>';
  return '<set me>';
}

/** Parse a dotenv-shaped file. Tolerant: ignores comments + blank lines.
 *  Doesn't support quoting or multi-line values — keep it simple; operators
 *  with complex values can edit `.env` directly. */
export function loadEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) {
    throw new Error(`env-file not found: ${path}`);
  }
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, 'utf-8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    out[key] = value;
  }
  return out;
}

/** Single source-of-truth precedence for resolving a variable's value.
 *  Order: --env-file > process.env > prompted/collected.  Used everywhere
 *  cook needs to look up a value (env-collector flow, sidecar secret
 *  files, container template rendering) so the same operator-supplied
 *  value lands in every artifact.  An empty string is treated as unset
 *  (operators occasionally `export FOO=` to clear a value).
 *
 *  Why envFile > processEnv: --env-file is the explicit "use these values
 *  for THIS cook run" intent; ambient process env is incidental.  When
 *  the operator says both, the explicit one wins. */
export function resolveValue(
  name: string,
  sources: {
    envFileValues?: Record<string, string>;
    processEnv?: NodeJS.ProcessEnv;
    promptedValues?: Record<string, string>;
  },
): string | undefined {
  const fromFile = sources.envFileValues?.[name];
  if (fromFile !== undefined && fromFile !== '') return fromFile;
  const fromEnv = (sources.processEnv ?? process.env)[name];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  const fromPrompt = sources.promptedValues?.[name];
  if (fromPrompt !== undefined && fromPrompt !== '') return fromPrompt;
  return undefined;
}

/** Resolve every required var via `resolveValue`.  Returns the values
 *  found and the names still missing.  Note: prompted values aren't in
 *  scope yet at this stage — only env-file + process.env are checked.
 *  After prompting, the caller merges prompted values into the bag and
 *  calls resolveValue per-name for any later lookup.
 *
 *  A var with `altNames` is satisfied when the primary name OR any
 *  alternative resolves; every name that resolves is recorded under its
 *  own key (so e.g. ANTHROPIC_AUTH_TOKEN lands in .env under its own name
 *  and connectome-host's both-set preference still applies downstream). */
export function resolvePresent(
  required: RequiredVar[],
  envFileValues: Record<string, string>,
): { found: Record<string, string>; missing: RequiredVar[] } {
  const found: Record<string, string> = {};
  const missing: RequiredVar[] = [];
  for (const v of required) {
    let satisfied = false;
    for (const name of [v.name, ...(v.altNames ?? [])]) {
      const value = resolveValue(name, { envFileValues });
      if (value !== undefined) {
        found[name] = value;
        satisfied = true;
      }
    }
    if (!satisfied) missing.push(v);
  }
  return { found, missing };
}

/** Interactive: prompt for every missing variable.  Returns values for the
 *  ones the user supplied; values left blank are omitted (the .env will
 *  contain a commented placeholder so the operator notices).
 *
 *  A var with `altNames` gets a hint in its prompt; skipping it (Enter)
 *  immediately offers each alternative in turn, so the operator can satisfy
 *  e.g. the Anthropic credential with ANTHROPIC_AUTH_TOKEN instead of
 *  ANTHROPIC_API_KEY without leaving the flow. */
export async function promptForVars(missing: RequiredVar[]): Promise<PromptResult> {
  if (missing.length === 0) return { values: {}, cancelled: false };

  process.stdout.write(`\nCook needs values for ${missing.length} variable${missing.length === 1 ? '' : 's'}.\n`);
  process.stdout.write('Press Enter to skip a var (it will land commented in .env).\n\n');

  const values: Record<string, string> = {};
  let cancelled = false;
  outer: for (const v of missing) {
    // Already supplied via an earlier entry's alt-flow (e.g. the operator
    // skipped ANTHROPIC_API_KEY and typed ANTHROPIC_AUTH_TOKEN, which also
    // sits in `missing` as its own recipe-derived entry) — don't re-prompt.
    if (values[v.name] !== undefined) continue;
    const scopeNote = v.scope === 'build-secret' ? ' [build-time secret]' : '';
    const optionalNote = v.defaultValue !== undefined
      ? ` [optional, default: ${JSON.stringify(v.defaultValue)}]`
      : '';
    const altNote = v.altNames && v.altNames.length > 0
      ? ` [or Enter to supply ${v.altNames.join(' / ')} instead]`
      : '';
    const response = await promptsLib({
      type: 'text',
      name: 'value',
      message: `${v.name}${scopeNote}${optionalNote}${altNote}\n  ${v.consumer}\n  ${v.placeholder ?? ''}\n`,
      initial: '',
    });
    if (response.value === undefined) {
      cancelled = true;
      break;
    }
    if (response.value !== '') {
      values[v.name] = response.value as string;
      continue;
    }
    // Primary skipped — offer each alternative name in turn until one is
    // supplied (or all are skipped, leaving the requirement unmet — same
    // outcome as skipping a plain var).
    for (const alt of v.altNames ?? []) {
      const altResponse = await promptsLib({
        type: 'text',
        name: 'value',
        message: `${alt} [alternative to ${v.name}]\n  ${v.consumer}\n  ${placeholderFor(alt)}\n`,
        initial: '',
      });
      if (altResponse.value === undefined) {
        cancelled = true;
        break outer;
      }
      if (altResponse.value !== '') {
        values[alt] = altResponse.value as string;
        break;
      }
    }
  }
  return { values, cancelled };
}

/** Confirm-before-write prompt.  Returns true to proceed.  Defaults to yes. */
export async function confirmWrite(outDir: string, fileCount: number): Promise<boolean> {
  const response = await promptsLib({
    type: 'confirm',
    name: 'go',
    message: `Write ${fileCount} files to ${outDir}?`,
    initial: true,
  });
  return response.go === true;
}

/** One field of a credential file the operator needs to fill in. */
export interface CredentialFileField {
  /** Where the field will be written: file path + field name within file. */
  filePath: string;
  fieldName: string;
  /** Optional env var that overrides the prompt (already-resolved values
   *  are filtered out before this list is passed to promptForCredentialFields). */
  envOverride?: string;
  description?: string;
  placeholder?: string;
  secret?: boolean;
}

/** Result: values keyed first by file path, then by field name. */
export interface CredentialPromptResult {
  values: Record<string, Record<string, string>>;
  cancelled: boolean;
}

/** Interactive: prompt for every missing credential-file field.  Masks
 *  secret fields.  Press Enter to skip; cook then warns rather than
 *  silently writing a half-complete file. */
export async function promptForCredentialFields(
  fields: CredentialFileField[],
): Promise<CredentialPromptResult> {
  if (fields.length === 0) return { values: {}, cancelled: false };

  process.stdout.write(`\nCook needs values for ${fields.length} credential-file field${fields.length === 1 ? '' : 's'}.\n`);
  process.stdout.write('Press Enter to skip a field (the file will be written without it).\n\n');

  const values: Record<string, Record<string, string>> = {};
  let cancelled = false;
  for (const f of fields) {
    const fileBase = f.filePath.replace(/^\.\//, '').replace(/^\/+/, '').split('/').pop() ?? f.filePath;
    const desc = f.description ? `  ${f.description}\n` : '';
    const placeholder = f.placeholder ? `  ${f.placeholder}\n` : '';
    const envHint = f.envOverride ? `  (set ${f.envOverride}=... in env to skip this prompt)\n` : '';
    const response = await promptsLib({
      type: f.secret ? 'password' : 'text',
      name: 'value',
      message: `${fileBase}::${f.fieldName}\n${desc}${placeholder}${envHint}`,
      initial: '',
    });
    if (response.value === undefined) {
      cancelled = true;
      break;
    }
    if (response.value !== '') {
      if (!values[f.filePath]) values[f.filePath] = {};
      values[f.filePath]![f.fieldName] = response.value as string;
    }
  }
  return { values, cancelled };
}
