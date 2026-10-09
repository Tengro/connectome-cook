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
 *   2. Required — the Anthropic credential (unless explicitly Codex-only; connectome-host/membrane
 *      read it directly from process.env, not via recipe substitution).
 *      Either ANTHROPIC_API_KEY (emitted uncommented) or ANTHROPIC_AUTH_TOKEN
 *      (long-lived OAuth bearer; emitted as a commented alternative) satisfies
 *      it — when both are set, connectome-host prefers the auth token.
 *      Exception: when a recipe explicitly substitutes `${ANTHROPIC_API_KEY}`
 *      or `${ANTHROPIC_AUTH_TOKEN}` (no default), that name is demanded by
 *      name (conhost throws on a missing `${VAR}` at container start), so the
 *      referenced credential is emitted uncommented with its usage comment
 *      and the either/or guidance is dropped.  Plus every recipe-referenced
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
 *   - `ANTHROPIC_AUTH_TOKEN` → `sk-ant-oat...` (special-case)
 *   - name contains `TOKEN`/`KEY`/`SECRET` → `<scheme>-...` based on prefix
 *     (`GITLAB_*` → `glpat-...`, `GITHUB_*` → `ghp_...`, `*GEMINI*`/`*GOOGLE*`
 *     → `AIza...`, `NOTION_*` → `ntn_...`, `*` → `sk-...`)
 *   - name contains `URL` → `https://...`
 *   - everything else → `<set me>`
 *
 * Lines are UNIX-newline only. The operator pipeline assumes `.env`-shaped
 * input which is line-based; CRLF would corrupt values on read.
 */

import type { GeneratorInput, EnvVar, McpSource } from '../types.js';
import { requiresAnthropicCredential } from '../prompts.js';

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
  if (name === 'ANTHROPIC_AUTH_TOKEN') return 'sk-ant-oat...';
  if (name.includes('URL')) return 'https://...';
  if (/TOKEN|KEY|SECRET|PASS/.test(name)) {
    if (name.startsWith('GITLAB_')) return 'glpat-...';
    if (name.startsWith('GITHUB_')) return 'ghp_...';
    if (name.includes('GEMINI') || name.includes('GOOGLE')) return 'AIza...';
    if (name.startsWith('NOTION_')) return 'ntn_...';
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

/** Required section: provider credential + non-optional recipe vars. */
function buildRequiredSection(envVars: EnvVar[], input: GeneratorInput): string[] {
  const lines: string[] = [];
  lines.push('# --- Required ---');
  lines.push('');

  // For trees that require Anthropic auth, even if recipes don't reference
  // ${ANTHROPIC_API_KEY} / ${ANTHROPIC_AUTH_TOKEN}, connectome-host and
  // membrane read them directly from process.env.
  //
  // When a recipe EXPLICITLY substitutes one of the credential names,
  // connectome-host throws at container start if that exact var is missing
  // (`${VAR}` without a default) — so the referenced name is demanded by
  // name and the either/or choice doesn't apply.  A `${VAR:-x}` reference
  // carries a default and lands in the Optional section like any other
  // defaulted var, so it doesn't pin the choice.
  const explicitKey = envVars.find(
    (v) => v.name === 'ANTHROPIC_API_KEY' && v.defaultValue === undefined,
  );
  const explicitToken = envVars.find(
    (v) => v.name === 'ANTHROPIC_AUTH_TOKEN' && v.defaultValue === undefined,
  );

  if (explicitKey !== undefined || explicitToken !== undefined) {
    if (explicitKey !== undefined) {
      lines.push(
        '# Anthropic API key — required by name: the recipe references',
      );
      lines.push(
        '# ${ANTHROPIC_API_KEY} directly (and connectome-host/membrane also',
      );
      lines.push('# read it from process.env). Get one from console.anthropic.com.');
      lines.push(describeUsage(explicitKey));
      lines.push(`ANTHROPIC_API_KEY=${placeholderFor('ANTHROPIC_API_KEY')}`);
      lines.push('');
    }
    if (explicitToken !== undefined) {
      lines.push(
        '# Anthropic auth token (long-lived OAuth bearer, sent as',
      );
      lines.push(
        '# `Authorization: Bearer` instead of `x-api-key`) — required by name:',
      );
      lines.push('# the recipe references ${ANTHROPIC_AUTH_TOKEN} directly.');
      lines.push(describeUsage(explicitToken));
      lines.push(`ANTHROPIC_AUTH_TOKEN=${placeholderFor('ANTHROPIC_AUTH_TOKEN')}`);
      lines.push('');
    }
  } else if (requiresAnthropicCredential(input.walks)) {
    // No explicit reference — either var satisfies the requirement; the API
    // key is the common case so it's the uncommented one.
    lines.push(
      '# Anthropic credential — set ONE of the two variables below. Read directly',
    );
    lines.push(
      '# from process.env by connectome-host/membrane (not substituted into the',
    );
    lines.push(
      '# recipe), so one is required regardless of whether any recipe mentions it.',
    );
    lines.push('# If both are set, connectome-host prefers the auth token.');
    lines.push('# Option 1: API key from console.anthropic.com.');
    lines.push(`ANTHROPIC_API_KEY=${placeholderFor('ANTHROPIC_API_KEY')}`);
    lines.push(
      '# Option 2: long-lived OAuth bearer token (sent as `Authorization: Bearer`',
    );
    lines.push('# instead of `x-api-key`). Uncomment to use.');
    lines.push(`# ANTHROPIC_AUTH_TOKEN=${placeholderFor('ANTHROPIC_AUTH_TOKEN')}`);
    lines.push('');
  }

  // Recipe-referenced vars that aren't the Anthropic credential (already
  // emitted above), aren't optional-flavored by name heuristic, AND don't
  // carry a recipe-declared default (`${VAR:-x}` form).  Defaulted vars go
  // to Optional.
  for (const envVar of envVars) {
    if (envVar.name === 'ANTHROPIC_API_KEY') continue;
    if (envVar.name === 'ANTHROPIC_AUTH_TOKEN') continue;
    if (isOptionalName(envVar.name)) continue;
    if (envVar.defaultValue !== undefined) continue;
    lines.push(describeUsage(envVar));
    lines.push(`${envVar.name}=${placeholderFor(envVar.name)}`);
    lines.push('');
  }

  if (lines.length === 2) {
    lines.push('# No required variables in this section. Check build-time secrets and notes below.');
    lines.push('');
  }

  return lines;
}

/** Optional section: vars matching the heuristic OR carrying a recipe-
 *  declared default (`${VAR:-x}`).  Commented out — operator uncomments
 *  to override.  Defaulted vars get the recipe's default in the comment. */
function buildOptionalSection(envVars: EnvVar[]): string[] {
  const lines: string[] = [];
  const optionals = envVars.filter(
    (v) => isOptionalName(v.name) || v.defaultValue !== undefined,
  );
  if (optionals.length === 0) return lines;

  lines.push('# --- Optional ---');
  lines.push('');
  for (const envVar of optionals) {
    lines.push(describeUsage(envVar));
    if (envVar.defaultValue !== undefined) {
      lines.push(`# Recipe default if unset: ${JSON.stringify(envVar.defaultValue)}`);
      lines.push(`# ${envVar.name}=${envVar.defaultValue}`);
    } else {
      lines.push(`# ${envVar.name}=${placeholderFor(envVar.name)}`);
    }
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

  if (input.walks.some((walk) => walk.recipe.agent.provider === 'openai-codex')) {
    lines.push('# - Codex inference requires a codex executable on PATH, writable persistent CODEX_HOME,');
    lines.push('#   and codex login in the runtime environment. This bundle does not supply these prerequisites.');
    lines.push('#   Setting env values alone does not enable Codex inference.');
  }

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

  // Exclude `runtimeVars` declared on containerTemplateFiles — those are
  // filled at container start by the conhost entrypoint (from a bootstrap
  // sidecar's output, etc.) and don't belong in the operator's .env.
  const parent = input.walks[0];
  const runtimeOnly = new Set<string>(
    (parent?.recipe.containerTemplateFiles ?? [])
      .flatMap((tf) => tf.runtimeVars ?? []),
  );
  const operatorEnvVars = input.envVars.filter((v) => !runtimeOnly.has(v.name));

  // Sections, in order.
  lines.push(...buildRequiredSection(operatorEnvVars, input));
  lines.push(...buildBuildTimeSecretsSection(input.sources));
  lines.push(...buildOptionalSection(operatorEnvVars));
  lines.push(...buildNotesSection(input));

  // Collapse any trailing blank lines into a single trailing newline.
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines.join('\n') + '\n';
}
