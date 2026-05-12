import type { McpSource } from '../types.js';
import {
  gitCheckoutCommand,
  gitCloneCommand,
  secretMountFlag,
} from './index.js';

export const baseImage = 'node:20-bookworm-slim';

/** RUN blocks for clone + `npm install && npm run build` at
 *  `source.inContainerPath`.  Caller (dockerfile generator) wraps these
 *  in a builder stage:
 *    FROM <baseImage> AS <stage>
 *    RUN apt-get install -y git ca-certificates  (provided by generator)
 *    <these RUN blocks>
 *  and copies `<inContainerPath>` into the runtime stage at the same path.
 *  Build-at-final-path is uniform across runtimes for parity with pip,
 *  where it's load-bearing (shebang correctness) — for npm it's a
 *  belt-and-suspenders guard against any future package that bakes the
 *  build path into its output. */
export function installSteps(source: McpSource): string {
  const target = source.inContainerPath;
  const clone = gitCloneCommand(source, target);
  const checkout = gitCheckoutCommand(source);
  const secret = secretMountFlag(source);
  return [
    `RUN ${secret}${clone}${checkout ? ` \\\n && cd ${target}${checkout}` : ''}`,
    `RUN cd ${target} \\\n && npm install --no-audit --no-fund \\\n && npm run build`,
  ].join('\n');
}
