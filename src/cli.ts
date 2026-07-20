import mri from 'mri';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { log } from './log.js';
import { slugify } from './slug.js';
import type { SubcommandHandler } from './types.js';
import type { Recipe } from './vendor/recipe.js';
import { walkRecipe } from './walker.js';
import { detectSources } from './source-detector.js';
import { detectExtensions } from './extension-detector.js';
import { collectEnvVars } from './env-collector.js';
import { resolvePlan } from './plan.js';
import { runDockerBackend, type BuildResult } from './backends/docker.js';
import { listTemplates, scaffoldRecipe, type TemplateName } from './init.js';

const pkg = JSON.parse(
  readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'),
    'utf-8',
  ),
) as { name: string; version: string };

const USAGE = `${log.bold('connectome-cook')} — recipes in, Docker images out.

${log.bold('Usage:')}
  cook <command> [args] [flags]

${log.bold('Commands:')}
  build <recipe>         Generate Docker artifacts for a recipe
  run <recipe>           Build, then \`docker compose up\`
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
  --pin-refs             Resolve branch refs to current SHAs (Phase 4)
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

  if (flags['pin-refs']) {
    log.warn('--pin-refs: not yet implemented; branch refs baked literally');
  }

  const planResult = await resolvePlan(recipePath, {
    strict: !!flags.strict,
    noPrompts: flags.prompts === false,
    envFile: flags['env-file'],
  });
  if (!planResult.ok) {
    return { exitCode: planResult.exitCode, outDir: '' };
  }

  const outDir = resolve(flags.out ?? defaultOutDir(planResult.plan.parentWalk.recipe));
  return runDockerBackend(planResult.plan, {
    outDir,
    noPrompts: flags.prompts === false,
    envFile: flags['env-file'],
    strict: !!flags.strict,
    imageName: flags['image-name'],
    pinRefs: !!flags['pin-refs'],
    allowIncompleteTemplates: !!flags['allow-incomplete-templates'],
  });
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

const RUN_USAGE = `${log.bold('cook run')} — build then \`docker compose up\` from the cook output dir.

${log.bold('Usage:')}
  cook run <recipe-path-or-url> [build-flags] [-- compose-args]

Build flags are the same as ${log.bold('cook build')}.  Anything after \`--\` is
passed through to \`docker compose up\` (e.g. \`-- -d\` for detached).

By default cook runs ${log.dim('docker compose up --build')} attached so you can
see the TUI directly.  Use ${log.dim('-- -d')} for detached.
`;

async function handleRun(argv: string[]): Promise<number> {
  // Split argv at the `--` separator: anything before goes to build,
  // anything after goes to docker compose.
  const sep = argv.indexOf('--');
  const buildArgs = sep === -1 ? argv : argv.slice(0, sep);
  const composeArgs = sep === -1 ? [] : argv.slice(sep + 1);

  if (buildArgs.includes('--help') || buildArgs.includes('-h')) {
    process.stdout.write(RUN_USAGE);
    return 0;
  }

  const buildResult = await runBuildPipeline(buildArgs);
  if (buildResult.exitCode !== 0) {
    return buildResult.exitCode;
  }

  log.step(`docker compose up in ${log.dim(buildResult.outDir)}`);
  const composeFinalArgs = composeArgs.length > 0 ? ['up', ...composeArgs] : ['up', '--build'];
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
