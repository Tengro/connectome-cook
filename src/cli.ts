import mri from 'mri';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { log } from './log.js';
import type { SubcommandHandler } from './types.js';
import { walkRecipe } from './walker.js';
import { detectSources } from './source-detector.js';
import { collectEnvVars } from './env-collector.js';

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

const CHECK_USAGE = `${log.bold('cook check')} — validate a recipe + summarize what cook would build.

${log.bold('Usage:')}
  cook check <recipe-path-or-url> [flags]

${log.bold('Flags:')}
  --strict               Fail if any MCP server lacks a \`source\` block
  --json                 Machine-readable report (TODO)
  --help, -h             Show this message
`;

async function handleBuild(_argv: string[]): Promise<number> {
  log.error('build: not yet implemented (Phase 2 of BUILD-PLAN.md).');
  return 64;
}

async function handleRun(_argv: string[]): Promise<number> {
  log.error('run: not yet implemented (Phase 3 of BUILD-PLAN.md).');
  return 64;
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
