# connectome-cook — build plan

Phased plan for implementing the CLI. Each phase produces something testable. Subagent parallelization opportunities called out per phase.

Companion to [`DESIGN-NOTES.md`](./DESIGN-NOTES.md), which captures the patterns the CLI must reproduce. This document is the *how*; design notes are the *what*.

## Goal

`recipes in → Docker images out`. Concretely:

```bash
cook build path/to/triumvirate.json --out ./out
# emits: out/Dockerfile, out/docker-compose.yml, out/.env.example,
#        out/README.md, out/recipes/<overlay>.json (only when needed)

cook run path/to/triumvirate.json
# builds + `docker compose up` from a temp dir

cook check path/to/triumvirate.json
# validates: every MCP source resolvable, every ${VAR} discoverable,
# no contradictions between source.inContainer and recipe.command/args
```

## CLI surface

```
cook build <recipe-path-or-url> [flags]
  --out <dir>             output directory (default: ./<recipe-name>-cook)
  --no-prompts            non-interactive; expect all vars in process env or --env-file
  --env-file <path>       read variable values from this file
  --strict                fail if any MCP server lacks a source block (no sibling-COPY fallback)
  --image-name <name>     name for the built image (default: derived from recipe name)
  --pin-refs              for any source.ref that's a branch, resolve to the current SHA
                          and write that to the generated Dockerfile (production reproducibility)

cook run <recipe-path-or-url> [build-flags...] [-- compose-args...]
  Same flags as build; emits to a tmp dir then runs `docker compose up`
  in foreground.  Pass-through args after `--` go to compose.

cook check <recipe-path-or-url> [flags]
  --strict                same semantics as build
  --json                  machine-readable report

cook init <name> [--template <name>]
  Scaffold a starter recipe with sensible defaults.  Templates: minimal,
  triumvirate, single-zulip-agent, ...
```

Exit codes:
- 0 — success
- 1 — operator error (missing file, bad flag, etc.)
- 2 — recipe error (validation failure, missing source, contradiction)
- 3 — build/run failure (docker exit code passed through where applicable)

## Module breakdown

### `src/cli.ts`
Entrypoint. Parses argv (using `mri` or `meow` — small, no big deps), dispatches to subcommand handler. ~100 LoC.

### `src/walker.ts`
Walks a recipe tree. Given a parent recipe path/URL, returns a flat array of `{ path, recipe }` for the parent + every child reachable via `modules.fleet.children[].recipe`. Uses connectome-host's `loadRecipe` so paths resolve correctly (the `fix(recipe): resolve fleet children[].recipe against parent recipe dir` work upstream). Pure async function.

Output: `Array<{ path: string; recipe: Recipe }>`. ~50 LoC.

### `src/source-detector.ts`
Pure function. Input: walker output. Output: `Array<McpSource>` where:
- `McpSource = { key: string; refs: SourceRef[]; install: ...; auth: ...; ssl: ...; inContainer: ... }`
- `key` derived from `url+ref` (normalized) — used for deduplication
- `refs` = which `(recipePath, mcpServerName)` references this source (for error reporting)

For MCP servers without `.source`: in non-strict mode, emit a `SiblingCopySource` shim; in strict mode, throw with a list of unresolved entries. ~80 LoC.

### `src/env-collector.ts`
Pure function. Regex-scans the JSON-stringified recipe(s) for `${VAR}` patterns, returns `Array<{ name: string; usedIn: Array<{ recipe; jsonPath }> }>`. Note: this is a separate pass from `loadRecipe` (which throws on missing vars) — collector runs *before* substitution so we can prompt for missing values. ~30 LoC.

### `src/prompts.ts`
Interactive UI. Uses `prompts` (the npm package — tiny, ESM-friendly). Functions:
- `promptForEnvVars(missing: EnvVar[]): Promise<Record<string, string>>`
- `promptForSecrets(secrets: Array<{ name; consumer }>): Promise<Record<string, string>>`
- `confirmWrite(outDir, fileCount): Promise<boolean>`

In `--no-prompts` mode, reads from `process.env` or `--env-file`; throws on missing required values. ~80 LoC.

### `src/generators/dockerfile.ts`
Templates a multi-stage Dockerfile from `(walker output, sources, options)`. One builder stage per unique `McpSource`; one `ch-deps` stage that clones connectome-host (URL is a build arg, default `https://github.com/anima-research/connectome-host.git`); one runtime stage that COPYs all the built artifacts and chowns. Uses string templating (template literals — no need for a template engine). ~250 LoC.

### `src/generators/compose.ts`
Templates `docker-compose.yml`. Inputs: recipe (for image name + bind mount derivation), sources (to determine if `secrets:` block is needed), env vars (to populate the comments). Bind mounts derived from each agent's workspace mounts in the recipes (output, review-output, knowledge-requests, input, etc.). ~150 LoC.

### `src/generators/overlay.ts`
Generates recipe overlay JSON files when a source's `inContainer.path` differs from the recipe's `args` path semantics, or when `install: pip-editable` requires the command to be repointed at the venv binary. Pure derivation: input = original recipe + source metadata; output = overlay JSON with only the changed fields. ~80 LoC.

### `src/generators/env.ts`
Templates `.env.example`. Inputs: env-collector output + sources' `authSecret` fields. Groups by category (required, optional). ~40 LoC.

### `src/generators/readme.ts`
Templates the operator README. Mostly static content (detach/reattach gotcha, persistence taxonomy, troubleshooting) interpolated with the recipe's name + the list of MCP sources baked in. ~150 LoC of templates + ~30 LoC of logic.

### `src/runtimes/npm.ts`, `src/runtimes/pip.ts`, `src/runtimes/custom.ts`
Each exports `installSteps(source: McpSource): string` returning the Dockerfile RUN block(s) for that install pattern. Called by `dockerfile.ts`. Tiny — ~30 LoC each.

### `src/runtimes/index.ts`
Dispatch: `getRuntime(install)` returns the right module. ~10 LoC.

### `src/types.ts`
Shared types (`McpSource`, `WalkResult`, `EnvVar`, `BuildOptions`, etc.). Imported by all modules. ~80 LoC.

### `src/log.ts`
Tiny progress logger (no big deps; just colored stdout via `picocolors`). Used by all CLI handlers. ~30 LoC.

## Dependency graph

```
                cli.ts
                  │
       ┌──────────┼──────────┐
       │          │          │
   walker      env-coll    prompts
       │          │          │
       └────┬─────┘          │
            │                │
       source-det            │
            │                │
            ├──────────┬─────┴─────┬─────────┬─────────┐
            │          │           │         │         │
        gen/dock   gen/compose  gen/overlay gen/env  gen/readme
            │
       runtimes/{npm,pip,custom}
```

Modules with dashed-line dependencies (just types from `types.ts`) are otherwise independent and can be developed in parallel.

## Phasing + subagent parallelization

### Phase 0 — scaffold (sequential, ~1 hour)
1. `package.json` (deps: `@animalabs/agent-framework` for `loadRecipe`, `prompts`, `mri`, `picocolors`; devdeps: typescript, @types/node)
2. `tsconfig.json` (NodeNext, strict, target ES2022)
3. `bin/cook` shim
4. `src/cli.ts` skeleton — `cook --help`, `cook --version`, dispatch table for `build`/`run`/`check`/`init` (all subcommands return "not yet implemented" placeholders)
5. `src/types.ts` initial set
6. `src/log.ts`
7. Verify: `bun bin/cook --help` shows usage; `cook build foo` says "not yet"

**Subagents: none.** Scaffold is small, sequential, and sets up shared types — fine to do solo.

### Phase 1 — minimal pipeline (4 parallel subagents possible, ~half day)
Three pure-function modules + one integration step:

- **Subagent A**: `src/walker.ts` + tests (load parent + traverse children + dedupe). Self-contained.
- **Subagent B**: `src/source-detector.ts` + tests (collect McpSource list, dedupe by url+ref, handle missing-source fallback). Self-contained, only depends on `types.ts`.
- **Subagent C**: `src/env-collector.ts` + tests (regex scan, dedupe). Self-contained.
- **Foreground (me)**: `src/runtimes/{npm,pip,custom,index}.ts` (small, conceptually unified) + `src/types.ts` updates as parallel work surfaces missing types.

After all four return: integrate in `cli.ts` so `cook check <recipe>` runs walker → source-det → env-coll and prints a report. **Test-target**: feeding it `examples/triumvirate/recipes/triumvirate.json` should list the 5 MCP sources + ~6 env vars.

### Phase 2 — generators (5 parallel subagents, ~1 day)
Each generator emits one artifact type. They share input shape (walker output + sources + options) and have no inter-dependencies.

- **Subagent A**: `src/generators/dockerfile.ts` + diff-test against `examples/triumvirate/Dockerfile` (functional equivalence — both must produce a working image; bit-for-bit not required).
- **Subagent B**: `src/generators/compose.ts` + diff-test against `examples/triumvirate/docker-compose.yml`.
- **Subagent C**: `src/generators/overlay.ts` + tests using a synthetic recipe + source pair.
- **Subagent D**: `src/generators/env.ts` + diff-test.
- **Subagent E**: `src/generators/readme.ts` + visual review (no diff test — content is largely templates).

After all five return: integrate in `cli.ts`'s `build` handler. **Test target**: `cook build examples/triumvirate/recipes/triumvirate.json --out /tmp/cook-test --no-prompts` produces files; `docker compose -f /tmp/cook-test/docker-compose.yml build` succeeds.

### Phase 3 — interactivity + run subcommand (mostly sequential, ~half day)
1. `src/prompts.ts` (foreground; requires choosing the prompts library, designing the UX flow — judgment calls best made by primary author, not a subagent)
2. Wire prompts into `build` handler
3. Implement `cook run` as `build` + `cd <out> && docker compose up` (subagent-friendly small task)
4. Refine error messages across the pipeline (foreground polish)

### Phase 4 — polish + packaging (mostly parallelizable, ~half day)
- **Subagent A**: `cook check` subcommand (just runs phases 1's pipeline + reports; no writes)
- **Subagent B**: `cook init` subcommand + a couple of starter templates
- **Subagent C**: README for the conhost-cook repo itself + man-page-style help text
- **Subagent D**: end-to-end test using `bun:test` — `cook build` against the example, smoke-test the resulting image
- **Foreground**: package.json bin field + LICENSE + npm publish dry-run + README updates ("Status: alpha" → "Status: usable")

## Test strategy

Three layers:

1. **Unit tests** (per module): `bun test src/walker.test.ts` etc. Pure functions are easy — give them a recipe object, assert on output. ~70% target coverage.

2. **Diff tests** (per generator): generate against `examples/triumvirate/recipes/triumvirate.json`, compare output to `examples/triumvirate/<artifact>` with **functional equivalence** rules (whitespace/comment-insensitive comparison; the example may have hand-tuned comments the generator won't reproduce verbatim, and that's fine). Helps catch regressions when refactoring generators.

3. **End-to-end test** (one big test): `cook build` against the example → `docker compose build` succeeds → `docker compose run` boots all 4 agents (or 3 children + conductor) to `ready`. Heavy but only one of these; runs in CI via `act` or just on the user's box.

The `examples/triumvirate/` IS the test target. **Action item:** the example's recipes need `source` blocks added so the generator has metadata to consume — currently they don't have them since they predate the schema PR. Track as a sub-task in Phase 1.

## Coordination notes (for subagent parallelization)

- Shared types in `src/types.ts` are the primary integration point. Lock these down at the start of each phase before fanning out subagents.
- Each subagent should write a small "what I changed" summary in their PR-equivalent — main thread integrates and reconciles.
- For diff-tests against `examples/triumvirate/`: subagents shouldn't modify the example files; if a generator can't produce something the example has, that's a real divergence to discuss, not a "fix the example" trigger.
- Conventions: ESM with NodeNext + `.js` import suffixes (matches connectome-host).
- Don't pull in heavy deps. The list (`@animalabs/agent-framework`, `prompts`, `mri`, `picocolors`) should stay short.

## Open questions to resolve as we go

1. **`prompts` library choice.** `prompts` (sindresorhus) vs `enquirer` vs `inquirer`. Default lean: `prompts` — smallest, ESM, minimal API, no maintenance worries.

2. **Connectome-host as a build-time dependency.** Currently we plan to depend on `@animalabs/agent-framework` for `loadRecipe`. Alternative: vendor a minimal recipe loader (~50 LoC). Pro of vendoring: smaller install + no version drift. Con: duplication. Lean: depend for now, extract if it becomes friction.

3. **Output dir layout.** ~~Should the generator emit `out/recipes/<overlay>.json` (matching the lynx docker_files layout) or `out/<recipe>.json` at root (matching the lynx in-container layout)?~~ **Resolved:** `out/recipes/<file>.json`. Upstream `a7a2497` shipped parent-dir-relative fleet child resolution, so children are bare filenames (e.g. `knowledge-miner.json`) referenced from a parent recipe living next to them. The natural in-container layout is `/app/recipes/<file>.json`, with conductor CWD `/app` and `CMD bun src/index.ts recipes/<parent>.json`. Cook's output dir mirrors this: `Dockerfile`, `docker-compose.yml`, `.env.example`, `README.md`, plus a `recipes/` subdir with overlay'd JSON files.

4. **Image tagging.** Always `latest`? Recipe-name-derived? SHA-derived for reproducibility? Lean: `<recipe-name>:latest` by default, `--image-name` override.

5. **Multi-arch.** Currently the example builds for the host arch. Should `cook` support `--platform linux/amd64,linux/arm64`? Defer — single-arch is fine for now.

6. **Push-to-registry.** Should `cook` know how to push the built image to a registry? Defer — operators can `docker push` themselves.

## What this plan deliberately omits

- Native `docker buildx bake` integration. Could be cleaner but adds cognitive overhead.
- Auto-generation of CI workflows (`.github/workflows/build.yml`). Useful but not core.
- Recipe linting beyond what the loader already does.
- Web UI for prompting. The CLI is the product.

## Estimated total effort

- Phase 0: 1 hour
- Phase 1: 4 hours (with 4 subagents in parallel — would be 1.5 days serially)
- Phase 2: 1 day (with 5 subagents — would be 3 days serially)
- Phase 3: half day
- Phase 4: half day (with 4 subagents — would be 1.5 days serially)

Total: ~3 days with parallelization, ~7 days serial.
