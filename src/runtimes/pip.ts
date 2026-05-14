import type { McpSource } from '../types.js';
import {
  gitCheckoutCommand,
  gitCloneCommand,
  secretMountFlag,
} from './index.js';

export const baseImage = 'python:3.12-bookworm';

/** RUN blocks for clone + `python3 -m venv .venv && pip install -e .` at
 *  `source.inContainerPath` — the same absolute path the runtime stage
 *  copies the build out to.  Building at the final path makes pip write
 *  entry-point shebangs (`#!<inContainerPath>/.venv/bin/python3`) and a
 *  `pyvenv.cfg` `home =` line that remain valid across the cross-stage
 *  COPY, so the resulting scripts execute without rewrite.  Building at
 *  a different builder-stage path (the old `/build/<basename>` layout)
 *  leaks that path into the venv and yields ENOENT at exec time —
 *  see DESIGN-NOTES.md "venv portability lies".
 *  The runtime image must provide python3 at the same path used to
 *  create the venv (the dockerfile generator apt-installs python3 in
 *  the runtime stage when any source uses this runtime). */
export function installSteps(source: McpSource): string {
  const target = source.inContainerPath;
  const clone = gitCloneCommand(source, target);
  const checkout = gitCheckoutCommand(source);
  const secret = secretMountFlag(source);
  return [
    `RUN ${secret}${clone}${checkout ? ` \\\n && cd ${target}${checkout}` : ''}`,
    `RUN cd ${target} \\\n && python3 -m venv .venv \\\n && .venv/bin/pip install --no-cache-dir --upgrade pip \\\n && .venv/bin/pip install --no-cache-dir -e .`,
  ].join('\n');
}
