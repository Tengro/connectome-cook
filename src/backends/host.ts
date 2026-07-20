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
 * Idempotent reconcile: a component whose url+ref+commit match the existing
 * lockfile AND whose target directory exists is skipped. Everything else is
 * re-cloned fresh (rm -rf + clone). Local extensions are never copied — the
 * configuration points at the operator's own directory.
 */

import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import promptsLib from 'prompts';
import { log } from '../log.js';
import type { GeneratorInput, McpSource } from '../types.js';
import type { Recipe } from '../vendor/recipe.js';
import type { InstallPlan } from '../plan.js';
import { generateOverlays } from '../generators/overlay.js';
import { lowerToConfiguration, recipeFilename } from '../configuration.js';
import { hostFilename, serializeCredentialFile } from '../credentials.js';
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
  /** Absolute host directory the clone lands in. */
  target: string;
  /** Shell command(s) run inside `target` after clone; empty = clone only. */
  buildCommand: string;
  /** Env var holding a private-clone token, when declared. */
  authSecret?: string;
  sslBypass?: boolean;
}

export interface HostActions {
  clones: CloneAction[];
  /** Sources cook skips on host with a reason (npm-global, sibling-copy). */
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
  const skipped: HostActions['skipped'] = [];

  clones.push({
    key: 'connectome-host',
    role: 'connectome-host',
    url: options.chRepoUrl,
    ref: options.chRef,
    target: join(options.installDir, 'app'),
    buildCommand: 'bun install',
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
      skipped.push({
        key: source.key,
        reason: 'sibling-copy source — place/keep the checkout next to the recipe; the configuration references it as written',
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

  return { clones, skipped, localExtensionPaths };
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
 *  the same url+ref and the target exists — skip it. */
function isSatisfiedByLock(
  action: CloneAction,
  lock: Lockfile | null,
): boolean {
  if (!lock || !existsSync(action.target)) return false;
  if (action.role === 'connectome-host') {
    return lock.connectomeHost.url === action.url && lock.connectomeHost.ref === action.ref;
  }
  const entry = lock.components.find((c) => c.key === action.key);
  return !!entry && entry.url === action.url && entry.ref === action.ref;
}

/** Clone URL with optional token from the environment (never logged). */
function cloneUrlFor(action: CloneAction): string {
  if (!action.authSecret) return action.url;
  const token = process.env[action.authSecret];
  if (!token) {
    throw new Error(
      `clone of ${action.url} needs $${action.authSecret} in the environment (declared authSecret)`,
    );
  }
  return action.url.replace(/^https?:\/\//, (m) => `${m}oauth2:${token}@`);
}

/** Execute one clone+build action. Throws on failure. */
function executeClone(action: CloneAction): { commit?: string } {
  rmSync(action.target, { recursive: true, force: true });
  mkdirSync(resolve(action.target, '..'), { recursive: true });

  const sslArgs = action.sslBypass ? ['-c', 'http.sslVerify=false'] : [];
  log.step(`cloning ${log.dim(action.url)}${action.ref !== 'main' ? `@${action.ref}` : ''} → ${log.dim(action.target)}`);
  execFileSync('git', [...sslArgs, 'clone', cloneUrlFor(action), action.target], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (action.ref && action.ref !== 'main') {
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

/** Shell-safe single-quoted value for the sourceable .env. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function renderShellEnvFile(values: Record<string, string>): string {
  const keys = Object.keys(values).sort();
  return keys.map((k) => `export ${k}=${shellQuote(values[k]!)}`).join('\n')
    + (keys.length ? '\n' : '');
}

function renderLauncher(parentRecipeBasename: string): string {
  return [
    '#!/usr/bin/env bash',
    '# Generated by connectome-cook (host backend). Launches the deployment.',
    'set -euo pipefail',
    'cd "$(dirname "$0")"',
    'if [ -f ./.env ]; then',
    '  set -a; . ./.env; set +a',
    'fi',
    'export DATA_DIR="${DATA_DIR:-$PWD/data}"',
    'mkdir -p "$DATA_DIR"',
    'cd app',
    `exec bun src/index.ts ../recipes/${parentRecipeBasename} "$@"`,
    '',
  ].join('\n');
}

/** Materialize the plan onto the host. */
export async function runHostBackend(
  plan: InstallPlan,
  options: HostBackendOptions,
): Promise<BuildResult> {
  const installDir = options.installDir;
  const actions = planHostActions(plan, options);
  const existingLock = readLockfile(installDir);

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
        commit = executeClone(action).commit;
      } catch (err) {
        log.error(
          `install of ${action.key} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
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

  // ---- Lower configurations with host-rebased overlays. ----
  // The overlay machinery reasons in `inContainerPath` terms; rebasing each
  // source's path onto the install dir makes it emit host-absolute paths.
  const rebasedSources = plan.sources
    .filter((s) => s.install.kind !== 'npm-global' && s.install.kind !== 'sibling-copy')
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
    for (const cf of plan.credentialFiles) {
      const values = plan.credentialValues[cf.path] ?? {};
      if (Object.keys(values).length !== cf.fields.length) {
        if (Object.keys(values).length > 0) {
          log.warn(`${cf.path}: only partial values supplied — file skipped`);
        }
        continue;
      }
      const mode = cf.mode ? parseInt(cf.mode, 8) : 0o600;
      writeFileSync(join(installDir, hostFilename(cf)), serializeCredentialFile(cf, values), { mode });
    }

    if (Object.keys(plan.values).length > 0) {
      writeFileSync(join(installDir, '.env'), renderShellEnvFile(plan.values), { mode: 0o600 });
    }
    writeFileSync(join(installDir, 'run.sh'), renderLauncher(parentRecipeBasename), { mode: 0o755 });

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
