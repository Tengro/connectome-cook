import mri from 'mri';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, resolve } from 'node:path';
import { log } from './log.js';
import { slugify } from './slug.js';
import type {
  BuildOptions,
  GeneratorInput,
  SubcommandHandler,
  WalkResult,
} from './types.js';
import type { Recipe, RecipeMcpServer } from './vendor/recipe.js';
import { walkRecipe } from './walker.js';
import { detectSources } from './source-detector.js';
import { collectEnvVars } from './env-collector.js';
import { generateDockerfile } from './generators/dockerfile.js';
import { generateCompose } from './generators/compose.js';
import { generateOverlays } from './generators/overlay.js';
import { generateEnv } from './generators/env.js';
import { generateReadme } from './generators/readme.js';
import {
  deriveRequiredVars,
  loadEnvFile,
  promptForVars,
  resolvePresent,
} from './prompts.js';

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

/** Pick the output filename for one walked recipe.  File-paths use basename
 *  as-is so the in-container layout matches what operators wrote.  URLs get
 *  slugified plus `.json`. */
function recipeFilename(walkPath: string): string {
  if (walkPath.startsWith('http://') || walkPath.startsWith('https://')) {
    return `${slugify(walkPath)}.json`;
  }
  return basename(walkPath);
}

/** Default output dir name when --out isn't supplied. */
function defaultOutDir(parentRecipe: Recipe): string {
  return `./${slugify(parentRecipe.name)}-cook`;
}

/** Apply a Partial<Recipe> overlay to a Recipe with shallow per-mcpServer
 *  merge.  Matches the contract `generateOverlays` documents — only the
 *  fields a generator wants to override are present in the overlay. */
function applyOverlay(recipe: Recipe, overlay: Partial<Recipe> | undefined): Recipe {
  if (!overlay) return recipe;
  const merged: Recipe = { ...recipe };
  if (overlay.mcpServers) {
    merged.mcpServers = { ...(recipe.mcpServers ?? {}) };
    for (const [name, overlayServer] of Object.entries(overlay.mcpServers)) {
      const original = recipe.mcpServers?.[name];
      merged.mcpServers[name] = original
        ? { ...original, ...(overlayServer as Partial<RecipeMcpServer>) }
        : (overlayServer as RecipeMcpServer);
    }
  }
  return merged;
}

/** Render a `.env` file body from collected key/value pairs.  Sorted by
 *  key for determinism; each line `KEY=value` with a trailing newline. */
function renderEnvFile(values: Record<string, string>): string {
  const keys = Object.keys(values).sort();
  return keys.map((k) => `${k}=${values[k]}`).join('\n') + (keys.length ? '\n' : '');
}

/** Result of the build pipeline (used by both build and run handlers). */
interface BuildResult {
  exitCode: number;
  outDir: string;
}

async function runBuildPipeline(argv: string[]): Promise<BuildResult> {
  const flags = mri(argv, {
    // mri auto-handles `--no-<flag>` as `flag: false`; we read it as
    // `flags.prompts === false` below.
    boolean: ['help', 'strict', 'pin-refs'],
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

  let walks: WalkResult[];
  try {
    log.step(`walking recipe ${log.dim(recipePath)}`);
    walks = await walkRecipe(recipePath);
    log.success(`loaded ${walks.length} recipe${walks.length === 1 ? '' : 's'}`);
  } catch (err) {
    log.error(`failed to load recipe: ${err instanceof Error ? err.message : String(err)}`);
    return { exitCode: 2, outDir: '' };
  }

  const parentWalk = walks[0];
  if (!parentWalk) {
    log.error('walker returned no recipes — internal error');
    return { exitCode: 2, outDir: '' };
  }

  const outDir = resolve(flags.out ?? defaultOutDir(parentWalk.recipe));

  let sources;
  let envVars;
  try {
    log.step(`detecting MCP sources (${flags.strict ? 'strict' : 'non-strict'})`);
    sources = detectSources(walks, { strict: !!flags.strict });
    envVars = collectEnvVars(walks);
    log.success(
      `detected ${sources.length} MCP source${sources.length === 1 ? '' : 's'}, ` +
      `${envVars.length} env var${envVars.length === 1 ? '' : 's'}`,
    );
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    return { exitCode: 2, outDir };
  }

  // Resolve required env values: process.env → --env-file → interactive prompt.
  const required = deriveRequiredVars(envVars, sources);
  let envFileValues: Record<string, string> = {};
  if (flags['env-file']) {
    try {
      envFileValues = loadEnvFile(resolve(flags['env-file']));
    } catch (err) {
      log.error(err instanceof Error ? err.message : String(err));
      return { exitCode: 1, outDir };
    }
  }
  const { found, missing } = resolvePresent(required, envFileValues);
  let collectedValues: Record<string, string> = { ...found };
  if (missing.length > 0) {
    if ((flags.prompts === false)) {
      log.warn(
        `--no-prompts: ${missing.length} required value${missing.length === 1 ? '' : 's'} ` +
        `still missing — operator must edit .env before \`docker compose up\``,
      );
    } else {
      const result = await promptForVars(missing);
      if (result.cancelled) {
        log.warn('cancelled by user');
        return { exitCode: 1, outDir };
      }
      collectedValues = { ...collectedValues, ...result.values };
    }
  }

  const buildOptions: BuildOptions = {
    outDir,
    noPrompts: flags.prompts === false,
    envFile: flags['env-file'],
    strict: !!flags.strict,
    imageName: flags['image-name'],
    pinRefs: !!flags['pin-refs'],
  };
  const input: GeneratorInput = { walks, sources, envVars, options: buildOptions };

  log.step(`generating artifacts → ${log.dim(outDir)}`);
  let dockerfile: string;
  let compose: string;
  let envExample: string;
  let readme: string;
  let overlays: Map<string, Partial<Recipe>>;
  try {
    dockerfile = generateDockerfile(input);
    compose = generateCompose(input);
    envExample = generateEnv(input);
    readme = generateReadme(input);
    overlays = generateOverlays(input);
  } catch (err) {
    log.error(`generator failed: ${err instanceof Error ? err.message : String(err)}`);
    return { exitCode: 2, outDir };
  }

  const recipesOut = walks.map((walk) => ({
    filename: recipeFilename(walk.path),
    content: JSON.stringify(applyOverlay(walk.recipe, overlays.get(walk.path)), null, 2) + '\n',
  }));

  // Only write .env if we have values worth writing — otherwise the
  // operator gets only .env.example to copy/edit themselves.
  const writeEnvFile = Object.keys(collectedValues).length > 0;

  try {
    mkdirSync(outDir, { recursive: true });
    mkdirSync(join(outDir, 'recipes'), { recursive: true });
    writeFileSync(join(outDir, 'Dockerfile'), dockerfile);
    writeFileSync(join(outDir, 'docker-compose.yml'), compose);
    writeFileSync(join(outDir, '.env.example'), envExample);
    writeFileSync(join(outDir, 'README.md'), readme);
    if (writeEnvFile) {
      writeFileSync(join(outDir, '.env'), renderEnvFile(collectedValues));
    }
    for (const { filename, content } of recipesOut) {
      writeFileSync(join(outDir, 'recipes', filename), content);
    }
  } catch (err) {
    log.error(`write failed: ${err instanceof Error ? err.message : String(err)}`);
    return { exitCode: 3, outDir };
  }

  const overlayCount = Array.from(overlays.values()).length;
  const fileCount = 4 + recipesOut.length + (writeEnvFile ? 1 : 0);
  log.success(`wrote ${fileCount} files to ${outDir}`);
  if (overlayCount > 0) {
    log.info(log.dim(`    (${overlayCount} recipe${overlayCount === 1 ? '' : 's'} have overlays applied)`));
  }
  return { exitCode: 0, outDir };
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
    } else {
      const refLabel = src.ref ? `@${src.ref}` : '';
      process.stdout.write(`    ${log.bold(src.url + refLabel)}  ${log.dim(`(${src.install.kind} → ${src.inContainerPath})`)}  used by: ${refList}\n`);
    }
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

async function handleInit(_argv: string[]): Promise<number> {
  log.error('init: not yet implemented (Phase 4 of BUILD-PLAN.md).');
  return 64;
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
