/**
 * Host backend — materializes an InstallPlan directly onto the operator's
 * machine instead of into a docker image. This is the "link against the
 * existing mess on the machine" mode: components build against locally
 * discovered paths (requirements), local extensions are used in place, and
 * the result is a directory an operator can run without docker.
 *
 * Layout (mirrors the container layout so the overlay machinery — which
 * thinks in terms of `inContainerPath` — applies verbatim, just rebased):
 *
 *   <installDir>/
 *     app/                     # connectome-host checkout, bun install'd
 *     app/extensions/<name>/   # git-sourced extensions
 *     <repo-basename>/         # MCP source checkouts (mirrors /<basename>)
 *     recipes/                 # lowered configurations
 *     .env                     # operator values (shell-sourceable)
 *     run.sh                   # launcher: source .env, cd app, bun src/index.ts
 *     connectome.lock          # record of what was materialized
 *
 * SAFETY: unlike the docker backend (whose install commands run inside a
 * throwaway build container), this backend executes clone/build commands on
 * the operator's machine. The action plan is therefore printed in full and
 * explicitly confirmed before anything runs. Non-interactive runs require
 * --yes; --no-prompts alone refuses.
 *
 * Idempotent reconcile: a component whose url+ref+install match the existing
 * lockfile AND whose target directory exists is skipped. Everything else is
 * re-cloned fresh (rm -rf + clone); a failed build removes its target so a
 * half-built checkout can never satisfy a later reconcile. Local extensions
 * are never copied — the configuration points at the operator's own
 * directory. Sibling-copy sources ARE copied (recipe-adjacent checkout →
 * installDir), mirroring the docker COPY.
 */

import { execFileSync, execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import promptsLib from 'prompts';
import { log } from '../log.js';
import type { GeneratorInput, McpSource } from '../types.js';
import type { Recipe } from '../vendor/recipe.js';
import type { InstallPlan } from '../plan.js';
import { generateOverlays } from '../generators/overlay.js';
import { generateSidecarCompose } from '../generators/compose.js';
import { lowerToConfiguration, recipeFilename } from '../configuration.js';
import {
  buildValueBag,
  collectSidecarSecretFiles,
  enforceCompleteTemplates,
  renderRuntimeFiles,
} from './runtime-files.js';
import { serializeCredentialFile } from '../credentials.js';
import {
  LOCKFILE_NAME,
  readLockfile,
  writeLockfile,
  type Lockfile,
  type LockedComponent,
} from '../lockfile.js';
import type { BuildResult } from './docker.js';

export interface HostBackendOptions {
  /** Install root. Default: ~/.connectome/installs/<slug>. */
  installDir: string;
  /** Non-interactive mode (no prompts at all). */
  noPrompts: boolean;
  /** Skip the confirm gate (REQUIRED for non-interactive installs). */
  yes: boolean;
  /** connectome-host clone source. */
  chRepoUrl: string;
  chRef: string;
  /** Pinned connectome-host commit (--pin-refs). */
  chCommit?: string;
  /** Write templated config files even when `${VAR}` references render
   *  empty (default: refuse the install). */
  allowIncompleteTemplates: boolean;
}

export { DEFAULT_CH_REF, DEFAULT_CH_REPO_URL } from '../generators/dockerfile.js';

// ---------------------------------------------------------------------------
// Action planning (pure — unit-testable)
// ---------------------------------------------------------------------------

export interface CloneAction {
  key: string;
  role: 'mcp' | 'extension' | 'connectome-host';
  url: string;
  ref: string;
  /** Pinned commit (--pin-refs): checked out instead of the branch tip. */
  commit?: string;
  /** Absolute host directory the clone lands in. */
  target: string;
  /** Shell command(s) run inside `target` after clone; empty = clone only. */
  buildCommand: string;
  /** Env var holding a private-clone token, when declared. */
  authSecret?: string;
  sslBypass?: boolean;
}

export interface CopyAction {
  key: string;
  /** Recipe-adjacent checkout to copy from (may not exist yet — checked at
   *  execution with a clear error). */
  from: string;
  target: string;
}

export interface HostActions {
  clones: CloneAction[];
  /** Sibling-copy sources: recipe-adjacent checkout → installDir (mirrors
   *  the docker COPY of an operator-supplied checkout). */
  copies: CopyAction[];
  /** Sources cook skips on host with a reason (npm-global). */
  skipped: Array<{ key: string; reason: string }>;
  /** Extension name → in-place host entry path (local extensions). */
  localExtensionPaths: Map<string, string>;
}

/** Map a source's container path onto the install dir: `/zulip_mcp` →
 *  `<installDir>/zulip_mcp`, `/app/extensions/x` → `<installDir>/app/extensions/x`. */
export function hostPathFor(installDir: string, inContainerPath: string): string {
  return join(installDir, ...inContainerPath.split('/').filter(Boolean));
}

/** Host-side build command for an install pattern — mirrors the docker
 *  runtimes' semantics (npm.ts / pip.ts / custom.ts). */
export function hostBuildCommand(source: McpSource): string {
  switch (source.install.kind) {
    case 'npm':
      return 'npm install --no-audit --no-fund && npm run build';
    case 'pip-editable':
      return 'python3 -m venv .venv && .venv/bin/pip install --no-cache-dir --upgrade pip && .venv/bin/pip install --no-cache-dir -e .';
    case 'custom':
      return source.install.run.trim();
    default:
      return '';
  }
}

/** Compute every action the host install would take. Pure. */
export function planHostActions(plan: InstallPlan, options: HostBackendOptions): HostActions {
  const clones: CloneAction[] = [];
  const copies: CopyAction[] = [];
  const skipped: HostActions['skipped'] = [];

  clones.push({
    key: 'connectome-host',
    role: 'connectome-host',
    url: options.chRepoUrl,
    ref: options.chRef,
    target: join(options.installDir, 'app'),
    buildCommand: 'bun install',
    ...(options.chCommit !== undefined ? { commit: options.chCommit } : {}),
  });

  for (const source of plan.sources) {
    if (source.install.kind === 'npm-global') {
      skipped.push({
        key: source.key,
        reason: 'npm-registry package — `npx -y` fetches it at first spawn on the host (network available; no cold-boot race outside a container)',
      });
      continue;
    }
    if (source.install.kind === 'sibling-copy') {
      // Mirror the docker COPY: the operator keeps a checkout next to the
      // recipe; we copy it under the install dir so the (rebased) overlay
      // paths in the configuration actually exist at runtime.
      const declaringRecipe = source.refs[0]?.recipePath ?? plan.recipePath;
      copies.push({
        key: source.key,
        from: join(dirname(declaringRecipe), source.install.siblingDir),
        target: hostPathFor(options.installDir, source.inContainerPath),
      });
      continue;
    }
    clones.push({
      key: source.key,
      role: source.role === 'extension' ? 'extension' : 'mcp',
      url: source.url,
      ref: source.ref,
      target: hostPathFor(options.installDir, source.inContainerPath),
      buildCommand: hostBuildCommand(source),
      ...(source.commit !== undefined ? { commit: source.commit } : {}),
      ...(source.authSecret !== undefined ? { authSecret: source.authSecret } : {}),
      ...(source.sslBypass !== undefined ? { sslBypass: source.sslBypass } : {}),
    });
  }

  // Local extensions stay in place — the configuration points at the
  // operator's own directory (that's the point of host mode).
  const localExtensionPaths = new Map<string, string>();
  for (const ext of plan.localExtensions) {
    localExtensionPaths.set(ext.name, join(ext.hostDir, ext.entryBasename));
  }

  return { clones, copies, skipped, localExtensionPaths };
}

/** Render the confirm-gate preview. Pure (string). */
export function renderActionPreview(actions: HostActions, options: HostBackendOptions): string {
  const lines: string[] = [];
  lines.push(`Host install plan → ${options.installDir}`);
  lines.push('');
  lines.push('Will clone + build ON THIS MACHINE:');
  for (const c of actions.clones) {
    const refLabel = c.ref && c.ref !== 'main' ? `@${c.ref}` : '';
    lines.push(`  - ${c.url}${refLabel} → ${c.target}`);
    if (c.buildCommand) lines.push(`      then run: ${c.buildCommand}`);
    if (c.authSecret) lines.push(`      (private clone: token from $${c.authSecret})`);
  }
  for (const c of actions.copies) {
    lines.push(`  - COPY ${c.from} → ${c.target} (sibling checkout)`);
  }
  for (const s of actions.skipped) {
    lines.push(`  - SKIP ${s.key}: ${s.reason}`);
  }
  if (actions.localExtensionPaths.size > 0) {
    lines.push('');
    lines.push('Local extensions used in place (no copy):');
    for (const [name, path] of actions.localExtensionPaths) {
      lines.push(`  - ${name}: ${path}`);
    }
  }
  lines.push('');
  lines.push(`Also writes: recipes/, .env, run.sh, ${LOCKFILE_NAME} under the install dir.`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/** True when the existing lock says this clone is already materialized at
 *  the same url+ref+install and the target exists — skip it. A component
 *  whose build failed never reaches the lock (and its target is removed on
 *  failure), so a half-built checkout cannot satisfy this check. */
function isSatisfiedByLock(
  action: CloneAction,
  lock: Lockfile | null,
): boolean {
  if (!lock || !existsSync(action.target)) return false;
  if (action.role === 'connectome-host') {
    return lock.connectomeHost.url === action.url && lock.connectomeHost.ref === action.ref;
  }
  const entry = lock.components.find((c) => c.key === action.key);
  return !!entry
    && entry.url === action.url
    && entry.ref === action.ref
    && entry.install === (action.buildCommand || 'clone-only');
}

/** Clone URL with an optional token (resolved values > environment; never
 *  logged). The credentialed form is briefly visible in the process list
 *  during the clone; executeClone scrubs it from .git/config afterwards. */
function cloneUrlFor(action: CloneAction, values: Record<string, string>): string {
  if (!action.authSecret) return action.url;
  const token = values[action.authSecret] ?? process.env[action.authSecret];
  if (!token) {
    throw new Error(
      `clone of ${action.url} needs a value for ${action.authSecret} ` +
      `(supply via prompt, --env-file, or the environment)`,
    );
  }
  return action.url.replace(/^https?:\/\//, (m) => `${m}oauth2:${token}@`);
}

/** Execute one clone+build action. Throws on failure; the caller removes
 *  the target on failure so no half-built checkout survives. */
function executeClone(action: CloneAction, values: Record<string, string>): { commit?: string } {
  rmSync(action.target, { recursive: true, force: true });
  mkdirSync(resolve(action.target, '..'), { recursive: true });

  const sslArgs = action.sslBypass ? ['-c', 'http.sslVerify=false'] : [];
  log.step(`cloning ${log.dim(action.url)}${action.ref !== 'main' ? `@${action.ref}` : ''} → ${log.dim(action.target)}`);
  execFileSync('git', [...sslArgs, 'clone', cloneUrlFor(action, values), action.target], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (action.authSecret) {
    // Scrub the token from .git/config — the credentialed URL must not
    // persist on disk (backups, shared machines, later `git fetch`).
    execFileSync('git', ['remote', 'set-url', 'origin', action.url], {
      cwd: action.target, stdio: ['ignore', 'inherit', 'inherit'],
    });
  }
  if (action.commit) {
    // Pinned build: check out the exact SHA the operator resolved at cook
    // time, regardless of where the branch tip has moved since.
    execFileSync('git', ['checkout', action.commit], {
      cwd: action.target, stdio: ['ignore', 'inherit', 'inherit'],
    });
  } else if (action.ref && action.ref !== 'main') {
    if (action.ref.startsWith('refs/')) {
      execFileSync('git', ['fetch', 'origin', `${action.ref}:cook-install-checkout`], {
        cwd: action.target, stdio: ['ignore', 'inherit', 'inherit'],
      });
      execFileSync('git', ['checkout', 'cook-install-checkout'], {
        cwd: action.target, stdio: ['ignore', 'inherit', 'inherit'],
      });
    } else {
      execFileSync('git', ['checkout', action.ref], {
        cwd: action.target, stdio: ['ignore', 'inherit', 'inherit'],
      });
    }
  }
  let commit: string | undefined;
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: action.target })
      .toString().trim();
  } catch {
    // Non-fatal — lock entry just omits the commit.
  }

  if (action.buildCommand) {
    log.step(`building ${log.dim(action.target)}: ${action.buildCommand}`);
    execSync(action.buildCommand, {
      cwd: action.target,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
    });
  }
  return { ...(commit !== undefined ? { commit } : {}) };
}

/** Warn when operator values or recipe defaults address a sidecar by its
 *  compose service name — that resolves inside the docker network only; the
 *  native agent must use the published localhost port instead. */
function warnServiceNameNetworking(
  plan: InstallPlan,
  renderedFiles: Array<{ origin: string; content: string }>,
): void {
  const serviceNames = (plan.parentWalk.recipe.services ?? []).map((s) => s.name);
  if (serviceNames.length === 0) return;
  const hits = new Set<string>();
  const scan = (name: string, value: string | undefined) => {
    if (!value) return;
    for (const svc of serviceNames) {
      if (value.includes(`://${svc}`) || value.includes(`@${svc}:`) || value === svc) {
        hits.add(`${name} → "${value}" (references service "${svc}")`);
      }
    }
  };
  for (const [k, v] of Object.entries(plan.values)) scan(k, v);
  for (const v of plan.envVars) scan(v.name, v.defaultValue);
  // Rendered config bodies too — a baked `redis://kvstore` in a container
  // template is the same trap, one hop removed.
  for (const f of renderedFiles) {
    for (const svc of serviceNames) {
      if (f.content.includes(`://${svc}`) || f.content.includes(`@${svc}:`)) {
        hits.add(`${f.origin} (rendered content references service "${svc}")`);
      }
    }
  }
  for (const hit of hits) {
    log.warn(
      `host networking: ${hit} — compose service names only resolve inside the docker network; ` +
      `the native agent must use the sidecar's published localhost port (e.g. http://localhost:<port>).`,
    );
  }
}

/** Shell-safe single-quoted value for the sourceable .env. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function renderShellEnvFile(values: Record<string, string>): string {
  const keys = Object.keys(values).sort();
  return keys.map((k) => `export ${k}=${shellQuote(values[k]!)}`).join('\n')
    + (keys.length ? '\n' : '');
}

export const SIDECAR_COMPOSE_FILENAME = 'docker-compose.sidecars.yml';

export interface LauncherEnvsubst {
  /** installDir-relative .tmpl source. */
  tmpl: string;
  /** installDir-relative render target. */
  target: string;
  /** chmod mode (octal string, e.g. "644"). */
  mode: string;
}

export function renderLauncher(
  parentRecipeBasename: string,
  opts: { hasSidecars: boolean; envsubstFiles: LauncherEnvsubst[] },
): string {
  const lines = [
    '#!/usr/bin/env bash',
    '# Generated by connectome-cook (host backend). Launches the deployment.',
    'set -euo pipefail',
    'cd "$(dirname "$0")"',
    'if [ -f ./.env ]; then',
    '  set -a; . ./.env; set +a',
    'fi',
  ];
  if (opts.hasSidecars) {
    lines.push(
      '',
      '# Sidecar services run under docker (the agent itself runs natively).',
      '# --wait blocks until services are running/healthy and one-shot',
      '# bootstrap services have exited successfully. COOK_SKIP_SIDECARS=1',
      '# skips this (e.g. when sidecars are managed out-of-band).',
      `if [ "\${COOK_SKIP_SIDECARS:-0}" != "1" ]; then`,
      `  docker compose -f ${SIDECAR_COMPOSE_FILENAME} up -d --wait`,
      'fi',
    );
  }
  if (opts.envsubstFiles.length > 0) {
    lines.push(
      '',
      '# Runtime-rendered config templates: values that only exist at start',
      '# time (e.g. a bootstrap-generated bot password) are substituted here.',
      'command -v envsubst >/dev/null 2>&1 || {',
      '  echo "run.sh: envsubst not found — install gettext (apt: gettext-base)" >&2; exit 1;',
      '}',
    );
    for (const f of opts.envsubstFiles) {
      lines.push(`envsubst < "${f.tmpl}" > "${f.target}"`);
      lines.push(`chmod ${f.mode} "${f.target}"`);
    }
  }
  lines.push(
    '',
    'export DATA_DIR="${DATA_DIR:-$PWD/data}"',
    'mkdir -p "$DATA_DIR"',
    'cd app',
    `exec bun src/index.ts "../recipes/${parentRecipeBasename}" "$@"`,
    '',
  );
  return lines.join('\n');
}

/** Materialize the plan onto the host. */
export async function runHostBackend(
  plan: InstallPlan,
  options: HostBackendOptions,
): Promise<BuildResult> {
  const installDir = options.installDir;
  const parent = plan.parentWalk.recipe;
  const hasSidecars = (parent.services ?? []).length > 0;

  // Runtime files (sidecar templateFiles + containerTemplateFiles) render
  // BEFORE the confirm gate — an incomplete-template refusal shouldn't
  // waste clones. Placement differs from docker: sidecar templates land at
  // <installDir>/<relPath> (the sidecars-only compose resolves relative
  // bind sources against the install dir), container templates directly at
  // the REBASED inContainer path (no mount on host — the agent reads the
  // real file), runtime-rendered ones as `.tmpl` for run.sh's envsubst.
  const valueBag = buildValueBag(plan);
  const runtimeFiles = renderRuntimeFiles(plan, valueBag);
  if (!enforceCompleteTemplates(runtimeFiles, options.allowIncompleteTemplates)) {
    return { exitCode: 2, outDir: installDir };
  }

  const actions = planHostActions(plan, options);
  let existingLock: Lockfile | null = null;
  try {
    existingLock = readLockfile(installDir);
  } catch (err) {
    log.warn(`existing ${LOCKFILE_NAME} unreadable (${err instanceof Error ? err.message : String(err)}) — treating as fresh install`);
  }

  // ---- Confirm gate: commands run on the operator's machine. ----
  process.stdout.write(renderActionPreview(actions, options) + '\n\n');
  if (options.noPrompts) {
    if (!options.yes) {
      log.error('host install runs commands on this machine; non-interactive mode requires --yes');
      return { exitCode: 1, outDir: installDir };
    }
  } else {
    const answer = await promptsLib({
      type: 'confirm',
      name: 'ok',
      message: 'Proceed with the host install plan above?',
      initial: false,
    });
    if (!answer.ok) {
      log.warn('cancelled by user');
      return { exitCode: 1, outDir: installDir };
    }
  }

  mkdirSync(installDir, { recursive: true });
  mkdirSync(join(installDir, 'recipes'), { recursive: true });

  // ---- Clone + build components (idempotent against the lock). ----
  const lockedComponents: LockedComponent[] = [];
  let chCommit: string | undefined;
  for (const action of actions.clones) {
    let commit: string | undefined;
    if (isSatisfiedByLock(action, existingLock)) {
      log.info(`unchanged ${log.dim(action.key)} — kept (${log.dim(action.target)})`);
      commit = action.role === 'connectome-host'
        ? existingLock!.connectomeHost.commit
        : existingLock!.components.find((c) => c.key === action.key)?.commit;
    } else {
      try {
        commit = executeClone(action, plan.values).commit;
      } catch (err) {
        log.error(
          `install of ${action.key} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        // Remove the partial checkout so a later re-run re-clones instead
        // of a stale lock entry + existing dir passing the reconcile check.
        rmSync(action.target, { recursive: true, force: true });
        return { exitCode: 3, outDir: installDir };
      }
    }
    if (action.role === 'connectome-host') {
      chCommit = commit;
    } else {
      lockedComponents.push({
        key: action.key,
        role: action.role,
        url: action.url,
        ref: action.ref,
        path: action.target,
        install: action.buildCommand || 'clone-only',
        ...(commit !== undefined ? { commit } : {}),
      });
    }
  }

  // ---- Sibling copies (docker's context-COPY equivalent). ----
  for (const copy of actions.copies) {
    if (!existsSync(copy.from)) {
      log.error(
        `sibling checkout not found: ${copy.from} — place the checkout next to the recipe ` +
        `(same requirement as docker's sibling-copy) and re-run`,
      );
      return { exitCode: 2, outDir: installDir };
    }
    log.step(`copying sibling checkout ${log.dim(copy.from)} → ${log.dim(copy.target)}`);
    rmSync(copy.target, { recursive: true, force: true });
    cpSync(copy.from, copy.target, {
      recursive: true,
      filter: (src) => basename(src) !== '.git',
    });
    lockedComponents.push({
      key: copy.key,
      role: 'mcp',
      url: '',
      ref: '',
      path: copy.target,
      install: 'sibling-copy',
    });
  }

  // ---- Lower configurations with host-rebased overlays. ----
  // The overlay machinery reasons in `inContainerPath` terms; rebasing each
  // source's path onto the install dir makes it emit host-absolute paths.
  // Sibling-copy sources are included — their checkouts were copied above,
  // so args must be rewritten to the install-dir paths just like in docker.
  const rebasedSources = plan.sources
    .filter((s) => s.install.kind !== 'npm-global')
    .map((s) => ({ ...s, inContainerPath: hostPathFor(installDir, s.inContainerPath) }));
  const rebasedLocalExts = plan.localExtensions.map((ext) => ({
    ...ext,
    // In-place: "container path" IS the operator's directory.
    inContainerPath: ext.hostDir,
  }));
  const overlayInput: GeneratorInput = {
    walks: plan.walks,
    sources: rebasedSources,
    localExtensions: rebasedLocalExts,
    envVars: plan.envVars,
    options: {
      outDir: installDir,
      noPrompts: options.noPrompts,
      strict: plan.options.strict,
      pinRefs: false,
    },
  };
  let overlays: Map<string, Partial<Recipe>>;
  try {
    overlays = generateOverlays(overlayInput);
  } catch (err) {
    log.error(`overlay generation failed: ${err instanceof Error ? err.message : String(err)}`);
    return { exitCode: 2, outDir: installDir };
  }

  const parentRecipeBasename = recipeFilename(plan.parentWalk.path);
  try {
    for (const walk of plan.walks) {
      const configuration = lowerToConfiguration(walk.recipe, overlays.get(walk.path));
      writeFileSync(
        join(installDir, 'recipes', recipeFilename(walk.path)),
        JSON.stringify(configuration, null, 2) + '\n',
      );
    }

    // Credential files (complete ones only — mirrors the docker backend).
    // The runtime resolves the recipe-declared path against its CWD, which
    // run.sh sets to <installDir>/app — so relative paths are written there
    // (docker gets the same effect from a bind mount at the declared path).
    // Absolute declared paths are never written outside the install dir.
    for (const cf of plan.credentialFiles) {
      const values = plan.credentialValues[cf.path] ?? {};
      if (Object.keys(values).length !== cf.fields.length) {
        if (Object.keys(values).length > 0) {
          log.warn(`${cf.path}: only partial values supplied — file skipped`);
        }
        continue;
      }
      if (cf.path.startsWith('/')) {
        log.warn(
          `${cf.path}: absolute credential-file path — cook won't write outside the install dir; ` +
          `hand-place the file at that path before launching`,
        );
        continue;
      }
      const target = resolve(join(installDir, 'app'), cf.path);
      if (target !== resolve(installDir, 'app') && !target.startsWith(resolve(installDir, 'app') + '/')) {
        log.warn(`${cf.path}: resolves outside the install dir — skipped; hand-place it before launching`);
        continue;
      }
      const mode = cf.mode ? parseInt(cf.mode, 8) : 0o600;
      mkdirSync(resolve(target, '..'), { recursive: true });
      writeFileSync(target, serializeCredentialFile(cf, values), { mode });
    }

    // Sidecar secret files — same file-per-secret shape as docker; the
    // sidecars-only compose references them relative to the install dir.
    for (const sec of collectSidecarSecretFiles(
      plan,
      new Set(),
      `hand-place the file (mode 0600) in ${installDir} before launching`,
    )) {
      writeFileSync(join(installDir, sec.name), sec.value, { mode: 0o600 });
    }

    // Rendered runtime files. Guard every write against path escape — the
    // rel paths come from the recipe.
    const envsubstFiles: LauncherEnvsubst[] = [];
    const writeWithin = (target: string, content: string, mode: number) => {
      const resolved = resolve(target);
      if (resolved !== resolve(installDir) && !resolved.startsWith(resolve(installDir) + '/')) {
        throw new Error(`rendered file "${target}" resolves outside the install dir — refusing to write`);
      }
      mkdirSync(resolve(resolved, '..'), { recursive: true });
      writeFileSync(resolved, content, { mode });
    };
    for (const f of runtimeFiles) {
      if (f.kind === 'sidecar-template') {
        writeWithin(join(installDir, f.relPath), f.content, f.mode);
        continue;
      }
      // container-template: the agent reads the real path — rebased onto
      // the install dir (recipes' inContainer paths are container-absolute).
      const target = hostPathFor(installDir, f.inContainer!);
      if (f.runtime) {
        writeWithin(`${target}.tmpl`, f.content, f.mode);
        envsubstFiles.push({
          tmpl: relative(installDir, `${target}.tmpl`),
          target: relative(installDir, target),
          mode: f.mode.toString(8),
        });
      } else {
        writeWithin(target, f.content, f.mode);
      }
    }

    // Sidecars-only compose file (agent runs natively; databases don't).
    const sidecarCompose = generateSidecarCompose({
      walks: plan.walks,
      sources: [],
      envVars: plan.envVars,
      options: {
        outDir: installDir,
        noPrompts: options.noPrompts,
        strict: plan.options.strict,
        pinRefs: false,
      },
    });
    if (sidecarCompose !== null) {
      writeFileSync(join(installDir, SIDECAR_COMPOSE_FILENAME), sidecarCompose);
      warnServiceNameNetworking(
        plan,
        runtimeFiles.filter((f) => f.kind === 'container-template'),
      );
    }

    if (Object.keys(plan.values).length > 0) {
      writeFileSync(join(installDir, '.env'), renderShellEnvFile(plan.values), { mode: 0o600 });
    }
    writeFileSync(
      join(installDir, 'run.sh'),
      renderLauncher(parentRecipeBasename, { hasSidecars, envsubstFiles }),
      { mode: 0o755 },
    );

    const lock: Lockfile = {
      version: 1,
      backend: 'host',
      recipePath: plan.recipePath,
      createdAt: new Date().toISOString(),
      connectomeHost: {
        url: options.chRepoUrl,
        ref: options.chRef,
        path: join(installDir, 'app'),
        ...(chCommit !== undefined ? { commit: chCommit } : {}),
      },
      components: lockedComponents,
      localExtensions: plan.localExtensions.map((ext) => ({
        name: ext.name,
        hostDir: ext.hostDir,
        path: join(ext.hostDir, ext.entryBasename),
      })),
      requirements: plan.requirements.map((r) => ({
        name: r.name,
        envName: r.envName,
        origin: r.origin,
        ...(r.value !== undefined ? { value: r.value } : {}),
      })),
      launch: { kind: 'script', script: join(installDir, 'run.sh') },
    };
    writeLockfile(installDir, lock);
  } catch (err) {
    log.error(`write failed: ${err instanceof Error ? err.message : String(err)}`);
    return { exitCode: 3, outDir: installDir };
  }

  log.success(`host install complete → ${installDir}`);
  log.info('');
  log.info(`Next: ${log.bold(`${join(installDir, 'run.sh')}`)}`);
  return { exitCode: 0, outDir: installDir };
}
