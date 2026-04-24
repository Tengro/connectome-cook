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
 * The "always required" list is intentionally short:
 *   - ANTHROPIC_API_KEY (membrane reads it directly from process.env)
 *
 * Plus everything in input.envVars (recipe ${VAR} references) and every
 * source.authSecret (BuildKit secrets used at image-build time).
 */

import promptsLib from 'prompts';
import { existsSync, readFileSync } from 'node:fs';
import type { EnvVar, McpSource } from './types.js';

/** A variable cook needs a value for. */
export interface RequiredVar {
  name: string;
  /** Where the value will be used — shown in the prompt. */
  consumer: string;
  /** Build-time secret (passed via --secret) vs runtime env var (.env). */
  scope: 'runtime' | 'build-secret';
  /** Optional placeholder shown as the default-but-don't-use suggestion. */
  placeholder?: string;
}

/** Result: collected values plus a flag set when the user cancelled
 *  (Ctrl+C or empty input on a required field). */
export interface PromptResult {
  values: Record<string, string>;
  cancelled: boolean;
}

/** Build the list of variables that need a value, deduped by name. */
export function deriveRequiredVars(envVars: EnvVar[], sources: McpSource[]): RequiredVar[] {
  const out: RequiredVar[] = [
    {
      name: 'ANTHROPIC_API_KEY',
      consumer: 'Anthropic SDK (membrane)',
      scope: 'runtime',
      placeholder: 'sk-ant-...',
    },
  ];
  for (const v of envVars) {
    const consumer = v.usedIn[0]
      ? `${v.usedIn[0].recipePath.split('/').pop()}:${v.usedIn[0].jsonPath}`
      : '<unknown>';
    out.push({ name: v.name, consumer, scope: 'runtime', placeholder: placeholderFor(v.name) });
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
  // Dedupe by name (envVar may collide with a runtime var declared by us).
  const byName = new Map<string, RequiredVar>();
  for (const v of out) {
    if (!byName.has(v.name)) byName.set(v.name, v);
  }
  return Array.from(byName.values());
}

/** Heuristic placeholder, mirrors env.ts's logic (loose duplication is OK
 *  here — env.ts produces .env.example, prompts produces .env). */
function placeholderFor(name: string): string {
  if (name === 'ANTHROPIC_API_KEY') return 'sk-ant-...';
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

/** Resolve every required var by checking process.env first, then envFile.
 *  Returns the values found and the names still missing. */
export function resolvePresent(
  required: RequiredVar[],
  envFileValues: Record<string, string>,
): { found: Record<string, string>; missing: RequiredVar[] } {
  const found: Record<string, string> = {};
  const missing: RequiredVar[] = [];
  for (const v of required) {
    const fromEnv = process.env[v.name];
    const fromFile = envFileValues[v.name];
    if (fromEnv !== undefined && fromEnv !== '') {
      found[v.name] = fromEnv;
    } else if (fromFile !== undefined && fromFile !== '') {
      found[v.name] = fromFile;
    } else {
      missing.push(v);
    }
  }
  return { found, missing };
}

/** Interactive: prompt for every missing variable.  Returns values for the
 *  ones the user supplied; values left blank are omitted (the .env will
 *  contain a commented placeholder so the operator notices). */
export async function promptForVars(missing: RequiredVar[]): Promise<PromptResult> {
  if (missing.length === 0) return { values: {}, cancelled: false };

  process.stdout.write(`\nCook needs values for ${missing.length} variable${missing.length === 1 ? '' : 's'}.\n`);
  process.stdout.write('Press Enter to skip a var (it will land commented in .env).\n\n');

  const values: Record<string, string> = {};
  let cancelled = false;
  for (const v of missing) {
    const scopeNote = v.scope === 'build-secret' ? ' [build-time secret]' : '';
    const response = await promptsLib({
      type: 'text',
      name: 'value',
      message: `${v.name}${scopeNote}\n  ${v.consumer}\n  ${v.placeholder ?? ''}\n`,
      initial: '',
    });
    if (response.value === undefined) {
      cancelled = true;
      break;
    }
    if (response.value !== '') {
      values[v.name] = response.value as string;
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
