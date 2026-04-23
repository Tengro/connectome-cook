import type { McpSource } from '../types.js';
import {
  gitCheckoutCommand,
  gitCloneCommand,
  repoBasename,
  secretMountFlag,
} from './index.js';

export const baseImage = 'python:3.12-bookworm';

/** RUN blocks for a clone + `python3 -m venv .venv && pip install -e .` pattern.
 *  The venv lives inside the cloned source dir so a single COPY brings both
 *  the source and the venv into the runtime stage.  Note: the runtime image
 *  must provide python3 at the same path used to create the venv (e.g. by
 *  using `python:3-slim` as the runtime base) or the venv binaries break. */
export function installSteps(source: McpSource): string {
  const dir = repoBasename(source.url);
  const clone = gitCloneCommand(source);
  const checkout = gitCheckoutCommand(source);
  const secret = secretMountFlag(source);
  return [
    `RUN ${secret}${clone}${checkout ? ` \\\n && cd ${dir}${checkout}` : ''}`,
    `RUN cd ${dir} \\\n && python3 -m venv .venv \\\n && .venv/bin/pip install --no-cache-dir --upgrade pip \\\n && .venv/bin/pip install --no-cache-dir -e .`,
  ].join('\n');
}
