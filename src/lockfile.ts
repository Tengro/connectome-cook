/**
 * connectome.lock — the record of resolution.
 *
 * Written by every backend next to its output; consumed by `cook run`
 * (launch the materialized artifact without re-resolving) and by repeat
 * installs (idempotent reconcile: a component whose url+ref+install match
 * the lock — and whose target directory exists — is skipped, not re-cloned).
 *
 * Secrets never land here — values live in the backend's .env. The lock
 * records WHAT was materialized (components, commits, paths, answered
 * requirements), not credentials.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const LOCKFILE_NAME = 'connectome.lock';

export interface LockedComponent {
  /** Dedup key from the plan (`url@ref`, `ext:<name>`, `sibling:<name>`). */
  key: string;
  /** 'mcp' | 'extension' — mirrors McpSource.role. */
  role: 'mcp' | 'extension';
  url: string;
  ref: string;
  /** Commit SHA actually checked out (host backend fills after clone;
   *  docker backend leaves undefined until --pin-refs lands). */
  commit?: string;
  /** Materialized path: in-container path (docker) or host path (host). */
  path: string;
  /** Human description of the install pattern applied. */
  install: string;
}

export interface LockedRequirement {
  name: string;
  envName: string;
  value?: string;
  origin: string;
}

export interface Lockfile {
  version: 1;
  /** Which backend materialized this directory. */
  backend: 'docker' | 'host';
  /** The recipe path/URL the operator named at resolve time. */
  recipePath: string;
  /** ISO timestamp of the materialization. */
  createdAt: string;
  /** connectome-host provenance. */
  connectomeHost: { url: string; ref: string; commit?: string; path?: string };
  components: LockedComponent[];
  /** Local extension bundles (name → source dir on the operator's disk). */
  localExtensions: Array<{ name: string; hostDir: string; path: string }>;
  requirements: LockedRequirement[];
  /** Backend-specific launch hint: compose dir (docker) or launcher path (host). */
  launch: { kind: 'compose'; dir: string } | { kind: 'script'; script: string };
}

export function writeLockfile(dir: string, lock: Lockfile): void {
  writeFileSync(join(dir, LOCKFILE_NAME), JSON.stringify(lock, null, 2) + '\n');
}

export function readLockfile(dir: string): Lockfile | null {
  const path = join(dir, LOCKFILE_NAME);
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as Lockfile;
  if (raw.version !== 1) {
    throw new Error(`${path}: unsupported lockfile version ${String(raw.version)}`);
  }
  return raw;
}
