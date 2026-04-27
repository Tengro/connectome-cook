/**
 * Source detector — Phase 1 of BUILD-PLAN.md.
 *
 * Pure function. Walks each recipe's `mcpServers` and produces a deduplicated
 * list of `McpSource` describing what needs to be cloned + installed at image
 * build time.
 *
 * Dedup key: `${normalizedUrl}@${ref || 'main'}`. Normalization strips
 * a trailing `/` and a `.git` suffix so `https://x/y` and `https://x/y.git/`
 * collapse onto the same source. The actual `url` field on the emitted
 * McpSource is whatever the FIRST referencing recipe spelled it as.
 *
 * Behavior for an mcpServer with no `source` block:
 *   - `command === 'npx' || command === 'uvx'` → skipped (recipe declares
 *     how to fetch the MCP at runtime; no clone needed at build time).
 *   - strict mode → collected, then ONE error thrown listing every unresolved
 *     `(recipePath, mcpServerName)` pair.
 *   - non-strict mode → emit a sibling-copy entry. Operator must supply a
 *     checkout adjacent to the recipe at build time.
 */

import { basename } from 'node:path';
import type {
  InstallPattern,
  McpSource,
  SourceRef,
  WalkResult,
} from './types.js';
import type { RecipeMcpServerSource } from './vendor/recipe.js';

export interface DetectOptions {
  strict: boolean;
}

/**
 * Strip trailing `/` and `.git` for stable deduplication. The original URL
 * is preserved in the McpSource for the Dockerfile generator to consume.
 */
function normalizeUrlForKey(url: string): string {
  let normalized = url.trim();
  // Strip any number of trailing slashes first, then `.git`, then any
  // remaining trailing slash that the .git unmasked. Idempotent.
  normalized = normalized.replace(/\/+$/, '');
  if (normalized.endsWith('.git')) {
    normalized = normalized.slice(0, -4);
  }
  normalized = normalized.replace(/\/+$/, '');
  return normalized;
}

/**
 * Default in-container path: `/${basename(url)}` with `.git` stripped.
 * Examples:
 *   https://github.com/x/zulip_mcp.git → /zulip_mcp
 *   https://github.com/x/zulip_mcp     → /zulip_mcp
 *   https://github.com/x/zulip_mcp/    → /zulip_mcp
 */
function defaultInContainerPath(url: string): string {
  // basename() honors path separators only, so we must trim trailing
  // slashes first to match URLs like `.../foo/`.
  const trimmed = url.trim().replace(/\/+$/, '');
  const withoutGit = trimmed.endsWith('.git') ? trimmed.slice(0, -4) : trimmed;
  const name = basename(withoutGit);
  return `/${name}`;
}

/**
 * Map a recipe-shaped `install` field to our internal `InstallPattern`.
 * `undefined` → custom-with-no-build-step (operator must rely on the source
 * being directly executable, e.g. a precompiled `bin/` checked into git).
 */
function mapInstall(
  install: RecipeMcpServerSource['install'] | undefined,
): InstallPattern {
  if (install === 'npm') return { kind: 'npm' };
  if (install === 'pip-editable') return { kind: 'pip-editable' };
  if (install && typeof install === 'object') {
    return { kind: 'custom', run: install.run, runtime: install.runtime };
  }
  return { kind: 'custom', run: '', runtime: 'custom' };
}

/**
 * Equality check between two install patterns. Used only to decide whether
 * to emit a divergence warning when the same source key appears with
 * conflicting metadata across recipes.
 */
function installEquals(a: InstallPattern, b: InstallPattern): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'custom' && b.kind === 'custom') {
    return a.run === b.run && a.runtime === b.runtime;
  }
  if (a.kind === 'sibling-copy' && b.kind === 'sibling-copy') {
    return a.siblingDir === b.siblingDir;
  }
  return true; // npm vs npm, pip-editable vs pip-editable
}

function describeInstall(install: InstallPattern): string {
  if (install.kind === 'custom') {
    return `custom(runtime=${install.runtime}, run=${JSON.stringify(install.run)})`;
  }
  if (install.kind === 'sibling-copy') {
    return `sibling-copy(${install.siblingDir})`;
  }
  return install.kind;
}

/** Emit a stderr warning about a metadata conflict. */
function warnConflict(
  key: string,
  field: string,
  first: { ref: SourceRef; value: string },
  next: { ref: SourceRef; value: string },
): void {
  process.stderr.write(
    `[source-detector] WARN: source ${key} has divergent ${field} — ` +
      `${first.ref.recipePath}#${first.ref.mcpServerName} says ${first.value}, ` +
      `${next.ref.recipePath}#${next.ref.mcpServerName} says ${next.value}; ` +
      `keeping the first.\n`,
  );
}

/**
 * Inspect every walker result, every mcpServer entry, and produce the
 * deduplicated list of sources we need at image build time.
 *
 * Throws an aggregated error in strict mode when any mcpServer lacks both
 * `source` and a runtime fetch command (npx/uvx).
 */
export function detectSources(
  walks: WalkResult[],
  options: DetectOptions,
): McpSource[] {
  /** Insertion-ordered map of dedup key → source under construction. */
  const byKey = new Map<string, McpSource>();
  /** Unresolved entries to either error on (strict) or shim (non-strict). */
  const unresolved: Array<{ recipePath: string; mcpServerName: string }> = [];

  for (const walk of walks) {
    const servers = walk.recipe.mcpServers;
    if (!servers) continue;

    for (const [serverName, server] of Object.entries(servers)) {
      const ref: SourceRef = { recipePath: walk.path, mcpServerName: serverName };

      if (server.source) {
        addSourcedServer(byKey, server.source, ref);
        continue;
      }

      // No source block. Either skip (npx/uvx) or fall through to unresolved.
      if (isRuntimeFetchCommand(server.command)) continue;
      unresolved.push({ recipePath: walk.path, mcpServerName: serverName });
    }
  }

  // Strict mode: aggregate every unresolved entry into a single error so the
  // operator sees them all at once instead of fixing-and-rerunning.
  if (options.strict && unresolved.length > 0) {
    const lines = unresolved
      .map((u) => `  - ${u.recipePath} :: ${u.mcpServerName}`)
      .join('\n');
    throw new Error(
      `Recipe(s) reference MCP servers without a 'source' block (strict mode):\n${lines}\n` +
        `Either add a 'source' block, change the command to 'npx'/'uvx', or rerun without --strict.`,
    );
  }

  // Non-strict mode: turn each unresolved entry into a sibling-copy shim.
  for (const u of unresolved) {
    addSiblingCopySource(byKey, u.recipePath, u.mcpServerName);
  }

  return Array.from(byKey.values());
}

/**
 * Some recipe commands (npx, uvx) fetch and run the MCP server on the fly
 * at runtime — we don't need to clone or install them at image build time.
 */
function isRuntimeFetchCommand(command: string | undefined): boolean {
  return command === 'npx' || command === 'uvx';
}

/**
 * Insert (or merge into) the dedup map for a server with an explicit source.
 * First-write-wins on metadata; subsequent divergences are warned.
 */
function addSourcedServer(
  byKey: Map<string, McpSource>,
  source: RecipeMcpServerSource,
  ref: SourceRef,
): void {
  const refStr = source.ref ?? 'main';
  const key = `${normalizeUrlForKey(source.url)}@${refStr}`;
  const install = mapInstall(source.install);
  const inContainerPath = source.inContainer?.path ?? defaultInContainerPath(source.url);

  const existing = byKey.get(key);
  if (!existing) {
    const newSource: McpSource = {
      key,
      url: source.url,
      ref: refStr,
      install,
      inContainerPath,
      refs: [ref],
      ...(source.authSecret !== undefined ? { authSecret: source.authSecret } : {}),
      ...(source.sslBypass !== undefined ? { sslBypass: source.sslBypass } : {}),
    };
    byKey.set(key, newSource);
    return;
  }

  // Existing entry: append the ref, warn on any metadata divergence, keep
  // first-write-wins semantics.
  const firstRef = existing.refs[0]!;

  if (existing.url !== source.url) {
    warnConflict(
      key,
      'url',
      { ref: firstRef, value: existing.url },
      { ref, value: source.url },
    );
  }
  if (!installEquals(existing.install, install)) {
    warnConflict(
      key,
      'install',
      { ref: firstRef, value: describeInstall(existing.install) },
      { ref, value: describeInstall(install) },
    );
  }
  if ((existing.sslBypass ?? false) !== (source.sslBypass ?? false)) {
    warnConflict(
      key,
      'sslBypass',
      { ref: firstRef, value: String(existing.sslBypass ?? false) },
      { ref, value: String(source.sslBypass ?? false) },
    );
  }
  if ((existing.authSecret ?? '') !== (source.authSecret ?? '')) {
    warnConflict(
      key,
      'authSecret',
      { ref: firstRef, value: existing.authSecret ?? '(none)' },
      { ref, value: source.authSecret ?? '(none)' },
    );
  }
  if (existing.inContainerPath !== inContainerPath) {
    warnConflict(
      key,
      'inContainerPath',
      { ref: firstRef, value: existing.inContainerPath },
      { ref, value: inContainerPath },
    );
  }

  existing.refs.push(ref);
}

/**
 * Sibling-copy fallback: emit one entry per (recipe, server) pair, since we
 * have no URL/ref to dedup on. Key is `sibling:<serverName>`.
 */
function addSiblingCopySource(
  byKey: Map<string, McpSource>,
  recipePath: string,
  serverName: string,
): void {
  const key = `sibling:${serverName}`;
  const ref: SourceRef = { recipePath, mcpServerName: serverName };

  const existing = byKey.get(key);
  if (existing) {
    existing.refs.push(ref);
    return;
  }

  byKey.set(key, {
    key,
    url: '',
    ref: '',
    install: { kind: 'sibling-copy', siblingDir: serverName },
    inContainerPath: `/${serverName}`,
    refs: [ref],
  });
}
