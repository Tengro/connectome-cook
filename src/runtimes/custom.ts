import type { McpSource } from '../types.js';
import {
  gitCheckoutCommand,
  gitCloneCommand,
  secretMountFlag,
} from './index.js';

/** Custom install: the recipe's `source.install` is `{ run, runtime }`.
 *  Base image follows the declared runtime (`node`/`python3`/`custom`/`bun`).
 *  Clones + runs the operator script AT `source.inContainerPath` for
 *  parity with the npm/pip runtimes — see DESIGN-NOTES.md "venv
 *  portability lies".  Operator scripts execute with cwd = inContainerPath.
 */

const RUNTIME_BASES: Record<'node' | 'python3' | 'custom' | 'bun', string> = {
  node: 'node:20-bookworm-slim',
  python3: 'python:3.12-bookworm',
  custom: 'debian:bookworm-slim',
  bun: 'oven/bun:1-debian',
};

export const baseImage: string = RUNTIME_BASES.custom;

export function installSteps(source: McpSource): string {
  if (source.install.kind !== 'custom') {
    throw new Error(`custom runtime called with install.kind=${source.install.kind}`);
  }
  const target = source.inContainerPath;
  const clone = gitCloneCommand(source, target);
  const checkout = gitCheckoutCommand(source);
  const secret = secretMountFlag(source);
  const runCommand = source.install.run.trim();

  const cloneStep = `RUN ${secret}${clone}${checkout ? ` \\\n && cd ${target}${checkout}` : ''}`;
  if (!runCommand) {
    // No build step — just clone (e.g. tool runs the source files directly at runtime).
    return cloneStep;
  }
  return [cloneStep, `RUN cd ${target} \\\n && ${runCommand}`].join('\n');
}

/** The dockerfile generator picks the base image per source's runtime field —
 *  exposed here so callers don't have to duplicate the table. */
export function baseImageFor(source: McpSource): string {
  if (source.install.kind !== 'custom') return baseImage;
  return RUNTIME_BASES[source.install.runtime];
}
