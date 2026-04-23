import type { McpSource } from '../types.js';
import {
  gitCheckoutCommand,
  gitCloneCommand,
  repoBasename,
  secretMountFlag,
} from './index.js';

export const baseImage = 'node:20-bookworm-slim';

/** RUN blocks for a clone + `npm install && npm run build` pattern.
 *  Caller (dockerfile generator) wraps these in a builder stage:
 *    FROM <baseImage> AS <stage>
 *    RUN apt-get install -y git ca-certificates  (provided by generator)
 *    WORKDIR /build
 *    <these RUN blocks>
 *  and copies `/build/<basename>` into the runtime stage at inContainerPath. */
export function installSteps(source: McpSource): string {
  const dir = repoBasename(source.url);
  const clone = gitCloneCommand(source);
  const checkout = gitCheckoutCommand(source);
  const secret = secretMountFlag(source);
  return [
    `RUN ${secret}${clone}${checkout ? ` \\\n && cd ${dir}${checkout}` : ''}`,
    `RUN cd ${dir} \\\n && npm install --no-audit --no-fund \\\n && npm run build`,
  ].join('\n');
}
