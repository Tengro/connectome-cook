# Triumvirate — Dockerized (generic Zulip+GitLab example)

A reproducible Docker setup for a **Knowledge Mining Triumvirate** — conductor + miner + reviewer + clerk, all in one container, runnable on any machine with Docker.

This example exists for two purposes:

1. **A working Triumvirate you can deploy.** If your team uses Zulip and GitLab and you want a quick start, this drops in.
2. **A test target for `ch-builder` (in development).** It's the hand-curated reference that the auto-generator should produce equivalent output to. It exercises recursive recipe reading: one parent recipe (`triumvirate.json`) auto-spawns three child agents (`knowledge-miner.json`, `knowledge-reviewer.json`, `clerk.json`), each with their own MCP servers and persistent state.

## What's in the image

- `connectome-host` source from this branch + bun dependencies
- Bun 1.x runtime (for connectome-host and the connectome packages)
- Node 20 (for running the Zulip MCP adapter; `npx` for `@zereight/mcp-gitlab`)
- `tini` as PID 1 (signal forwarding + zombie reaping)
- The Zulip MCP server (`antra-tess/zulip_mcp` PR #3 / `mcpl-addendum` branch), built and ready at `/zulip_mcp/build/index.js`
- The four generic Triumvirate recipes (Zulip+GitLab miner, no-MCP reviewer, Zulip clerk staffing channel `knowledge-ai-assistant`, conductor)

What's **not** in the image:
- Your `.env` and `.zuliprc` (mounted from the host at runtime)
- Notion MCP server

## Prerequisites

- **Docker Engine 23+** with Compose v2 (`docker compose ...`, not `docker-compose ...`). BuildKit must be enabled (default in 23+).
- **An Anthropic API key** ([console.anthropic.com](https://console.anthropic.com/)). Note: four agents run concurrently, so spend will be proportionally higher than a single-agent run.
- **A Zulip account with admin access**, plus a dedicated bot. See [Step 3 of TRIUMVIRATE-SETUP.md](../../recipes/TRIUMVIRATE-SETUP.md#step-3-create-a-zulip-bot-and-get-credentials) for how to create one and get a `.zuliprc` file. The clerk auto-subscribes to a channel called `knowledge-ai-assistant` — create that channel in Zulip and subscribe your bot to it.
- **A GitLab Personal Access Token** with `read_api` and `read_repository` scopes (add `api` for write access). If you don't use GitLab, remove the `gitlab` block from `recipes/knowledge-miner.json` in this folder before building.

## Quick start

From this directory (`ch-builder-examples/triumvirate/`):

```bash
# 1. Create your env file from the template and fill it in
cp .env.example .env
$EDITOR .env                        # ANTHROPIC_API_KEY + GITLAB_TOKEN + GITLAB_API_URL

# 2. Place your Zulip bot's credentials here
cp ~/Downloads/zuliprc .zuliprc
chmod 600 .zuliprc

# 3. Build and start
docker compose up -d --build

# 4. Attach to the conductor TUI
docker attach triumvirate
```

The first build takes ~3–5 minutes (clones zulip_mcp, installs bun deps, builds the runtime image). Subsequent builds use the layer cache and are much faster.

When the TUI comes up, give the children 30–60 seconds to spawn and reach `ready`. Press **Tab** to cycle to the process fleet view; you should see miner / reviewer / clerk all green. Ask the conductor `are all three ready?` to confirm.

## Detaching and re-attaching

The most important Docker-specific gotcha:

> **Use `Ctrl+P Ctrl+Q` to detach, NOT `/quit + d`.**

When the conductor TUI is PID 1 in the container (which it is here), `/quit` exits the conductor → PID 1 dies → the container shuts down → all three children die with it. The "detach + leave running" semantics from the non-Docker setup don't apply.

Use Docker's built-in detach sequence instead: press **Ctrl+P then Ctrl+Q** while attached. The TUI disconnects but the conductor (and therefore the children) keep running.

To re-attach later:
```bash
docker attach triumvirate
```

OpenTUI redraws on resize; press a key or resize your terminal slightly if the screen looks blank on re-attach.

To stop everything cleanly:
```bash
docker compose down
# or, equivalently, while attached:  /quit  →  Y  (kill children)
```

`docker compose down` sends SIGTERM to the conductor; the conductor's graceful-shutdown logic propagates to the children (which themselves shut down their MCP servers). The compose file's `stop_grace_period: 30s` gives this time to complete before SIGKILL.

## Where your data goes

All persistent state is bind-mounted into this directory so you can inspect library artifacts with normal host-side tools:

| Host path (relative to this dir) | Container path | What's there |
|---|---|---|
| `./data/` | `/app/data/` | Chronicle stores + sockets + PIDs for each agent |
| `./output/` | `/app/output/` | Library-mined documents (miner writes; reviewer & clerk read) |
| `./review-output/` | `/app/review-output/` | Library-reviewed documents (reviewer writes; clerk reads) |
| `./knowledge-requests/` | `/app/knowledge-requests/` | Tickets the clerk files when the library can't answer |
| `./input/` | `/app/input/` | Read-only mount for any external inputs you want to feed in |
| `./.env` | (env vars only — file isn't mounted) | API keys + source credentials |
| `./.zuliprc` | `/app/.zuliprc` (read-only) | Zulip bot credentials |

These directories are gitignored (see `.gitignore` in this folder). Bind-mount permissions: the container runs as UID 1000 (the `bun` user). On Linux/WSL2 default user accounts (also UID 1000), this Just Works. On macOS, Docker Desktop handles UID translation. If you hit permission errors, `chown -R 1000:1000 data output review-output knowledge-requests input` on the host, or override with `user: "${UID}:${GID}"` in `docker-compose.override.yml`.

## Customizing the recipes

The four generic recipes in `recipes/` of this folder are baked into the image at build time. To change them:

1. Edit the recipe files in `recipes/` (in *this* folder, not in `connectome-host/recipes/`).
2. `docker compose up -d --build` — this rebuilds the image and recreates the container with the new recipes baked in.

Common edits:

- **Channel name** — the clerk staffs `knowledge-ai-assistant`. To change: edit `recipes/clerk.json` and replace all three references (the `ZULIP_SUBSCRIBE` env, the wake policy's `channel`, and the system prompt).
- **Drop GitLab** — if you don't have a GitLab token, edit `recipes/knowledge-miner.json` and remove the `gitlab` entry from `mcpServers` (also remove `GITLAB_TOKEN`/`GITLAB_API_URL` from `.env`).
- **Add another source** — for an npx-installable MCP server, just add an entry to `mcpServers` in the relevant recipe; no Dockerfile change needed. For a server that needs to be cloned and built, add a build stage to the Dockerfile.

Recipes are baked, not bind-mounted, deliberately: the image stays self-contained and reproducible. If you want live recipe iteration, switch the Dockerfile's `COPY ch-builder-examples/triumvirate/recipes ./recipes` to a compose-level bind mount of `./recipes:/app/recipes:ro` and skip the COPY.

## Updating to a newer connectome-host build

```bash
git pull                                         # in the connectome-host repo root
docker compose build --no-cache                  # rebuild from scratch
docker compose up -d --force-recreate
```

`--no-cache` is important after pulling because Docker won't notice TS source edits underneath cached layers; `--force-recreate` ensures the new image is actually used (compose otherwise sees the same image tag and skips recreation).

If you only changed `.env`, no rebuild is needed — just `docker compose up -d --force-recreate`.

## Troubleshooting

| Problem | What to check |
|---|---|
| `docker attach` shows blank screen | Press a key or resize your terminal — OpenTUI redraws on resize. If still blank, verify `tty: true` and `stdin_open: true` in `docker-compose.yml`. |
| Miner crashes with "Recipe references environment variable ${X}" | Either set `X` in `.env` or remove the corresponding `mcpServers` entry from `recipes/knowledge-miner.json`. |
| `bun install` fails during build | Usually a transient npm registry issue — `docker compose build --no-cache` and try again. |
| Children stay in `starting` forever | `docker compose logs triumvirate` to see what the conductor reports; the per-child runtime logs live inside the container at `/app/data/<name>/headless.log` and `startup.log`. Get them out with `docker cp triumvirate:/app/data/miner/startup.log .`. |
| "API error 401" from Zulip on child startup | `.zuliprc` is wrong, expired, or wasn't bind-mounted correctly. Check `ls -la .zuliprc` on the host (must exist, mode 600), then verify the file made it into the container: `docker exec triumvirate cat /app/.zuliprc`. |
| Permission errors on bind-mounted dirs | Container runs as UID 1000. `chown -R 1000:1000 data output review-output knowledge-requests input` on the host. |
| Container exits immediately on `docker compose up` | Almost always missing `ANTHROPIC_API_KEY` — check `.env` is in this folder and `docker compose config` shows it being loaded. |
| Need a shell in the container | `docker exec -it triumvirate bash`. The conductor TUI keeps running on its TTY; you get a separate shell. |
| Want to inspect live state of a child without the TUI | `docker exec -it triumvirate cat /app/data/<name>/headless.log` or `tail -f` the same. |

For non-Docker-specific issues (a child agent behaving oddly, Zulip channel subscription not working, etc.) the troubleshooting in [TRIUMVIRATE-SETUP.md](../../recipes/TRIUMVIRATE-SETUP.md#troubleshooting) applies equally inside the container.

## What this image is *not*

- **Not a multi-host setup.** The four agents share one container, one filesystem, one process tree. If you want to scale out, the FleetModule's design supports it (each child is its own process with its own data dir) but you'd need to wire IPC across hosts — not done here.
- **Not a production-hardened image.** No non-root supervisor process beyond `tini`, no resource limits, no log rotation past what bun/conductor handle internally. Add those for production deploys.

## Layout reference

```
ch-builder-examples/triumvirate/
├── Dockerfile                          # multi-stage: zulip_mcp → bun deps → runtime
├── Dockerfile.dockerignore             # BuildKit-style, scoped to this Dockerfile
├── docker-compose.yml                  # bind mounts + TTY + env_file
├── .env.example                        # template; copy to .env
├── .gitignore                          # operator-local files (.env, .zuliprc, data/, ...)
├── README.md                           # this file
└── recipes/                            # self-contained generic recipes; baked into image
    ├── triumvirate.json                # conductor; auto-spawns the three children below
    ├── knowledge-miner.json            # miner (Zulip + GitLab)
    ├── knowledge-reviewer.json         # reviewer (no MCP servers; pure LLM critic)
    └── clerk.json                      # clerk on Zulip channel knowledge-ai-assistant
```
