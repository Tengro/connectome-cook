/**
 * Runtime-file assembly shared by the docker and host backends: the value
 * bag, rendered template files (sidecar `templateFiles[]` + top-level
 * `containerTemplateFiles[]`), sidecar secret files, and the
 * incomplete-template refusal policy.
 *
 * Backends differ only in WHERE each rendered file lands:
 *   - docker: `<outDir>/<relPath>` (compose bind-mounts it to `inContainer`),
 *     runtime-rendered ones as `<relPath>.tmpl` for the image entrypoint's
 *     envsubst.
 *   - host: sidecar templates at `<installDir>/<relPath>` (the sidecars-only
 *     compose file resolves relative sources against the install dir);
 *     container templates directly at the REBASED `inContainer` path
 *     (there's no mount — the agent reads the real file), runtime ones as
 *     `<rebased>.tmpl` for run.sh's envsubst.
 */

import { log } from '../log.js';
import { renderTemplate } from '../template.js';
import { resolveValue } from '../prompts.js';
import type { InstallPlan } from '../plan.js';

export interface RenderedRuntimeFile {
  kind: 'sidecar-template' | 'container-template';
  /** Output-dir-relative path (sidecar `tf.path` / container `tf.hostPath`). */
  relPath: string;
  /** Container-template target path (recipe `inContainer`); undefined for
   *  sidecar templates (compose mounts those per `volumes`). */
  inContainer?: string;
  content: string;
  mode: number;
  /** Names of vars referenced by the template that had no value. */
  missing: string[];
  /** Where this came from — for warning/error text. */
  origin: string;
  /** True when final rendering happens at start time (envsubst) — the
   *  written file gets a `.tmpl` suffix. */
  runtime: boolean;
}

/** Warn when a templated config file's host mode is more restrictive than
 *  group/other-readable.  Once bind-mounted (docker) the container can't
 *  chown it, so the runtime UID must match the writing host UID; 0644
 *  sidesteps the issue.  Soft warning — Linux/WSL2 UID-1000 setups work. */
export function warnIfRestrictiveTemplateMode(mode: number, origin: string): void {
  // Mode bits 0o044 = group-read + other-read.  If neither is set, only the
  // owner can read — which inside a container means only the matching UID.
  if ((mode & 0o044) === 0) {
    log.warn(
      `${origin}: mode 0${mode.toString(8)} is owner-only — the container's runtime UID must ` +
      `match the host UID that wrote this file, or the bind mount will be unreadable. ` +
      `Mode 0644 avoids the issue (the file lives in your build dir, which is already permission-protected).`,
    );
  }
}

/** Deterministic template value bag: process.env < env-file < prompts (the
 *  same precedence resolveValue applies per-name).  Built once because
 *  template rendering walks ALL `${VAR}` matches, not a known list. */
export function buildValueBag(plan: InstallPlan): Record<string, string> {
  const valueBag: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && v !== '') valueBag[k] = v;
  }
  for (const [k, v] of Object.entries(plan.envFileValues)) {
    if (v !== '') valueBag[k] = v;  // env-file overrides process.env
  }
  for (const [k, v] of Object.entries(plan.values)) {
    if (v !== '' && valueBag[k] === undefined) valueBag[k] = v;  // prompts only fill gaps
  }
  return valueBag;
}

/**
 * Render every declared template file. Sidecar `templateFiles[]` always
 * render fully at cook time; `containerTemplateFiles[]` honor
 * `runtimeRender` (full passthrough) and `runtimeVars` (protect the listed
 * names, substitute the rest — POSIX envsubst can't do `${VAR:-default}`,
 * so defaults must resolve here).
 */
export function renderRuntimeFiles(
  plan: InstallPlan,
  valueBag: Record<string, string>,
): RenderedRuntimeFile[] {
  const rendered: RenderedRuntimeFile[] = [];
  const sidecars = plan.parentWalk.recipe.services ?? [];

  for (const svc of sidecars) {
    for (const tf of svc.templateFiles ?? []) {
      const { rendered: content, missing } = renderTemplate(tf.template, valueBag);
      const mode = tf.mode ? parseInt(tf.mode, 8) : 0o644;
      const origin = `services[${svc.name}].templateFiles[${tf.path}]`;
      warnIfRestrictiveTemplateMode(mode, origin);
      rendered.push({
        kind: 'sidecar-template',
        relPath: tf.path,
        content,
        mode,
        missing,
        origin,
        runtime: false,
      });
    }
  }

  for (const tf of plan.parentWalk.recipe.containerTemplateFiles ?? []) {
    const mode = tf.mode ? parseInt(tf.mode, 8) : 0o644;
    const originBase = `containerTemplateFiles[${tf.hostPath} → ${tf.inContainer}]`;
    const runtimeVars = tf.runtimeVars ?? [];
    warnIfRestrictiveTemplateMode(mode, `containerTemplateFiles[${tf.hostPath}]`);
    if (tf.runtimeRender && runtimeVars.length === 0) {
      // Full-file passthrough — no substitution at cook time.
      rendered.push({
        kind: 'container-template',
        relPath: tf.hostPath,
        inContainer: tf.inContainer,
        content: tf.template,
        mode,
        missing: [],
        origin: `${originBase} (runtimeRender)`,
        runtime: true,
      });
    } else if (runtimeVars.length > 0) {
      // Partial — substitute everything except the runtimeVars list; those
      // stay as literal `${NAME}` for the start-time envsubst.
      const { rendered: content, missing } = renderTemplate(tf.template, valueBag, {
        protectedVars: runtimeVars,
      });
      rendered.push({
        kind: 'container-template',
        relPath: tf.hostPath,
        inContainer: tf.inContainer,
        content,
        mode,
        missing,
        origin: `${originBase} (runtimeVars=[${runtimeVars.join(',')}])`,
        runtime: true,
      });
    } else {
      const { rendered: content, missing } = renderTemplate(tf.template, valueBag);
      rendered.push({
        kind: 'container-template',
        relPath: tf.hostPath,
        inContainer: tf.inContainer,
        content,
        mode,
        missing,
        origin: originBase,
        runtime: false,
      });
    }
  }

  return rendered;
}

/**
 * Incomplete-template policy: refuse by default (an empty
 * `${WIKI_SECRET_KEY}` is a predictable-CSRF wiki), warn-per-file when the
 * operator explicitly allowed it. Returns false when the caller must abort.
 */
export function enforceCompleteTemplates(
  rendered: RenderedRuntimeFile[],
  allowIncomplete: boolean,
): boolean {
  const incomplete = rendered.filter((t) => t.missing.length > 0);
  if (incomplete.length === 0) return true;
  if (!allowIncomplete) {
    log.error(
      `${incomplete.length} template${incomplete.length === 1 ? '' : 's'} ` +
      `would render with EMPTY values for required variables — this is almost certainly insecure ` +
      `(e.g. an empty MediaWiki secret key produces predictable CSRF tokens).  Refusing to write.`,
    );
    for (const t of incomplete) {
      log.error(`    ${t.origin}: missing ${t.missing.join(', ')}`);
    }
    log.error(
      `Either set the missing values (process.env, --env-file, or interactive prompt) ` +
      `or pass --allow-incomplete-templates to write them anyway.`,
    );
    return false;
  }
  for (const t of incomplete) {
    log.warn(
      `${t.origin}: WROTE INSECURE — ${t.missing.length} variable${t.missing.length === 1 ? '' : 's'} ` +
      `unset, rendered as empty: ${t.missing.join(', ')}`,
    );
  }
  return true;
}

/** Sidecar runtime secret files: one per unique secret name across the
 *  parent's services, minus names in `alreadySeen` (docker dedupes against
 *  build-time authSecrets — same name, same file). Missing values warn. */
export function collectSidecarSecretFiles(
  plan: InstallPlan,
  alreadySeen: Set<string>,
  missingHint: string,
): Array<{ name: string; value: string }> {
  const files: Array<{ name: string; value: string }> = [];
  const seen = new Set<string>(alreadySeen);
  for (const svc of plan.parentWalk.recipe.services ?? []) {
    for (const secName of svc.secrets ?? []) {
      if (seen.has(secName)) continue;
      seen.add(secName);
      const value = resolveValue(secName, {
        envFileValues: plan.envFileValues,
        promptedValues: plan.values,
      });
      if (value !== undefined) {
        files.push({ name: secName, value });
      } else {
        log.warn(`sidecar secret ${secName}: no value supplied — file skipped (${missingHint})`);
      }
    }
  }
  return files;
}
