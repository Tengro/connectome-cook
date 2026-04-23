import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { log } from './log.js';
import type { SubcommandHandler } from './types.js';

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

async function handleBuild(_argv: string[]): Promise<number> {
  log.error('build: not yet implemented (Phase 2 of BUILD-PLAN.md).');
  return 64;
}

async function handleRun(_argv: string[]): Promise<number> {
  log.error('run: not yet implemented (Phase 3 of BUILD-PLAN.md).');
  return 64;
}

async function handleCheck(_argv: string[]): Promise<number> {
  log.error('check: not yet implemented (Phase 1/4 of BUILD-PLAN.md).');
  return 64;
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
