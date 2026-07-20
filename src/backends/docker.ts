/**
 * Docker backend — materializes an InstallPlan as the classic cook artifact
 * bundle: Dockerfile, docker-compose.yml, .env(.example), README,
 * entrypoint, credential/secret files, rendered templates, bundled local
 * extensions, and the lowered configurations under recipes/.
 *
 * Interaction policy: the plan already collected every operator value; the
 * only prompt here is the final confirm-before-write gate (skipped under
 * --no-prompts).
 */

import { basename, dirname, join, resolve, sep } from 'node:path';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { log } from '../log.js';
import type { BuildOptions, GeneratorInput } from '../types.js';
import type { Recipe } from '../vendor/recipe.js';
import type { InstallPlan } from '../plan.js';
import { generateDockerfile } from '../generators/dockerfile.js';
import { generateCompose } from '../generators/compose.js';
import { generateOverlays } from '../generators/overlay.js';
import { generateEnv } from '../generators/env.js';
import { generateReadme } from '../generators/readme.js';
import { generateEntrypoint } from '../generators/entrypoint.js';
import { confirmWrite, resolveValue } from '../prompts.js';
import { hostFilename, serializeCredentialFile } from '../credentials.js';
import { lowerToConfiguration, recipeFilename } from '../configuration.js';
import { renderTemplate } from '../template.js';

export interface DockerBackendOptions extends BuildOptions {
  /** Write templated config files even when `${VAR}` references render
   *  empty (default: refuse the build). */
  allowIncompleteTemplates: boolean;
}

/** Result of the docker backend (used by both build and run handlers). */
export interface BuildResult {
  exitCode: number;
  outDir: string;
}

/** Quote a value for safe inclusion in a `.env` file consumed by
 *  docker-compose.  Compose interpolates `${VAR}` patterns AND certain
 *  backslash sequences in unquoted values, so any value containing `$`
 *  must be quoted to prevent compose from trying to expand substrings
 *  like `${M5qt58t}` from inside a token.  We use single quotes when
 *  possible (literal — no escapes), and fall back to double quotes with
 *  `\$ \" \\` escapes when the value itself contains a single quote.
 *
 *  NB: distinct from `quoteForComposeEnvBlock` (compose.ts) — that one
 *  formats values for compose YAML's `environment:` block, where compose
 *  STILL wants to interpolate `${VAR}` (so `$` is left unescaped).
 *  Different file format, different rules; they do NOT share a core. */
function escapeForEnvFile(value: string): string {
  // No special chars at all: write bare for readability.
  if (!/[$'"#`\\\s]/.test(value)) return value;
  // Single-quoted: literal everything except `'` itself.
  if (!value.includes("'")) return `'${value}'`;
  // Has both `'` and (likely) `$` — switch to double-quoted with escapes.
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$');
  return `"${escaped}"`;
}

/** Warn when a templated config file's host mode is more restrictive than
 *  group/other-readable.  Cook can't help past this point — once docker
 *  bind-mounts the file (especially as `:ro`), the container can't chown
 *  it, so the runtime UID inside the container must already match the host
 *  UID that wrote the file.  Mode 0644 sidesteps the issue.
 *
 *  This is a soft warning, not a refusal: operators on Linux/WSL2 with the
 *  default UID 1000 happen to match `bun`'s UID 1000 in the oven/bun
 *  image, so 0600 works for them.  CI runners + macOS Docker Desktop +
 *  rootless docker hit the breakage. */
function warnIfRestrictiveTemplateMode(mode: number, origin: string): void {
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

/** Render a `.env` file body from collected key/value pairs.  Sorted by
 *  key for determinism; each line `KEY=value` with a trailing newline.
 *  Values are quoted/escaped per `escapeForEnvFile` so compose's
 *  interpolation doesn't misread `${...}` substrings inside tokens. */
function renderEnvFile(values: Record<string, string>): string {
  const keys = Object.keys(values).sort();
  return keys.map((k) => `${k}=${escapeForEnvFile(values[k]!)}`).join('\n')
    + (keys.length ? '\n' : '');
}

/** Materialize the plan into `options.outDir`. */
export async function runDockerBackend(
  plan: InstallPlan,
  options: DockerBackendOptions,
): Promise<BuildResult> {
  const {
    walks,
    parentWalk,
    sources,
    localExtensions,
    envVars,
    credentialFiles,
    values: collectedValues,
    envFileValues,
    credentialValues,
  } = plan;
  const outDir = options.outDir;

  const input: GeneratorInput = { walks, sources, localExtensions, envVars, options };

  log.step(`generating artifacts → ${log.dim(outDir)}`);
  let dockerfile: string;
  let compose: string;
  let envExample: string;
  let readme: string;
  let entrypoint: string;
  let overlays: Map<string, Partial<Recipe>>;
  try {
    dockerfile = generateDockerfile(input);
    compose = generateCompose(input);
    envExample = generateEnv(input);
    readme = generateReadme(input);
    entrypoint = generateEntrypoint(input);
    overlays = generateOverlays(input);
  } catch (err) {
    log.error(`generator failed: ${err instanceof Error ? err.message : String(err)}`);
    return { exitCode: 2, outDir };
  }

  const recipesOut = walks.map((walk) => ({
    filename: recipeFilename(walk.path),
    content: JSON.stringify(
      lowerToConfiguration(walk.recipe, overlays.get(walk.path)),
      null,
      2,
    ) + '\n',
  }));

  // Only write .env if we have values worth writing — otherwise the
  // operator gets only .env.example to copy/edit themselves.
  const writeEnvFile = Object.keys(collectedValues).length > 0;

  // Credential files we have AT LEAST ONE value for; complete-skip files
  // get omitted so the operator notices via the warn rather than getting
  // a half-empty .zuliprc that fails confusingly at runtime.
  const credFilesToWrite = credentialFiles.filter((cf) =>
    Object.keys(credentialValues[cf.path] ?? {}).length === cf.fields.length,
  );
  const credFilesPartial = credentialFiles.filter((cf) => {
    const got = Object.keys(credentialValues[cf.path] ?? {}).length;
    return got > 0 && got < cf.fields.length;
  });
  for (const cf of credFilesPartial) {
    log.warn(
      `${cf.path}: only partial values supplied (${Object.keys(credentialValues[cf.path] ?? {}).length}/${cf.fields.length}) — file skipped`,
    );
  }

  // BuildKit secret files: one per unique authSecret across sources.
  // The compose `secrets:` block expects each token in `<outDir>/<NAME>`.
  // We've already collected the values via prompts/env-file/process.env
  // (authSecrets dedupe with same-named recipe vars in deriveRequiredVars),
  // so cook just writes them out — no extra operator step.
  const authSecretFiles: Array<{ name: string; value: string }> = [];
  const seenAuthSecrets = new Set<string>();
  const missingAuthSecrets: string[] = [];
  for (const src of sources) {
    if (!src.authSecret || seenAuthSecrets.has(src.authSecret)) continue;
    seenAuthSecrets.add(src.authSecret);
    const value = collectedValues[src.authSecret];
    if (value !== undefined && value !== '') {
      authSecretFiles.push({ name: src.authSecret, value });
    } else {
      missingAuthSecrets.push(src.authSecret);
    }
  }
  for (const name of missingAuthSecrets) {
    log.warn(
      `build secret ${name}: no value supplied — file skipped (operator must \`echo ... > ${outDir}/${name} && chmod 600 ${name}\` before \`docker compose build\`)`,
    );
  }

  // Sidecar runtime secrets.  Sidecars are folded into the plan's prompt
  // pipeline (see resolvePlan), so by this point any value the operator was
  // going to supply is already in collectedValues.  Just enumerate, resolve
  // via the shared helper, and collect file-write entries.
  const sidecars = parentWalk.recipe.services ?? [];
  const sidecarSecretFiles: Array<{ name: string; value: string }> = [];
  const seenSidecarSecretNames = new Set<string>(seenAuthSecrets);
  const missingSidecarSecrets: string[] = [];
  for (const svc of sidecars) {
    for (const secName of svc.secrets ?? []) {
      if (seenSidecarSecretNames.has(secName)) continue;
      seenSidecarSecretNames.add(secName);
      const value = resolveValue(secName, {
        envFileValues,
        promptedValues: collectedValues,
      });
      if (value !== undefined) {
        sidecarSecretFiles.push({ name: secName, value });
      } else {
        missingSidecarSecrets.push(secName);
      }
    }
  }
  for (const name of missingSidecarSecrets) {
    log.warn(
      `sidecar secret ${name}: no value supplied — file skipped (operator must hand-place \`${outDir}/${name}\` mode 0600 before \`docker compose up\`)`,
    );
  }

  // Templated config files (sidecar `templateFiles[]` + top-level
  // `containerTemplateFiles[]`).  Same value-bag as everything else, same
  // precedence (env-file > process.env > prompts) via resolveValue.
  // Anything still missing renders as empty string + warn — and if the
  // resulting template is missing values, we refuse the write rather than
  // emit a half-broken security-critical config (e.g. empty $wgSecretKey).
  interface RenderedTemplate {
    path: string;
    content: string;
    mode: number;
    /** Names of vars referenced by the template that had no value. */
    missing: string[];
    /** Where this came from — for the warning text. */
    origin: string;
  }
  const renderedTemplates: RenderedTemplate[] = [];
  // Build the lookup bag once, deterministically — the same precedence
  // resolveValue would apply if asked per-name.  Used because template
  // rendering walks ALL `${VAR}` matches in the body, not a known list.
  const valueBag: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && v !== '') valueBag[k] = v;
  }
  for (const [k, v] of Object.entries(envFileValues)) {
    if (v !== '') valueBag[k] = v;  // env-file overrides process.env
  }
  for (const [k, v] of Object.entries(collectedValues)) {
    if (v !== '' && valueBag[k] === undefined) valueBag[k] = v;  // prompts only fill gaps
  }
  for (const svc of sidecars) {
    for (const tf of svc.templateFiles ?? []) {
      const { rendered, missing } = renderTemplate(tf.template, valueBag);
      const mode = tf.mode ? parseInt(tf.mode, 8) : 0o644;
      warnIfRestrictiveTemplateMode(mode, `services[${svc.name}].templateFiles[${tf.path}]`);
      renderedTemplates.push({
        path: tf.path,
        content: rendered,
        mode,
        missing,
        origin: `services[${svc.name}].templateFiles[${tf.path}]`,
      });
    }
  }

  // Top-level containerTemplateFiles — generated config files cook
  // bind-mounts into the agent container.  Same render path; compose
  // generator emits the bind volume.  Named distinctly from per-sidecar
  // `templateFiles` (which uses `path`-only shape).
  //
  // runtimeRender entries skip cook-time substitution entirely — the
  // template body is written verbatim with `${VAR}` placeholders intact,
  // and the host filename gets a `.tmpl` suffix.  The conhost entrypoint
  // runs envsubst at container start to fill values that only exist at
  // runtime (e.g. a bot password generated by a bootstrap sidecar).
  //
  // runtimeVars entries do cook-time substitution for EVERY var EXCEPT
  // those named — those stay as literal `${NAME}` for the entrypoint to
  // fill.  POSIX envsubst doesn't understand `${VAR:-default}`, so this
  // is the right shape when most placeholders need defaults (which only
  // cook's substituter handles) and only a small set is truly runtime-only.
  const containerTemplateFiles = parentWalk.recipe.containerTemplateFiles ?? [];
  for (const tf of containerTemplateFiles) {
    const mode = tf.mode ? parseInt(tf.mode, 8) : 0o644;
    const originBase = `containerTemplateFiles[${tf.hostPath} → ${tf.inContainer}]`;
    const runtimeVars = tf.runtimeVars ?? [];
    if (tf.runtimeRender && runtimeVars.length === 0) {
      // Full-file passthrough — no substitution at cook time.
      warnIfRestrictiveTemplateMode(mode, `containerTemplateFiles[${tf.hostPath}]`);
      renderedTemplates.push({
        path: `${tf.hostPath}.tmpl`,
        content: tf.template,
        mode,
        missing: [],
        origin: `${originBase} (runtimeRender)`,
      });
    } else if (runtimeVars.length > 0) {
      // Partial — substitute everything except the runtimeVars list.
      // protectedVars makes renderTemplate emit literal `${NAME}` for
      // those names so the conhost entrypoint can envsubst them at
      // startup; everything else (including `${VAR:-default}` forms)
      // gets resolved here at cook time.
      const { rendered, missing } = renderTemplate(tf.template, valueBag, {
        protectedVars: runtimeVars,
      });
      warnIfRestrictiveTemplateMode(mode, `containerTemplateFiles[${tf.hostPath}]`);
      renderedTemplates.push({
        path: `${tf.hostPath}.tmpl`,
        content: rendered,
        mode,
        missing,
        origin: `${originBase} (runtimeVars=[${runtimeVars.join(',')}])`,
      });
    } else {
      const { rendered, missing } = renderTemplate(tf.template, valueBag);
      warnIfRestrictiveTemplateMode(mode, `containerTemplateFiles[${tf.hostPath}]`);
      renderedTemplates.push({
        path: tf.hostPath,
        content: rendered,
        mode,
        missing,
        origin: originBase,
      });
    }
  }

  // Refuse to write incomplete templates by default.  Operators can
  // override with --allow-incomplete-templates if they actually want a
  // template with empty `${VAR}` substitutions (rare; useful for
  // bootstrapping or debugging).  This catches the security-critical
  // case where `${WIKI_SECRET_KEY}` would render as empty and produce
  // a MediaWiki with a predictable secret key.
  const incompleteTemplates = renderedTemplates.filter((t) => t.missing.length > 0);
  if (incompleteTemplates.length > 0 && !options.allowIncompleteTemplates) {
    log.error(
      `${incompleteTemplates.length} template${incompleteTemplates.length === 1 ? '' : 's'} ` +
      `would render with EMPTY values for required variables — this is almost certainly insecure ` +
      `(e.g. an empty MediaWiki secret key produces predictable CSRF tokens).  Refusing to write.`,
    );
    for (const t of incompleteTemplates) {
      log.error(`    ${t.origin}: missing ${t.missing.join(', ')}`);
    }
    log.error(
      `Either set the missing values (process.env, --env-file, or interactive prompt) ` +
      `or pass --allow-incomplete-templates to write them anyway.`,
    );
    return { exitCode: 2, outDir };
  }
  // Even when allowed, surface a clear warning per affected template.
  for (const t of incompleteTemplates) {
    log.warn(
      `${t.origin}: WROTE INSECURE — ${t.missing.length} variable${t.missing.length === 1 ? '' : 's'} ` +
      `unset, rendered as empty: ${t.missing.join(', ')}`,
    );
  }

  const fileCount = 5
    + recipesOut.length
    + (writeEnvFile ? 1 : 0)
    + credFilesToWrite.length
    + authSecretFiles.length
    + sidecarSecretFiles.length
    + renderedTemplates.length
    + localExtensions.length;

  // Confirm-before-write gate.  Skipped in --no-prompts mode (the operator
  // told us to be non-interactive; bombing into a confirm prompt would
  // defeat the flag's purpose).
  if (!options.noPrompts) {
    const ok = await confirmWrite(outDir, fileCount);
    if (!ok) {
      log.warn('cancelled by user');
      return { exitCode: 1, outDir };
    }
  }

  try {
    mkdirSync(outDir, { recursive: true });
    mkdirSync(join(outDir, 'recipes'), { recursive: true });
    writeFileSync(join(outDir, 'Dockerfile'), dockerfile);
    writeFileSync(join(outDir, 'docker-compose.yml'), compose);
    writeFileSync(join(outDir, '.env.example'), envExample);
    writeFileSync(join(outDir, 'README.md'), readme);
    writeFileSync(join(outDir, 'entrypoint.sh'), entrypoint, { mode: 0o755 });
    if (writeEnvFile) {
      writeFileSync(join(outDir, '.env'), renderEnvFile(collectedValues));
    }
    for (const cf of credFilesToWrite) {
      const filename = hostFilename(cf);
      const content = serializeCredentialFile(cf, credentialValues[cf.path] ?? {});
      const mode = cf.mode ? parseInt(cf.mode, 8) : 0o600;
      writeFileSync(join(outDir, filename), content, { mode });
    }
    for (const sec of authSecretFiles) {
      // BuildKit reads the file content verbatim as the secret value —
      // no quoting, no trailing newline (some tools care).
      writeFileSync(join(outDir, sec.name), sec.value, { mode: 0o600 });
    }
    for (const sec of sidecarSecretFiles) {
      // Same file shape as build-time secrets; docker secrets reads
      // the file content as the secret value.
      writeFileSync(join(outDir, sec.name), sec.value, { mode: 0o600 });
    }
    for (const tf of renderedTemplates) {
      const fullPath = join(outDir, tf.path);
      // Defense-in-depth: validator already rejects paths with `..` /
      // leading `/`, but a future change could regress.  Verify the
      // resolved path stays inside outDir before writing.
      const resolvedFull = resolve(fullPath);
      const resolvedOut = resolve(outDir);
      if (resolvedFull !== resolvedOut && !resolvedFull.startsWith(resolvedOut + sep)) {
        throw new Error(
          `templateFile path "${tf.path}" resolves outside outDir (${resolvedFull} vs ${resolvedOut}) — refusing to write`,
        );
      }
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, tf.content, { mode: tf.mode });
    }
    for (const { filename, content } of recipesOut) {
      writeFileSync(join(outDir, 'recipes', filename), content);
    }
    // Local extension bundles: copy the entry file's directory from the
    // operator's disk into the build context. node_modules and .git are
    // excluded — the image resolves deps against /app/node_modules (plus a
    // fresh `bun install` when the bundle carries a package.json).
    for (const ext of localExtensions) {
      const target = join(outDir, 'extensions', ext.name);
      rmSync(target, { recursive: true, force: true });
      cpSync(ext.hostDir, target, {
        recursive: true,
        filter: (src) => {
          const base = basename(src);
          return base !== 'node_modules' && base !== '.git';
        },
      });
    }
  } catch (err) {
    log.error(`write failed: ${err instanceof Error ? err.message : String(err)}`);
    return { exitCode: 3, outDir };
  }

  const overlayCount = Array.from(overlays.values()).length;
  log.success(`wrote ${fileCount} files to ${outDir}`);
  if (overlayCount > 0) {
    log.info(log.dim(`    (${overlayCount} recipe${overlayCount === 1 ? '' : 's'} have overlays applied)`));
  }
  return { exitCode: 0, outDir };
}
