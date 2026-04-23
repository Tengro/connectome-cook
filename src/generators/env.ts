/**
 * `.env.example` generator — Phase 2 of BUILD-PLAN.md.
 *
 * Pure function. Templates a `.env.example` file the operator copies to `.env`
 * and fills in. Bundles every variable any recipe in the walked tree references
 * (via `${VAR}` substitution) plus the `authSecret` of each MCP source that
 * needs a secret at image-build time (BuildKit secret mount).
 *
 * Output layout (sections separated by `# --- <heading> ---` rules):
 *   1. Header comment naming the parent recipe.
 *   2. Required — ANTHROPIC_API_KEY (always; membrane reads it directly from
 *      process.env, not via recipe substitution) plus every recipe-referenced
 *      env var that doesn't match the optional-allowlist heuristic.
 *   3. Build-time secrets — one entry per `source.authSecret` with a comment
 *      pointing the operator at `docker build --secret id=<NAME>,env=<NAME>`.
 *      Same value typically also lives in .env for runtime use.
 *   4. Optional — anything matching the optional heuristic, commented out by
 *      default with a placeholder.
 *   5. Notes — final operator-facing notes block.
 *
 * Placeholder heuristics for required-section values:
 *   - `ANTHROPIC_API_KEY` → `sk-ant-...` (special-case)
 *   - name contains `TOKEN`/`KEY`/`SECRET` → `<scheme>-...` based on prefix
 *     (`GITLAB_*` → `glpat-...`, `GITHUB_*` → `ghp_...`, `*` → `sk-...`)
 *   - name contains `URL` → `https://...`
 *   - everything else → `<set me>`
 *
 * Lines are UNIX-newline only. The operator pipeline assumes `.env`-shaped
 * input which is line-based; CRLF would corrupt values on read.
 */

import type { GeneratorInput, EnvVar, McpSource } from '../types.js';

/**
 * Names matching any of these patterns are treated as optional and emitted
 * commented-out in the Optional section instead of the Required section.
 */
const OPTIONAL_NAME_PATTERNS: RegExp[] = [
  /^MODEL$/,
  /_MODEL$/,
  /^MODEL_/,
  /_OPTIONAL$/,
  /^OPTIONAL_/,
  /^DEBUG$/,
  /_DEBUG$/,
  /^LOG_LEVEL$/,
];

/** True if the env-var name matches an optional-allowlist pattern. */
function isOptionalName(name: string): boolean {
  return OPTIONAL_NAME_PATTERNS.some((re) => re.test(name));
}

/**
 * Pick a placeholder value based on the variable name. Heuristic — covers the
 * common cases (tokens, URLs); falls back to `<set me>` for anything unknown.
 */
function placeholderFor(name: string): string {
  if (name === 'ANTHROPIC_API_KEY') return 'sk-ant-...';
  if (name.includes('URL')) return 'https://...';
  if (/TOKEN|KEY|SECRET|PASS/.test(name)) {
    if (name.startsWith('GITLAB_')) return 'glpat-...';
    if (name.startsWith('GITHUB_')) return 'ghp_...';
    return 'sk-...';
  }
  return '<set me>';
}

/**
 * Render a one-line "used by ..." comment for a recipe-referenced env var.
 *
 * Picks the first usage site as the canonical mention and adds a "(+N more)"
 * suffix when there are multiple. Recipe path is shown as basename to keep
 * the line readable.
 */
function describeUsage(envVar: EnvVar): string {
  const uses = envVar.usedIn;
  if (uses.length === 0) {
    return `# Referenced via \${${envVar.name}} in the recipe tree.`;
  }
  const first = uses[0]!;
  const recipeName = first.recipePath.split('/').pop() ?? first.recipePath;
  const more = uses.length > 1 ? ` (+${uses.length - 1} more)` : '';
  return `# Used by ${first.jsonPath} in ${recipeName}${more}.`;
}

/** Build-time secrets section: one block per source with a non-empty `authSecret`. */
function buildBuildTimeSecretsSection(sources: McpSource[]): string[] {
  const lines: string[] = [];
  // Dedupe by secret name — multiple sources may share a token.
  const byName = new Map<string, McpSource[]>();
  for (const src of sources) {
    if (!src.authSecret) continue;
    const list = byName.get(src.authSecret) ?? [];
    list.push(src);
    byName.set(src.authSecret, list);
  }
  if (byName.size === 0) return lines;

  lines.push('# --- Build-time secrets ---');
  lines.push('');
  // Stable order: sort by secret name.
  const names = Array.from(byName.keys()).sort();
  for (const name of names) {
    const consumers = byName.get(name)!;
    const consumerDesc = consumers
      .map((s) => s.url || s.refs[0]?.mcpServerName || '<unknown>')
      .join(', ');
    lines.push(`# Build-time only: pass via \`docker build --secret id=${name},env=${name}\`.`);
    lines.push(`# Same env value typically also lives in .env for runtime use.`);
    lines.push(`# Consumed by: ${consumerDesc}`);
    lines.push(`${name}=${placeholderFor(name)}`);
    lines.push('');
  }
  return lines;
}

/** Required section: always-present ANTHROPIC_API_KEY + non-optional recipe vars. */
function buildRequiredSection(envVars: EnvVar[]): string[] {
  const lines: string[] = [];
  lines.push('# --- Required ---');
  lines.push('');

  // Always: ANTHROPIC_API_KEY. Even if the recipes don't reference
  // ${ANTHROPIC_API_KEY}, membrane reads it directly from process.env.
  lines.push(
    '# Anthropic API key. Read directly from process.env by membrane (not',
  );
  lines.push(
    '# substituted into the recipe), so it is required regardless of whether',
  );
  lines.push('# any recipe mentions it. Get one from console.anthropic.com.');
  lines.push(`ANTHROPIC_API_KEY=${placeholderFor('ANTHROPIC_API_KEY')}`);
  lines.push('');

  // Recipe-referenced vars that aren't ANTHROPIC_API_KEY (already emitted)
  // and aren't optional-flavored.
  for (const envVar of envVars) {
    if (envVar.name === 'ANTHROPIC_API_KEY') continue;
    if (isOptionalName(envVar.name)) continue;
    lines.push(describeUsage(envVar));
    lines.push(`${envVar.name}=${placeholderFor(envVar.name)}`);
    lines.push('');
  }

  return lines;
}

/** Optional section: recipe-referenced vars matching the optional heuristic, commented out. */
function buildOptionalSection(envVars: EnvVar[]): string[] {
  const lines: string[] = [];
  const optionals = envVars.filter((v) => isOptionalName(v.name));
  if (optionals.length === 0) return lines;

  lines.push('# --- Optional ---');
  lines.push('');
  for (const envVar of optionals) {
    lines.push(describeUsage(envVar));
    // Commented-out by default — operator uncomments to override.
    lines.push(`# ${envVar.name}=${placeholderFor(envVar.name)}`);
    lines.push('');
  }
  return lines;
}

/** Notes section: operator-facing reminders that aren't variable definitions. */
function buildNotesSection(input: GeneratorInput): string[] {
  const lines: string[] = [];
  lines.push('# --- Notes ---');
  lines.push('');
  lines.push(
    '# - Copy this file to `.env` and fill in real values before `docker compose up`.',
  );
  lines.push(
    '# - Lines beginning with `#` are comments. `KEY=value` pairs (no quotes needed',
  );
  lines.push(
    '#   for simple values) are picked up by docker-compose at container start.',
  );

  // Per the design notes / example: if a recipe references GitLab, mention
  // the opt-out path. Detected by env-var presence, not by recipe scanning,
  // so we don't depend on having a richer source-detector view.
  const hasGitlab = input.envVars.some((v) => v.name.startsWith('GITLAB_'));
  if (hasGitlab) {
    lines.push(
      '# - If you don\'t have GitLab access, remove the `gitlab` block from',
    );
    lines.push(
      '#   recipes/knowledge-miner.json before running `docker compose up`.',
    );
  }

  // Hint about build-time secrets if any are present.
  const hasBuildSecrets = input.sources.some((s) => !!s.authSecret);
  if (hasBuildSecrets) {
    lines.push(
      '# - Build-time secret values listed above must ALSO be exported in your',
    );
    lines.push(
      '#   shell when running `docker build` so that `--secret id=NAME,env=NAME`',
    );
    lines.push('#   can pick them up.');
  }

  return lines;
}

/**
 * Build the full `.env.example` text.
 *
 * Output is a sequence of section blocks separated by blank lines. Always ends
 * with a single trailing newline (POSIX-friendly). UNIX line endings only.
 */
export function generateEnv(input: GeneratorInput): string {
  const parentRecipe = input.walks[0]?.recipe;
  const recipeName = parentRecipe?.name ?? 'unnamed recipe';

  const lines: string[] = [];

  // Header comment.
  lines.push(`# ${recipeName} — environment variables`);
  lines.push('# Copy to .env and fill in. docker-compose reads this file at container');
  lines.push('# startup and exposes the values to the agents.');
  lines.push('');

  // Sections, in order.
  lines.push(...buildRequiredSection(input.envVars));
  lines.push(...buildBuildTimeSecretsSection(input.sources));
  lines.push(...buildOptionalSection(input.envVars));
  lines.push(...buildNotesSection(input));

  // Collapse any trailing blank lines into a single trailing newline.
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines.join('\n') + '\n';
}
