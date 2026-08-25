/**
 * Per-install-pattern Dockerfile fragment generators.
 *
 * Each runtime module exports `installSteps(source)` returning the RUN
 * block(s) (clone + build) that go inside a builder stage.  Each runtime
 * clones + builds AT `source.inContainerPath` (i.e. at the same absolute
 * path the runtime stage will COPY the result to), so installers that
 * bake absolute paths into their output — pip's entry-point shebangs are
 * the canonical example — write them with paths that remain valid after
 * the cross-stage COPY.  See DESIGN-NOTES.md "venv portability lies".
 */

import { basename } from 'node:path';
import type { InstallPattern, McpSource } from '../types.js';
import * as npm from './npm.js';
import * as pip from './pip.js';
import * as custom from './custom.js';

export interface RuntimeModule {
  /** Default base image for the builder stage.  Operator may override. */
  baseImage: string;
  /** RUN block(s) for clone + install of one source at `source.inContainerPath`.
   *  Multi-line OK; the generator splices the result directly into a
   *  `FROM <baseImage> AS <stage>` block. */
  installSteps(source: McpSource): string;
}

export function getRuntime(install: InstallPattern): RuntimeModule {
  switch (install.kind) {
    case 'npm': return npm;
    case 'pip-editable': return pip;
    case 'custom': return custom;
    case 'npm-global':
      throw new Error(
        'npm-global install has no builder stage — the Dockerfile generator ' +
        'handles it via a runtime-stage `npm install -g`.',
      );
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

/** Build-context directory (relative to the cook output dir) that CA
 *  bundles declared via `source.caCert` are copied into. */
export const CA_CERT_CONTEXT_DIR = 'ca-certs';
/** In-image directory the builder stages COPY those bundles to before the
 *  clone runs (mirrors the boter hand-patch's `/tmp/ath-ca.crt` mechanism,
 *  under a cook-owned subdir so nothing else in /tmp is clobbered). */
export const CA_CERT_CONTAINER_DIR = '/tmp/cook-ca';

/** Userinfo usernames are spliced into a double-quoted shell word in a
 *  generated RUN line — the vendored recipe validator enforces this same
 *  charset, but the emitters re-check so a hand-built McpSource can never
 *  smuggle shell metacharacters into a Dockerfile. */
const AUTH_USERNAME_SAFE = /^[A-Za-z0-9._~+-]+$/;
/** Same defense for the CA bundle basename (COPY source + sslCAInfo value). */
const CA_CERT_BASENAME_SAFE = /^[A-Za-z0-9._-]+$/;

/** The clone username for a source: `authUsername`, defaulting to `oauth2`
 *  (the GitLab-PAT convention cook has always emitted). Throws on unsafe
 *  characters — see AUTH_USERNAME_SAFE. */
export function cloneUsername(source: Pick<McpSource, 'authUsername'>): string {
  const username = source.authUsername ?? 'oauth2';
  if (!AUTH_USERNAME_SAFE.test(username)) {
    throw new Error(
      `authUsername ${JSON.stringify(username)} contains characters outside ` +
      `[A-Za-z0-9._~+-] — refusing to splice it into a shell command`,
    );
  }
  return username;
}

/** Validated basename of a source's CA bundle. */
export function caCertBasename(source: McpSource): string {
  if (!source.caCert) {
    throw new Error(`caCertBasename called for source ${source.key} without caCert`);
  }
  const name = basename(source.caCert);
  if (!CA_CERT_BASENAME_SAFE.test(name)) {
    throw new Error(
      `caCert filename ${JSON.stringify(name)} contains characters outside ` +
      `[A-Za-z0-9._-] — rename the CA bundle file`,
    );
  }
  return name;
}

/** In-image path of a source's CA bundle (used by `-c http.sslCAInfo=`). */
export function caCertContainerPath(source: McpSource): string {
  return `${CA_CERT_CONTAINER_DIR}/${caCertBasename(source)}`;
}

/** Build-context-relative path of a source's CA bundle (Dockerfile COPY source). */
export function caCertContextPath(source: McpSource): string {
  return `${CA_CERT_CONTEXT_DIR}/${caCertBasename(source)}`;
}

/** Deduplicate the CA bundles referenced across `sources` by resolved host
 *  path. Two distinct files sharing a basename would collide at the single
 *  in-context/in-image path — fail fast with a rename instruction rather
 *  than silently letting one clone verify against the other's CA. */
export function collectCaCerts(
  sources: McpSource[],
): Array<{ hostPath: string; contextPath: string }> {
  const byBasename = new Map<string, { hostPath: string; contextPath: string }>();
  for (const source of sources) {
    if (!source.caCert) continue;
    const name = caCertBasename(source);
    const existing = byBasename.get(name);
    if (existing && existing.hostPath !== source.caCert) {
      throw new Error(
        `caCert basename collision: ${existing.hostPath} and ${source.caCert} would ` +
        `both be copied to ${CA_CERT_CONTEXT_DIR}/${name} — rename one of the files`,
      );
    }
    if (!existing) {
      byBasename.set(name, {
        hostPath: source.caCert,
        contextPath: `${CA_CERT_CONTEXT_DIR}/${name}`,
      });
    }
  }
  return Array.from(byBasename.values());
}

/** Assemble `git clone` honoring caCert, sslBypass, authSecret, and
 *  authUsername.
 *  Clones into `target` (an explicit absolute path) — the runtime modules
 *  pass `source.inContainerPath` so the clone lands at the same absolute
 *  path the runtime stage will COPY out, which is what keeps pip-written
 *  shebangs valid across the cross-stage COPY.
 *  TLS: `caCert` pins verification to the recipe-declared CA bundle
 *  (`-c http.sslCAInfo=<in-image path>`; the builder stage COPYs the bundle
 *  in first — see the dockerfile generator); `sslBypass` disables
 *  verification entirely. The recipe validator rejects both together;
 *  should a hand-built McpSource carry both anyway, caCert wins — verified
 *  TLS is strictly safer than none.
 *  When `authSecret` is set, the URL embeds a
 *  `<authUsername ?? oauth2>:$(cat /run/secrets/NAME)` userinfo segment —
 *  the secret is read INLINE from the BuildKit-mounted file, never lands in
 *  the process environment, and the caller is responsible for adding the
 *  matching `--mount=type=secret` flag to the RUN line.  We deliberately
 *  use `$(cat ...)` rather than the `env=` option (which needs
 *  docker/dockerfile:1.10+) so this works with any BuildKit that supports
 *  the basic secret mount. */
export function gitCloneCommand(source: McpSource, target: string): string {
  const sslArg = source.caCert
    ? `-c http.sslCAInfo=${caCertContainerPath(source)} `
    : source.sslBypass
      ? '-c http.sslVerify=false '
      : '';
  if (source.authSecret) {
    const stripped = source.url.replace(/^https?:\/\//, '');
    return `git ${sslArg}clone "https://${cloneUsername(source)}:$(cat /run/secrets/${source.authSecret})@${stripped}" ${target}`;
  }
  return `git ${sslArg}clone ${source.url} ${target}`;
}

/** Optional `&& cd <dir> && git checkout <ref>` tail.  Empty when ref is
 *  unset or "main" (and unpinned).  Refspec form (`refs/...`) gets a
 *  fetch+checkout dance.  A --pin-refs commit wins over the symbolic ref —
 *  `git checkout <sha>` after a full clone reproduces the exact tree the
 *  operator pinned. */
export function gitCheckoutCommand(source: McpSource): string {
  if (source.commit) {
    // A plain clone never fetches refs/merge-requests/* or refs/pull/*, so a
    // SHA pinned from such a refspec isn't in the object store yet — fetch
    // the ref before checking out the pin.
    if (source.ref?.startsWith('refs/')) {
      return ` && git fetch origin ${source.ref} && git checkout ${source.commit}`;
    }
    return ` && git checkout ${source.commit}`;
  }
  if (!source.ref || source.ref === 'main') return '';
  if (source.ref.startsWith('refs/')) {
    return ` && git fetch origin ${source.ref}:cook-build-checkout && git checkout cook-build-checkout`;
  }
  return ` && git checkout ${source.ref}`;
}

/** RUN-line prefix for a step that needs a BuildKit secret mounted as a
 *  file at `/run/secrets/NAME`.  The clone command reads the secret with
 *  `$(cat /run/secrets/NAME)` — see gitCloneCommand.  We avoid the
 *  newer `env=NAME` option because that requires
 *  docker/dockerfile:1.10+; the file form works on every supported
 *  BuildKit. */
export function secretMountFlag(source: McpSource): string {
  if (!source.authSecret) return '';
  return `--mount=type=secret,id=${source.authSecret} `;
}
