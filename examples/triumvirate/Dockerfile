# syntax=docker/dockerfile:1.7

# ---------------------------------------------------------------------------
# Triumvirate Docker image (generic Zulip+GitLab example)
# ---------------------------------------------------------------------------
# Demonstrates a recursive-recipe-reading deployment: one parent recipe
# (triumvirate.json) auto-spawns three child agents (miner, reviewer, clerk)
# that share the same image and persistent volumes.
#
# Layout inside the image:
#   /app           — connectome-host source + recipes + node_modules
#   /zulip_mcp     — built zulip_mcp adapter; recipes reference it as
#                    "../zulip_mcp/build/index.js" relative to /app
#
# Persistent state lives under /app/{data,output,review-output,
# knowledge-requests,input} and is intended to be bind-mounted from the
# host (see docker-compose.yml).
# ---------------------------------------------------------------------------

# ---- Stage 1: clone + build zulip_mcp from antra-tess PR #3 ---------------
FROM node:20-bookworm-slim AS zulip-mcp-build
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN git clone https://github.com/antra-tess/zulip_mcp.git \
 && cd zulip_mcp \
 && git fetch origin refs/pull/3/head:mcpl-addendum \
 && git checkout mcpl-addendum \
 && npm install --no-audit --no-fund \
 && npm run build

# ---- Stage 2: install connectome-host bun dependencies --------------------
FROM oven/bun:1-debian AS ch-deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# ---- Stage 3: runtime image -----------------------------------------------
FROM oven/bun:1-debian AS runtime

# tini: signal forwarding + zombie reaping when bun is PID 1.
# ca-certificates: HTTPS to Anthropic + Zulip + GitHub for npx.
# (Node binary is copied from the zulip-mcp-build stage to avoid pulling
# the NodeSource apt repo just for the runtime — same major version as
# what zulip_mcp was built against.)
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Bring in Node 20 for running zulip_mcp's built CommonJS bundle, plus
# npm/npx so the operator can later add npx-driven MCP servers (e.g.
# @zereight/mcp-gitlab) without rebuilding the base image.
#
# npm and npx are symlinks in the source image — Docker COPY follows
# symlinks and would materialize them as standalone scripts whose internal
# require('../lib/cli.js') resolves to the wrong path.  Copy the npm
# package and recreate the symlinks ourselves.
COPY --from=zulip-mcp-build /usr/local/bin/node          /usr/local/bin/node
COPY --from=zulip-mcp-build /usr/local/lib/node_modules  /usr/local/lib/node_modules
RUN ln -sf ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -sf ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# zulip_mcp at /zulip_mcp so the recipe path "../zulip_mcp/build/index.js"
# resolves correctly when bun runs in /app.
COPY --from=zulip-mcp-build /build/zulip_mcp /zulip_mcp

# connectome-host at /app
WORKDIR /app
COPY --from=ch-deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY src ./src

# Self-contained generic Triumvirate recipes (Zulip+GitLab; no syncntn;
# clerk staffs channel knowledge-ai-assistant).  We do NOT copy
# connectome-host's own recipes/ folder — that contains org-specific
# recipes that are slated to migrate to lynx-conhost-recipes.
COPY ch-builder-examples/triumvirate/recipes ./recipes

# Pre-create persistent dirs with bun-user ownership so bind mounts on a
# UID-1000 host (default Linux/WSL2 user) work without manual chown.
RUN mkdir -p data output review-output knowledge-requests input \
 && chown -R bun:bun /app /zulip_mcp

USER bun

ENV DATA_DIR=/app/data

ENTRYPOINT ["tini", "--"]
CMD ["bun", "src/index.ts", "recipes/triumvirate.json"]
