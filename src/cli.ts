import mri from 'mri';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { log } from './log.js';
import { slugify } from './slug.js';
import type { SubcommandHandler } from './types.js';
import { loadRecipeRaw, type Recipe } from './vendor/recipe.js';
import { LOCKFILE_NAME, readLockfile } from './lockfile.js';
import { walkRecipe } from './walker.js';
import { detectSources } from './source-detector.js';
import { detectExtensions } from './extension-detector.js';
import { collectEnvVars } from './env-collector.js';
import { resolvePlan } from './plan.js';
import { runDockerBackend, type BuildResult } from './backends/docker.js';
import {
  DEFAULT_CH_REF,
  DEFAULT_CH_REPO_URL,
  runHostBackend,
} from './backends/host.js';
import { pinSources, resolveRemoteRef } from './pin-refs.js';
import { listTemplates, scaffoldRecipe, type TemplateName } from './init.js';

const pkg = JSON.parse(
  readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'),
    'utf-8',
  ),
) as { name: string; version: string };

const USAGE = `${log.bold('connectome-cook')} — recipes in, deployments out (docker images or host installs).

${log.bold('Usage:')}
  cook <command> [args] [flags]        (also installed as \`connectome\`)

${log.bold('Commands:')}
  build <recipe>         Generate Docker artifacts for a recipe (aka \`cook\`)
  install <recipe>       Install directly onto this machine (no docker)
  run <recipe|dir>       Launch a materialized deployment (build first if none)
  check <recipe>         Validate a recipe without writing files
  init <name>            Scaffold a starter recipe

${log.bold('Global flags:')}
  --help, -h             Show this message
  --version, -V          Print version and exit

Run ${log.dim('cook <command> --help')} for command-specific flags.
`;

const BUILD_USAGE = `${log.bold('cook build')} — generate a Docker artifact bundle for a recipe.

${log.bold('Usage:')}
  cook build <recipe-path-or-url> [flags]

${log.bold('Flags:')}
  --out <dir>            Output directory (default: ./<recipe-name>-cook)
  --strict               Fail if any MCP server lacks a \`source\` block
  --image-name <name>    Override the generated image name
  --no-prompts           Non-interactive; warn-and-continue on missing values
  --env-file <path>      Read variable values from this file before prompting
  --pin-refs             Resolve branch refs to commit SHAs (reproducible build)
  --allow-incomplete-templates
                         Write templated config files even when \${VAR}
                         references render as empty.  Default: refuse the
                         build (catches the WIKI_SECRET_KEY-style footgun).
  --help, -h             Show this message
`;

const CHECK_USAGE = `${log.bold('cook check')} — validate a recipe + summarize what cook would build.

${log.bold('Usage:')}
  cook check <recipe-path-or-url> [flags]

${log.bold('Flags:')}
  --strict               Fail if any MCP server lacks a \`source\` block
  --json                 Machine-readable report (TODO)
  --help, -h             Show this message
`;

/** Default output dir name when --out isn't supplied. */
function defaultOutDir(parentRecipe: Recipe): string {
  return `./${slugify(parentRecipe.name)}-cook`;
}

/**
 * Shared build pipeline: parse flags, resolve the recipe into an
 * InstallPlan (front-end: walking, detection, value collection, prompts),
 * then hand the plan to the docker backend for materialization.
 */
async function runBuildPipeline(argv: string[]): Promise<BuildResult> {
  const flags = mri(argv, {
    // mri auto-handles `--no-<flag>` as `flag: false`; we read it as
    // `flags.prompts === false` below.
    boolean: ['help', 'strict', 'pin-refs', 'allow-incomplete-templates'],
    string: ['out', 'env-file', 'image-name'],
    alias: { h: 'help' },
  });

  if (flags.help) {
    process.stdout.write(BUILD_USAGE);
    return { exitCode: 0, outDir: '' };
  }

  const [recipePath] = flags._ as string[];
  if (!recipePath) {
    log.error('build: missing recipe path');
    process.stderr.write(`\n${BUILD_USAGE}`);
    return { exitCode: 1, outDir: '' };
  }

  const planResult = await resolvePlan(recipePath, {
    strict: !!flags.strict,
    noPrompts: flags.prompts === false,
    envFile: flags['env-file'],
  });
  if (!planResult.ok) {
    return { exitCode: planResult.exitCode, outDir: '' };
  }

  // --pin-refs: resolve branch refs to SHAs before generation so the
  // Dockerfile checks out exact commits and the lock records them.
  let pinnedChRef: string | undefined;
  if (flags['pin-refs']) {
    log.step('pinning refs (git ls-remote)');
    pinSources(planResult.plan.sources);
    const chSha = resolveRemoteRef(DEFAULT_CH_REPO_URL, DEFAULT_CH_REF);
    if (chSha) {
      pinnedChRef = chSha;
      log.info(`--pin-refs: connectome-host@${DEFAULT_CH_REF} → ${chSha.slice(0, 12)}`);
    } else {
      log.warn(`--pin-refs: could not resolve connectome-host@${DEFAULT_CH_REF} — CH_REF left symbolic`);
    }
  }

  const outDir = resolve(flags.out ?? defaultOutDir(planResult.plan.parentWalk.recipe));
  return runDockerBackend(planResult.plan, {
    outDir,
    noPrompts: flags.prompts === false,
    envFile: flags['env-file'],
    strict: !!flags.strict,
    imageName: flags['image-name'],
    pinRefs: !!flags['pin-refs'],
    ...(pinnedChRef !== undefined ? { pinnedChRef } : {}),
    allowIncompleteTemplates: !!flags['allow-incomplete-templates'],
  });
}

const INSTALL_USAGE = `${log.bold('cook install')} — install a recipe directly onto this machine (no docker).

${log.bold('Usage:')}
  cook install <recipe-path-or-url> [flags]

Clones and builds every component (connectome-host, MCP servers, extensions)
under the install dir, resolves host requirements (probe + confirm), writes
the lowered configurations, a sourceable .env, a run.sh launcher, and
${log.dim('connectome.lock')}.  Re-running reconciles: components unchanged in the
lock are kept, everything else is re-cloned.

${log.bold('SAFETY:')} unlike \`cook build\`, install commands run ON THIS MACHINE.
The full action plan is printed and confirmed first.  Non-interactive runs
(--no-prompts) additionally require ${log.bold('--yes')}.

${log.bold('Flags:')}
  --out <dir>            Install directory (default: ~/.connectome/installs/<name>)
  --strict               Fail if any MCP server / extension can't be materialized
  --no-prompts           Non-interactive (requires --yes to actually install)
  --yes                  Skip the confirm gate
  --pin-refs             Resolve branch refs to commit SHAs before cloning
  --allow-incomplete-templates
                         Write templated config files even when \${VAR}
                         references render as empty (default: refuse)
  --env-file <path>      Read variable values from this file before prompting
  --ch-repo <url>        connectome-host repo (default: ${DEFAULT_CH_REPO_URL})
  --ch-ref <ref>         connectome-host ref (default: ${DEFAULT_CH_REF})
  --help, -h             Show this message
`;

async function handleInstall(argv: string[]): Promise<number> {
  const flags = mri(argv, {
    boolean: ['help', 'strict', 'yes', 'pin-refs', 'allow-incomplete-templates'],
    string: ['out', 'env-file', 'ch-repo', 'ch-ref'],
    alias: { h: 'help' },
  });

  if (flags.help) {
    process.stdout.write(INSTALL_USAGE);
    return 0;
  }

  const [recipePath] = flags._ as string[];
  if (!recipePath) {
    log.error('install: missing recipe path');
    process.stderr.write(`\n${INSTALL_USAGE}`);
    return 1;
  }

  const planResult = await resolvePlan(recipePath, {
    strict: !!flags.strict,
    noPrompts: flags.prompts === false,
    envFile: flags['env-file'],
  });
  if (!planResult.ok) return planResult.exitCode;

  const chRepoUrl = flags['ch-repo'] ?? DEFAULT_CH_REPO_URL;
  const chRef = flags['ch-ref'] ?? DEFAULT_CH_REF;

  // --pin-refs: resolve every symbolic ref (components + connectome-host)
  // to a SHA before executing; clones check out the exact commits.
  let chCommit: string | undefined;
  if (flags['pin-refs']) {
    log.step('pinning refs (git ls-remote)');
    pinSources(planResult.plan.sources);
    const chSha = resolveRemoteRef(chRepoUrl, chRef);
    if (chSha) {
      chCommit = chSha;
      log.info(`--pin-refs: connectome-host@${chRef} → ${chSha.slice(0, 12)}`);
    } else {
      log.warn(`--pin-refs: could not resolve connectome-host@${chRef} — left unpinned`);
    }
  }

  const installDir = resolve(
    flags.out
      ?? join(homedir(), '.connectome', 'installs', slugify(planResult.plan.parentWalk.recipe.name)),
  );
  const result = await runHostBackend(planResult.plan, {
    installDir,
    noPrompts: flags.prompts === false,
    yes: !!flags.yes,
    chRepoUrl,
    chRef,
    ...(chCommit !== undefined ? { chCommit } : {}),
    allowIncompleteTemplates: !!flags['allow-incomplete-templates'],
  });
  return result.exitCode;
}

async function handleBuild(argv: string[]): Promise<number> {
  const result = await runBuildPipeline(argv);
  if (result.exitCode === 0 && result.outDir) {
    log.info('');
    const next = `cd ${result.outDir} && docker compose up -d --build`;
    log.info(`Next: ${log.bold(next)}`);
  }
  return result.exitCode;
}

const RUN_USAGE = `${log.bold('cook run')} — launch a materialized deployment (or build, then launch).

${log.bold('Usage:')}
  cook run <recipe-or-materialized-dir> [build-flags] [-- passthrough-args]

Resolution order:
  1. If the argument is a directory with a ${log.dim('connectome.lock')}, launch it
     directly (docker compose up for docker installs, run.sh for host installs).
  2. If the argument is a recipe, look for an existing materialization
     (--out dir, ./<name>-cook, then ~/.connectome/installs/<name>) and
     launch the first one found — no re-resolution, no prompts.
  3. Otherwise fall through to the classic build-then-\`docker compose up\`.
     Pass ${log.bold('--rebuild')} to force this path even when a lock exists.

Build flags are the same as ${log.bold('cook build')}.  Anything after \`--\` goes to
\`docker compose up\` (docker) or the launcher script (host) — e.g. \`-- -d\`.
`;

/** Launch a materialized dir per its lockfile: compose or launcher script.
 *  Always launches in the directory the lock was FOUND in — the recorded
 *  launch.dir is a build-time hint that goes stale when the operator moves
 *  or copies the output dir, and launching a different deployment than the
 *  one explicitly named would be silently wrong. */
function launchFromLock(dir: string, passthroughArgs: string[]): Promise<number> {
  let lock;
  try {
    lock = readLockfile(dir);
  } catch (err) {
    log.error(`${dir}: unreadable ${LOCKFILE_NAME}: ${err instanceof Error ? err.message : String(err)}`);
    return Promise.resolve(1);
  }
  if (!lock) {
    log.error(`${dir}: no ${LOCKFILE_NAME} — nothing to launch`);
    return Promise.resolve(1);
  }
  let command: string;
  let args: string[];
  const cwd = dir;
  if (lock.launch.kind === 'compose') {
    if (!existsSync(join(cwd, 'docker-compose.yml'))) {
      log.error(`${cwd}: lock says docker backend but no docker-compose.yml here — re-run \`cook build\``);
      return Promise.resolve(1);
    }
    command = 'docker';
    args = passthroughArgs.length > 0
      ? ['compose', 'up', ...passthroughArgs]
      : ['compose', 'up', '--build'];
    log.step(`docker compose up in ${log.dim(cwd)}`);
  } else {
    const localScript = join(dir, 'run.sh');
    command = existsSync(localScript) ? localScript : lock.launch.script;
    args = passthroughArgs;
    log.step(`launching ${log.dim(command)}`);
  }
  return new Promise<number>((resolveExit) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.on('close', (code) => resolveExit(code ?? 3));
    child.on('error', (err) => {
      log.error(`failed to launch: ${err.message}`);
      resolveExit(3);
    });
  });
}

/** Candidate materialization dirs for a recipe, in preference order. */
async function findMaterialization(
  target: string,
  outFlag: string | undefined,
): Promise<string | null> {
  const candidates: string[] = [];
  if (outFlag) candidates.push(resolve(outFlag));
  try {
    const recipe = await loadRecipeRaw(target);
    const slug = slugify(recipe.name);
    candidates.push(resolve(`./${slug}-cook`));
    candidates.push(join(homedir(), '.connectome', 'installs', slug));
  } catch {
    // Unloadable recipe — the build path will surface the real error.
  }
  for (const dir of candidates) {
    if (existsSync(join(dir, LOCKFILE_NAME))) return dir;
  }
  return null;
}

async function handleRun(argv: string[]): Promise<number> {
  // Split argv at the `--` separator: anything before goes to build,
  // anything after goes to the launch target (compose / launcher script).
  const sep = argv.indexOf('--');
  const buildArgs = sep === -1 ? argv : argv.slice(0, sep);
  const passthroughArgs = sep === -1 ? [] : argv.slice(sep + 1);

  if (buildArgs.includes('--help') || buildArgs.includes('-h')) {
    process.stdout.write(RUN_USAGE);
    return 0;
  }

  // Parse with the FULL build flag spec plus --rebuild so a flag like
  // `--strict` before the recipe path can't swallow it as its value (mri
  // treats unknown flags greedily otherwise) and the positional target is
  // found regardless of flag order.
  const runFlags = mri(buildArgs, {
    boolean: ['rebuild', 'help', 'strict', 'pin-refs', 'allow-incomplete-templates'],
    string: ['out', 'env-file', 'image-name'],
    alias: { h: 'help' },
  });
  const [target] = runFlags._ as string[];

  // Build-affecting flags mean the operator wants a fresh materialization —
  // launching a stale dir while silently ignoring them would be wrong.
  const wantsFreshBuild = runFlags.rebuild
    || !!runFlags.strict
    || !!runFlags['allow-incomplete-templates']
    || runFlags['env-file'] !== undefined
    || runFlags['image-name'] !== undefined
    || runFlags.prompts === false;

  // 1. Materialized dir named directly.
  if (target && existsSync(join(target, LOCKFILE_NAME))) {
    return launchFromLock(resolve(target), passthroughArgs);
  }

  // 2. Recipe with an existing materialization — launch without re-resolving.
  if (target && !wantsFreshBuild) {
    const found = await findMaterialization(target, runFlags.out);
    if (found) {
      log.info(`found existing materialization ${log.dim(found)} (use --rebuild to re-cook)`);
      return launchFromLock(found, passthroughArgs);
    }
  }

  // 3. Classic path: build the docker bundle, then compose up.
  const buildResult = await runBuildPipeline(buildArgs.filter((a) => a !== '--rebuild'));
  if (buildResult.exitCode !== 0) {
    return buildResult.exitCode;
  }

  log.step(`docker compose up in ${log.dim(buildResult.outDir)}`);
  const composeFinalArgs = passthroughArgs.length > 0 ? ['up', ...passthroughArgs] : ['up', '--build'];
  return new Promise<number>((resolveExit) => {
    const child = spawn('docker', ['compose', ...composeFinalArgs], {
      cwd: buildResult.outDir,
      stdio: 'inherit',
    });
    child.on('close', (code) => resolveExit(code ?? 3));
    child.on('error', (err) => {
      log.error(`failed to spawn docker: ${err.message}`);
      resolveExit(3);
    });
  });
}

async function handleCheck(argv: string[]): Promise<number> {
  const flags = mri(argv, {
    boolean: ['strict', 'json', 'help'],
    alias: { h: 'help' },
  });

  if (flags.help) {
    process.stdout.write(CHECK_USAGE);
    return 0;
  }

  const [recipePath] = flags._ as string[];
  if (!recipePath) {
    log.error('check: missing recipe path');
    process.stderr.write(`\n${CHECK_USAGE}`);
    return 1;
  }

  if (flags.json) {
    log.warn('--json: not yet implemented; printing human-readable report');
  }

  let walks;
  try {
    log.step(`walking recipe ${log.dim(recipePath)}`);
    walks = await walkRecipe(recipePath);
  } catch (err) {
    log.error(`failed to load recipe: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  log.success(`loaded ${walks.length} recipe${walks.length === 1 ? '' : 's'}`);
  for (const walk of walks) {
    process.stdout.write(`    ${log.dim(walk.path)}  ${log.bold(walk.recipe.name)}\n`);
  }

  let sources;
  try {
    log.step(`detecting MCP sources (${flags.strict ? 'strict' : 'non-strict'})`);
    sources = detectSources(walks, { strict: !!flags.strict });
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    return 2;
  }

  log.success(`detected ${sources.length} MCP source${sources.length === 1 ? '' : 's'}`);
  for (const src of sources) {
    const refList = src.refs.map((r) => `${r.recipePath.split('/').pop()}#${r.mcpServerName}`).join(', ');
    if (src.install.kind === 'sibling-copy') {
      process.stdout.write(`    ${log.bold(src.key)}  ${log.dim(`(sibling-copy: ${src.install.siblingDir} → ${src.inContainerPath})`)}  used by: ${refList}\n`);
    } else if (src.install.kind === 'npm-global') {
      process.stdout.write(`    ${log.bold(src.install.package)}  ${log.dim('(npm install -g, baked into runtime image)')}  used by: ${refList}\n`);
    } else {
      const refLabel = src.ref ? `@${src.ref}` : '';
      process.stdout.write(`    ${log.bold(src.url + refLabel)}  ${log.dim(`(${src.install.kind} → ${src.inContainerPath})`)}  used by: ${refList}\n`);
    }
  }

  let detectedExts;
  try {
    log.step('detecting extensions');
    detectedExts = detectExtensions(walks, { strict: !!flags.strict });
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  const extCount = detectedExts.gitExtensions.length + detectedExts.localExtensions.length;
  log.success(`detected ${extCount} extension${extCount === 1 ? '' : 's'}`);
  for (const ext of detectedExts.gitExtensions) {
    const refLabel = ext.ref && ext.ref !== 'main' ? `@${ext.ref}` : '';
    process.stdout.write(
      `    ${log.bold(ext.extensionName!)}  ${log.dim(`(git: ${ext.url}${refLabel} → ${ext.inContainerPath}/${ext.entry})`)}\n`,
    );
  }
  for (const ext of detectedExts.localExtensions) {
    process.stdout.write(
      `    ${log.bold(ext.name)}  ${log.dim(`(local bundle: ${ext.hostDir} → ${ext.inContainerPath}/${ext.entryBasename})`)}\n`,
    );
  }

  log.step('collecting environment variables');
  const envVars = collectEnvVars(walks);
  log.success(`found ${envVars.length} variable${envVars.length === 1 ? '' : 's'}`);
  for (const v of envVars) {
    const sites = v.usedIn.map((u) => `${u.recipePath.split('/').pop()}:${u.jsonPath}`).join('\n        ');
    process.stdout.write(`    ${log.bold(v.name)}\n        ${sites}\n`);
  }

  return 0;
}

const INIT_USAGE = `${log.bold('cook init')} — scaffold a starter recipe.

${log.bold('Usage:')}
  cook init <name> [--template <name>] [--out <path>]

${log.bold('Templates:')}
  minimal                Single agent, no MCP servers (default).
  zulip-agent            Single agent staffing a Zulip channel.
  triumvirate            Three-agent fleet + conductor.

${log.bold('Flags:')}
  --template <name>      Pick a starter template (default: minimal).
  --out <path>           Output recipe path (default: ./<name>.json).
  --help, -h             Show this message.
`;

async function handleInit(argv: string[]): Promise<number> {
  const flags = mri(argv, {
    boolean: ['help'],
    string: ['template', 'out'],
    alias: { h: 'help' },
  });

  if (flags.help) {
    process.stdout.write(INIT_USAGE);
    return 0;
  }

  const [name] = flags._ as string[];
  if (!name) {
    log.error('init: missing recipe name');
    process.stderr.write(`\n${INIT_USAGE}`);
    return 1;
  }

  const template = (flags.template ?? 'minimal') as TemplateName;
  const knownTemplates = listTemplates().map((t) => t.name);
  if (!knownTemplates.includes(template)) {
    log.error(`init: unknown template "${template}". Known: ${knownTemplates.join(', ')}`);
    return 1;
  }

  const outPath = resolve(flags.out ?? `./${slugify(name)}.json`);
  try {
    const result = scaffoldRecipe(name, template, outPath);
    log.success(`scaffolded ${result.written.length} file${result.written.length === 1 ? '' : 's'}:`);
    for (const p of result.written) {
      process.stdout.write(`    ${log.dim(p)}\n`);
    }
    log.info('');
    log.info(`Next: ${log.bold(`cook check ${outPath}`)} to verify, then ${log.bold(`cook build ${outPath}`)}.`);
    return 0;
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

const SUBCOMMANDS: Record<string, SubcommandHandler> = {
  build: handleBuild,
  // `connectome cook <recipe>` — the image-baking case, named after the tool
  // that grew into this installer.
  cook: handleBuild,
  install: handleInstall,
  run: handleRun,
  check: handleCheck,
  init: handleInit,
};

export async function main(argv: string[]): Promise<void> {
  const first = argv[0];

  if (first === '--version' || first === '-V') {
    process.stdout.write(`${pkg.name} ${pkg.version}\n`);
    process.exit(0);
  }

  if (!first) {
    process.stdout.write(USAGE);
    process.exit(1);
  }

  if (first === '--help' || first === '-h') {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  const handler = SUBCOMMANDS[first];
  if (!handler) {
    log.error(`unknown command: ${first}`);
    process.stderr.write(`\n${USAGE}`);
    process.exit(1);
  }

  const exitCode = await handler(argv.slice(1));
  process.exit(exitCode);
}
