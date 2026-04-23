/**
 * Per-install-pattern Dockerfile fragment generators.
 *
 * Each runtime module exports `installSteps(source)` returning the RUN
 * block(s) (clone + build) that go inside a builder stage.  The dockerfile
 * generator (Phase 2) wraps these with `FROM <baseImage> AS <stage>` and
 * `WORKDIR /build`, and adds the matching `COPY --from=<stage>` to the
 * runtime stage.
 */

import type { InstallPattern, McpSource } from '../types.js';
import * as npm from './npm.js';
import * as pip from './pip.js';
import * as custom from './custom.js';

export interface RuntimeModule {
  /** Default base image for the builder stage.  Operator may override. */
  baseImage: string;
  /** RUN block(s) for clone + install of one source.  Multi-line OK; the
   *  generator splices the result directly into a `FROM <baseImage> AS <stage>`
   *  block after `WORKDIR /build`. */
  installSteps(source: McpSource): string;
}

export function getRuntime(install: InstallPattern): RuntimeModule {
  switch (install.kind) {
    case 'npm': return npm;
    case 'pip-editable': return pip;
    case 'custom': return custom;
    case 'sibling-copy':
      throw new Error(
        'sibling-copy install has no builder stage — the Dockerfile generator ' +
        'handles it via a runtime-stage COPY of an operator-supplied checkout.',
      );
  }
}

/** Strip trailing slashes and `.git`, then return the last URL path segment.
 *  Used for both the in-container default path and the build-stage workdir. */
export function repoBasename(url: string): string {
  const trimmed = url.replace(/\/+$/, '').replace(/\.git$/, '');
  return trimmed.split('/').pop() ?? trimmed;
}

/** Assemble `git clone` honoring sslBypass and authSecret.
 *  When `authSecret` is set, the URL embeds an `oauth2:${TOKEN}` userinfo
 *  segment.  The caller is responsible for adding the matching
 *  `--mount=type=secret` flag to the RUN line. */
export function gitCloneCommand(source: McpSource): string {
  const sslArg = source.sslBypass ? '-c http.sslVerify=false ' : '';
  if (source.authSecret) {
    const stripped = source.url.replace(/^https?:\/\//, '');
    return `git ${sslArg}clone "https://oauth2:\${${source.authSecret}}@${stripped}"`;
  }
  return `git ${sslArg}clone ${source.url}`;
}

/** Optional `&& cd <dir> && git checkout <ref>` tail.  Empty when ref is
 *  unset or "main".  Refspec form (`refs/...`) gets a fetch+checkout dance. */
export function gitCheckoutCommand(source: McpSource): string {
  if (!source.ref || source.ref === 'main') return '';
  if (source.ref.startsWith('refs/')) {
    return ` && git fetch origin ${source.ref}:cook-build-checkout && git checkout cook-build-checkout`;
  }
  return ` && git checkout ${source.ref}`;
}

/** RUN-line prefix for a step that needs a BuildKit secret mounted as env.
 *  Returns `--mount=type=secret,id=NAME,env=NAME ` when authSecret is set,
 *  empty otherwise.  Splice into a `RUN ${this} <command>` template. */
export function secretMountFlag(source: McpSource): string {
  if (!source.authSecret) return '';
  return `--mount=type=secret,id=${source.authSecret},env=${source.authSecret} `;
}
