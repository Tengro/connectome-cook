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

/** A single `npm install -g` RUN line that bakes published registry packages
 *  into the runtime image's global prefix, so a recipe's `npx -y <package>`
 *  resolves the package offline at spawn instead of fetching it on first run
 *  (the cold-boot handshake race). Unlike `installSteps`, this runs in the
 *  runtime stage — npm is already present there because any `npx` command
 *  makes the generator copy node/npm/npx in. `packages` are full specs
 *  (`@scope/name@version`); each is shell-quoted to be safe against the `@`
 *  and any scope slash. Returns '' for an empty list so the caller can splice
 *  unconditionally. */
export function globalInstallStep(packages: string[]): string {
  if (packages.length === 0) return '';
  const quoted = packages.map((p) => `'${p}'`).join(' ');
  return `RUN npm install -g --no-audit --no-fund ${quoted}`;
}
