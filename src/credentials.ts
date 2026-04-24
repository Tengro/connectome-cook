/**
 * Credential file derivation, prompting, serialization.
 *
 * The recipe schema's `credentialFiles` field declares auxiliary files
 * each MCP server needs at runtime (e.g. `.zuliprc`, `.netrc`, a service-
 * account JSON).  Cook's job is to:
 *
 *   1. Walk the recipe tree and collect every (mcpServer, file) pair.
 *   2. For each field, resolve a value: env var override (when set) or
 *      interactive prompt.
 *   3. Serialize per the file's declared format (`ini` / `json` / `env`).
 *   4. Hand the path → content map back to cli.ts for write-out.
 *
 * Files are deduplicated by container path: if two MCP servers declare
 * the same `path` (e.g. two zulip-flavoured servers both using
 * `./.zuliprc`), the first wins.  Schema-side this is unusual — but we
 * dedupe defensively rather than write twice.
 */

import type { GeneratorInput, WalkResult } from './types.js';
import type {
  RecipeCredentialFile,
  RecipeCredentialFileField,
} from './vendor/recipe.js';

/** A credential file collected from the walked recipes, with provenance. */
export interface CredentialFileSpec {
  path: string;
  format: RecipeCredentialFile['format'];
  section?: string | undefined;
  mode?: string | undefined;
  fields: RecipeCredentialFileField[];
  /** Provenance for error messages + README — which (recipe, server) declared this. */
  declaredBy: Array<{ recipePath: string; mcpServerName: string }>;
}

/** Walk the recipe tree, collect all credential files keyed by path. */
export function collectCredentialFiles(walks: WalkResult[]): CredentialFileSpec[] {
  const byPath = new Map<string, CredentialFileSpec>();
  for (const walk of walks) {
    for (const [serverName, server] of Object.entries(walk.recipe.mcpServers ?? {})) {
      for (const cf of server.credentialFiles ?? []) {
        const existing = byPath.get(cf.path);
        if (existing) {
          existing.declaredBy.push({ recipePath: walk.path, mcpServerName: serverName });
          continue;
        }
        byPath.set(cf.path, {
          path: cf.path,
          format: cf.format,
          section: cf.section,
          mode: cf.mode,
          fields: cf.fields,
          declaredBy: [{ recipePath: walk.path, mcpServerName: serverName }],
        });
      }
    }
  }
  return Array.from(byPath.values());
}

/** Resolve the value for a field from process.env first, then the
 *  `--env-file` overrides Map, then return `undefined` (caller prompts). */
export function resolveFieldValue(
  field: RecipeCredentialFileField,
  envFileValues: Record<string, string>,
): string | undefined {
  if (!field.envOverride) return undefined;
  const fromEnv = process.env[field.envOverride];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  const fromFile = envFileValues[field.envOverride];
  if (fromFile !== undefined && fromFile !== '') return fromFile;
  return undefined;
}

/** Serialize one credential file's collected values per its format.
 *  Returns the file body (caller writes it).  Always ends with `\n`. */
export function serializeCredentialFile(
  spec: CredentialFileSpec,
  values: Record<string, string>,
): string {
  switch (spec.format) {
    case 'ini': return serializeIni(spec, values);
    case 'json': return serializeJson(spec, values);
    case 'env': return serializeEnv(spec, values);
  }
}

function serializeIni(spec: CredentialFileSpec, values: Record<string, string>): string {
  const lines: string[] = [];
  if (spec.section) lines.push(`[${spec.section}]`);
  for (const field of spec.fields) {
    const v = values[field.name] ?? '';
    lines.push(`${field.name}=${v}`);
  }
  return lines.join('\n') + '\n';
}

function serializeJson(spec: CredentialFileSpec, values: Record<string, string>): string {
  const obj: Record<string, string> = {};
  for (const field of spec.fields) {
    obj[field.name] = values[field.name] ?? '';
  }
  return JSON.stringify(obj, null, 2) + '\n';
}

function serializeEnv(spec: CredentialFileSpec, values: Record<string, string>): string {
  return spec.fields
    .map((f) => `${f.name}=${values[f.name] ?? ''}`)
    .join('\n') + '\n';
}

/** Container-path → host-path basename derivation.  The credential file's
 *  declared `path` is its in-container location (e.g. `./.zuliprc` →
 *  basename `.zuliprc`); on the host we write it directly into the cook
 *  output dir, and the compose generator binds it to the container path. */
export function hostFilename(spec: CredentialFileSpec): string {
  return spec.path.replace(/^\.\//, '').replace(/^\/+/, '').split('/').pop() ?? 'credential';
}

/** Container-path normalized to absolute form (`./foo` → `/app/foo` since
 *  the conductor's CWD inside the container is `/app`). */
export function containerPath(spec: CredentialFileSpec): string {
  if (spec.path.startsWith('/')) return spec.path;
  return '/app/' + spec.path.replace(/^\.\//, '').replace(/^\/+/, '');
}

/** Convenience: pull just the (path → spec) view useful for callers
 *  that already have a GeneratorInput. */
export function credentialFilesFromInput(input: GeneratorInput): CredentialFileSpec[] {
  return collectCredentialFiles(input.walks);
}
