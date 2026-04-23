# connectome-cook — design notes from the hand-curated Triumvirate Dockerfiles

These notes were extracted while building hand-curated Triumvirate Docker images (the in-repo `examples/triumvirate/` set, plus a richer multi-source variant kept out of this repo). The hand-curated images are the test target `connectome-cook` should produce equivalent output for; this doc captures the lessons + patterns so the auto-builder doesn't relearn them the hard way.

## Hard-won lessons

### 1. Confabulated dependencies are the worst kind of bug
A miner recipe once referenced `uvx ftp-mcp-server` — a Python MCP server. It looked plausible (it had explicit `enabledTools` lists, was documented in the operator install guide), but the package never existed on PyPI. We caught it only after a smoke test failure traced back to "uv: No solution found in package registry." A `|| true` on the build-time pre-cache had silently masked the failure for hours.

**For connectome-cook:** every generated source needs an *active verification* step at build time — not just "did the install command exit zero," but "does the binary actually exist and respond to a probe." Don't `|| true` verifications.

### 2. Auto-clone is non-deterministic without pinning
Two builds with the same Dockerfile two hours apart got different commits of `zulip_mcp`'s PR head and behaved differently. The PR head moves; "track HEAD of branch X" is not reproducible.

**For connectome-cook:** default generated Dockerfiles to **pinned SHAs**, document tracking-HEAD as an opt-in override. Cost of "always latest" is "smoke test green at 9am, red at 11am with no Dockerfile change in between."

### 3. Framework version drift is hidden coupling
A `chore: bump @animalabs/agent-framework to ^0.3.0` commit landed on `main` while we were iterating. Before: framework was tolerant of MCP-server-exits-before-handshake (logged warning, continued). After: framework treats it as fatal for the agent. This invalidated the smoke-test assumption silently.

**For connectome-cook:** pin both `@animalabs/agent-framework` *and* the connectome-host source SHA in the generated image. The operator running `docker compose up` shouldn't get different runtime behavior depending on when they last `git pull`'d.

### 4. Recipe-relative paths constrain in-container layout
A conductor recipe that references children as `./knowledge-miner.json` resolves correctly only if recipes live where the conductor lives — not in a subdir like `recipes/`. Recipes that use `recipes/knowledge-miner.json` instead need a different layout. Mixing the two breaks one or the other.

**For connectome-cook:** treat the parent recipe's location in the container as the anchor; child recipe references in the parent dictate where the children must live. Don't impose a `recipes/` subdir convention if the parent uses sibling references.

### 5. venv portability lies
COPY-ing a host-built `.venv/` into the container looks like it'll work and breaks at runtime over absolute-path shebangs and `pyvenv.cfg.home` mismatches. Same lesson Docker hit a decade ago with `node_modules`.

**For connectome-cook:** always rebuild Python venvs *inside* the image at build time. Never trust a COPY of `.venv/`. Same for `node_modules`.

### 6. Symlink semantics in Docker COPY are surprising
`COPY /usr/local/bin/npx /usr/local/bin/npx` from a stage where `npx` is a symlink: Docker follows the symlink and materializes the resolved file at the destination. The resolved file (`npm-cli.js`) does `require('../lib/cli.js')` relative to its own location — now broken because the relative path doesn't resolve in the new location.

**For connectome-cook:** when a multi-file install relies on relative paths between binaries and libraries, copy the install dir wholesale + recreate symlinks explicitly. Or `apt install` fresh.

### 7. Pipelining shell tools masks signals
`docker compose build 2>&1 | tee log` exits 0 even when the build failed. The `tee` pipeline succeeds; the upstream `docker compose build` exit gets lost.

**For connectome-cook:** in any verification scripts the generator emits, prefer `>` and read the file with `cat`. Or use bash's `pipefail`.

### 8. Self-signed CAs need explicit handling
An internal git host using a self-signed cert isn't in the container's CA bundle. First auto-clone build failed with "server verification failed: certificate signer not trusted." Pragmatic fix: `git -c http.sslVerify=false clone ...`. Strict fix: mount the org's CA bundle into the image.

**For connectome-cook:** make this explicit per-source in the recipe schema (`source.sslBypass: boolean`), don't assume one or the other.

### 9. Build-time vs runtime auth secrets
GITLAB_TOKEN serves dual purpose: build-time (clone internal repos) and runtime (run the gitlab MCP server). Build args leak into `docker history`; BuildKit secrets (`--mount=type=secret`) don't.

**For connectome-cook:** generate the BuildKit secret form by default. Document the build-arg fallback as an option for environments that don't have BuildKit.

### 10. Framework strictness changes operator UX
With `agent-framework@0.3.0`, a single MCP server failure kills the agent. With 5 MCP servers all needing real creds, that means a single misconfig can take down the agent. Smoke tests with stub creds become much more brittle.

**For connectome-cook:** consider generating a `--validate` mode where the image just spawns each MCP server in isolation and reports which ones fail and why, separately from the all-or-nothing `docker compose up`. Helps operators triage before committing to a full run.

### 11. Fleet-child path resolution: parent-dir-relative on both sides
Cook's walker resolves `fleet.children[].recipe` against the **parent recipe's directory** — the only sensible semantic for a build-time tool that's handed a recipe path with no useful CWD. Upstream connectome-host adopted the same semantic in `fix(recipe): resolve fleet children[].recipe against parent recipe dir` (commit `a7a2497`), exposing `resolveRecipeRelative` from `src/recipe.ts` and applying it inside `loadRecipe`. The conhost in-tree recipes were updated to use bare filenames (`knowledge-miner.json`, not `recipes/knowledge-miner.json`) at the same time.

**For connectome-cook:** ship recipes that use bare filenames or `./<child>.json` for fleet children — both work identically under parent-dir resolution. Generated Dockerfile CMDs can stay `bun src/index.ts <parent-recipe>` from any CWD; child resolution no longer depends on it. The cook example at `examples/triumvirate/recipes/triumvirate.json` uses the `./<child>.json` form for clarity.

## Reusable patterns

### Multi-stage Dockerfile shape

```
[builder stages, one per MCP server with non-trivial build]
  - clone (with optional secret mount for private repos)
  - language-specific build (npm install + npm run build, pip install + venv, custom script)
  - artifact at /<server-name>/

[connectome-host bun deps stage]
  - COPY package.json + bun.lock from sibling clone (or auto-clone)
  - bun install --frozen-lockfile

[runtime stage]
  - apt: tini, ca-certificates, plus per-MCP-server runtimes (python3, etc.)
  - COPY built MCP servers from their builder stages → /<server-name>/
  - COPY connectome-host source → /app/
  - COPY recipes (generated overlay handles path overrides) → /app/
  - chown -R bun:bun /app /<each MCP server dir>
  - USER bun
  - ENV DATA_DIR=/app/data + per-recipe ${VAR} defaults
  - ENTRYPOINT ["tini", "--"]
  - CMD ["bun", "src/index.ts", "<parent-recipe>"]
```

### Recipe schema extension

The piece that drives auto-build:

```ts
RecipeMcpServer.source?: {
  url: string;                              // git URL
  ref?: string;                             // default: "main", recommend pinning to SHA
  install?: 'npm' | 'pip-editable' | { run: string };   // build steps inside the cloned dir
  runtime?: 'node' | 'python3' | 'custom';  // determines apt deps
  authSecret?: string;                      // build-arg name (e.g. "GITLAB_TOKEN")
  sslBypass?: boolean;                      // for self-signed CAs
  inContainer?: { path: string };           // override the in-container path
                                            // (defaults to /<repo-basename>/)
};
```

connectome-cook reads recipes recursively, dedupes sources by `url+ref`, generates one builder stage per unique source, and emits the runtime COPY + apt install for each.

### Compose file shape (mostly recipe-agnostic)

```yaml
services:
  <name>:
    build:
      context: ../..              # depends on layout
      dockerfile: <relative path>
      secrets:                    # only if any source.authSecret is set
        - <secret-name>
      args:                       # commented overrides for each REPO_URL/REPO_REF
        ...
    image: <name>:latest
    container_name: <name>
    stdin_open: true              # always — TUI conductor needs TTY
    tty: true
    env_file:
      - .env
    volumes:
      - ./.zuliprc:/app/.zuliprc:ro       # if any recipe references zulip MCP
      - ./data:/app/data                  # always
      - ./output:/app/output              # if any recipe writes to library-mined
      - ./review-output:/app/review-output
      - ./knowledge-requests:/app/knowledge-requests
      - ./input:/app/input                # always
    stop_grace_period: 30s

secrets:                          # if needed
  <secret-name>:
    environment: <env-var-name>
```

### README sections (recipe-agnostic; copy verbatim)

- "Detaching and re-attaching" (Ctrl+P Ctrl+Q vs `/quit + d` gotcha)
- "Inputs and configs" with the three buckets:
  - Required before first `up` (.env, .zuliprc)
  - Optional seed before first `up` (input/, lineage-data/, etc.)
  - Auto-created and persisted (data/, output/, review-output/, knowledge-requests/)
- "Adding a new config or input file" (generic bind-mount pattern)
- "Permissions" (UID 1000, chown advice)
- "Updating" (sibling vs auto-cloned distinction)
- "What this image is *not*" (multi-host, production-hardened, etc.)

### Recipe overlay pattern

When the in-container paths can't be expressed in the recipe schema (because the recipe is also used for local-test runs with different paths), generate an overlay recipe alongside the original:

- Org root recipe: `command: "python3"`, `args: ["../mcp-server-ftp/build/index.js"]` — relative paths for sibling layout
- Docker overlay recipe: `command: "/lineage/.venv/bin/python3"`, `args: ["/mcp-server-ftp/build/index.js"]` — absolute container paths

The overlay diverges from the root only in the necessary path overrides. connectome-cook generates this as a deterministic JSON edit and COPYs the overlay over the root in the runtime stage.

If the recipe declares `source.inContainer.path`, connectome-cook can derive the overlay automatically. For overrides that aren't formulaic (e.g., the lineage venv path), the recipe needs an explicit `commandOverride.docker` field or similar.

## What connectome-cook can't fully automate

- Custom install scripts (e.g., notion-mcp's `setup_mcp.sh` which generates a venv + start script). Needs an `install: { run: 'bash X.sh' }` escape hatch.
- Per-server runtime env vars (which `${VAR}` go where). Stays operator-supplied via `.env`.
- SSL-bypass / CA-cert mounts (operator-specific).
- Custom command paths in the overlay (when an overlay needs to swap `python3` → `/specific/venv/bin/python3` because of how the operator structured the venv install). Needs explicit override declaration in the recipe.
- Debugging mismatched / aspirational recipes (e.g., FTP block referencing a nonexistent package). Best effort: at build time, verify each generated MCP server actually starts before considering the image valid (lesson 1).

## Concrete artifacts connectome-cook can crib

Look at these for the exact patterns to emit:

- `examples/triumvirate/Dockerfile` — generic shape (Zulip + GitLab, no auth-needed clones)
- `examples/triumvirate/docker-compose.yml` — bind mounts + TTY config
- `examples/triumvirate/README.md` — operator-facing documentation that's largely formulaic
- The full-shape variants (5+ MCP servers, BuildKit secrets, SSL bypass, mixed runtimes) referenced through the lessons above were hand-curated in private repos; structurally they're the same recipe-shape extended along the dimensions cook already supports

## Connectome-host sibling vs auto-clone

A sibling-COPY of connectome-host can save time during local iteration: the operator already has a checkout, and re-cloning on every full Docker build adds latency and a network dependency.

For a release-only Docker (no local connectome-host iteration expected), zero-siblings is feasible: clone connectome-host from a configurable URL + ref. Trade-off is rebuild speed vs single-command setup. For connectome-cook default, **lean toward zero-siblings** — the assumption being "Docker is for release, local dev is outside Docker." Allow opt-in to sibling-COPY via a `--sibling connectome-host` flag.
