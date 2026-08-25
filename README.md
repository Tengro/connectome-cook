# connectome-cook

Recipes in, deployments out. A CLI that takes a [connectome-host](https://github.com/anima-research/connectome-host) recipe (single agent or multi-agent fleet) and materializes it — either as a runnable Docker artifact bundle (`cook build`) or as a direct install onto your machine (`cook install`), with all required MCP servers **and code extensions** baked in.

The pipeline is split in two: a backend-agnostic *resolution* step (walk the recipe tree, detect components, probe host requirements, collect env/credential values) produces an install plan; a backend materializes it. Every materialization writes a `connectome.lock` recording what was resolved, and `cook run` launches from the lock without re-resolving.

> **Status:** alpha. The core pipeline works — `cook init`, `cook check`, `cook build`, `cook install`, and `cook run` all do something useful, end-to-end against the in-repo Triumvirate example. Expect rough edges around `--json` reports and pip-editable arg overlays. Not yet on npm.

## Install

For now, clone + run via Bun:

```bash
git clone https://github.com/Tengro/connectome-cook.git
cd connectome-cook
bun install
./bin/cook --help
```

(npm publish + the standalone `cook` binary are tracked under Phase 4 polish; for now the bin shim runs Bun-on-source directly.)

## Usage

```bash
# Scaffold a starter recipe.
cook init "My Agent" --template minimal --out my-agent.json

# Validate it + see what cook would build.
cook check my-agent.json

# Generate the Docker artifact bundle (Dockerfile, compose, .env.example,
# README, recipes/).  Prompts for any required env vars unless --no-prompts.
cook build my-agent.json --out ./my-agent-cook

# Install directly onto this machine — no docker. Clones + builds every
# component under ~/.connectome/installs/<name>/, resolves host requirements
# (probe + confirm), writes run.sh + connectome.lock. The full action plan
# is printed and confirmed before anything executes on your machine.
cook install my-agent.json

# Launch. Finds an existing materialization (lock in the named dir, then
# ./<name>-cook, then ~/.connectome/installs/<name>) and launches it without
# re-resolving; falls back to build-then-compose-up. --rebuild forces a re-cook.
cook run my-agent.json -- -d            # detached (docker) / launcher args (host)
cook run ~/.connectome/installs/my-agent # launch a materialized dir directly
```

The bin is also installed as **`connectome`** — `connectome cook <recipe>`,
`connectome install <recipe>`, `connectome run <recipe>` are the same commands.

### Extensions

Recipes can carry deployment-specific code — custom context-manager
strategies and agent-framework modules — via the `extensions` block
(connectome-host ≥ the `feat/recipe-extensions` seam):

```jsonc
{
  "agent": { "strategy": { "type": "zk", "floodWindowMs": 250 } },
  "extensions": {
    "zk-strategy": {
      "kind": "strategy",                      // or "module"
      "path": "./extensions/zk/index.ts",      // entry module
      "source": { "url": "https://github.com/you/zk-ext.git", "ref": "main" }
    }
  }
}
```

- **With `source`**: cook clones/builds it into `/app/extensions/<name>`
  (docker) or `<install>/app/extensions/<name>` (host); `path` is relative
  to the repo root. Same install patterns as MCP sources (`npm`,
  `pip-editable`, custom run commands, authSecret, systemPackages).
- **Without `source`, relative path**: cook bundles the entry file's
  directory from your disk (docker) or uses it in place (host).
- Extensions live under the connectome-host tree so they share its
  `node_modules` — `extends AutobiographicalStrategy` resolves against the
  exact versions the host ships.

### Private git sources (tokens, usernames, internal CAs)

For sources cloned from private/internal git servers, the `source` block
takes four auth/TLS fields:

```jsonc
"source": {
  "url": "https://git.internal/team/notion-mcp.git",
  "install": "pip-editable",
  "authSecret": "GITLAB_DEPLOY_TOKEN",            // env var holding the token
  "authUsername": "gitlab+deploy-token-42",       // clone userinfo; default "oauth2"
  "caCert": "./certs/internal-ca.crt"             // pin TLS to this CA bundle
}
```

- **`authSecret`** — name of the env var holding the clone token. Docker
  builds read it as a BuildKit secret (`$(cat /run/secrets/NAME)` inline in
  the clone URL — never in the image or the environment); host installs
  read it from resolved values / the environment and scrub it from
  `.git/config` after the clone.
- **`authUsername`** — the username half of the clone URL's userinfo.
  Defaults to `oauth2` (GitLab PATs). GitLab **deploy tokens** — the
  least-privilege option for build-time clones — authenticate with their
  own username (e.g. `gitlab+deploy-token-42`), so they need this field.
  Restricted to `[A-Za-z0-9._~+-]` (it is spliced into a generated shell
  command).
- **`caCert`** — path to a CA bundle (PEM) for servers behind an internal
  CA. Relative paths resolve against the declaring recipe's directory, and
  the file must exist at cook time. Docker builds copy it into the build
  context at `ca-certs/<basename>` and every clone of that source runs
  `git -c http.sslCAInfo=/tmp/cook-ca/<basename>`; host installs point git
  at the operator's file directly. Scope is **per-source**: the `ch-deps`
  clone of connectome-host (`CH_REPO_URL`) is not affected.
- **`sslBypass`** — legacy escape hatch: disables TLS verification for the
  clone (`-c http.sslVerify=false`). With `authSecret` this sends the token
  over unverified TLS — prefer `caCert`. Declaring both is a validation
  error (they contradict).

### Host requirements (discovery)

For code that must link against things already on the machine:

```jsonc
"requirements": {
  "spring-engine": {
    "probe": ["/opt/spring", "~/spring", "$SPRING_HOME"],
    "prompt": "Path to your Spring engine install",
    "exposeAs": "SPRING_HOME"
  }
}
```

Cook probes the candidates, suggests the first hit, lets you confirm or
override, and exposes the answer as `$SPRING_HOME` — usable in recipe
`${VAR}` references and install steps, and recorded in the lock.

### Sidecars in host mode

`cook install` supports recipes with sidecar `services` and
`containerTemplateFiles`: the agent process runs natively, but sidecars
(databases, wikis) run under docker via a generated
`docker-compose.sidecars.yml`. `run.sh` brings them up with
`docker compose up -d --wait` before exec'ing the agent, renders
runtime templates with `envsubst` (needs `gettext-base`), and honors
`COOK_SKIP_SIDECARS=1`. One networking caveat, warned about at install
time: the native agent reaches sidecars via their **published localhost
ports** — compose service names only resolve inside the docker network.

### Pinned builds

`--pin-refs` (on `build` and `install`) resolves every branch/tag ref —
components and connectome-host itself — to its current commit SHA via
`git ls-remote` at cook time. The SHA is baked into clone/checkout steps
(and the `CH_REF` build-arg default) and recorded in `connectome.lock`,
so rebuilding later reproduces the exact trees. Unresolvable refs (offline,
private repos) warn and stay symbolic.

### Templates

- `minimal` — single agent, no MCP servers, generic system prompt.
- `zulip-agent` — single agent staffing a Zulip channel.
- `triumvirate` — three-agent fleet (miner + reviewer + clerk) with conductor.

### Build flags

```
--out <dir>            Output directory (default: ./<recipe-name>-cook)
--strict               Fail if any MCP server lacks a `source` block
--image-name <name>    Override the generated image name
--no-prompts           Non-interactive; warn-and-continue on missing values
--env-file <path>      Read variable values from this file before prompting
--pin-refs             Resolve branch refs to current SHAs (Phase 4 — TODO)
```

### Anthropic credentials

Every cooked deployment needs one Anthropic credential in its `.env`: either `ANTHROPIC_API_KEY` (a standard API key from [console.anthropic.com](https://console.anthropic.com/)) or `ANTHROPIC_AUTH_TOKEN` (a long-lived OAuth bearer token, sent by connectome-host as `Authorization: Bearer` instead of `x-api-key`). Cook's prompts, generated `.env.example`, and missing-value checks accept either — press Enter at the `ANTHROPIC_API_KEY` prompt to be offered the auth-token alternative. If both are set, connectome-host prefers the auth token. Exception: when a recipe explicitly substitutes `${ANTHROPIC_API_KEY}` (or `${ANTHROPIC_AUTH_TOKEN}`) without a default, that exact name is required — connectome-host errors at startup on a missing `${VAR}` — so the other credential can't stand in for it.

## What gets generated

```
<outDir>/                    # cook build (docker backend)
├── Dockerfile               # multi-stage; one builder per source (MCP + extensions) + ch-deps + runtime
├── docker-compose.yml       # single service; bind mounts from workspace mounts
├── .env.example             # template for the Anthropic credential + recipe ${VAR}s
├── .env                     # only when prompts/env-file/process.env supplied values
├── README.md                # operator instructions, data-driven from the recipe
├── connectome.lock          # record of the materialization (components, requirements, launch)
├── extensions/              # local extension bundles (when declared)
└── recipes/
    └── <each-walked-recipe>.json    # lowered configurations (overlays applied, source → sourceMeta)

<installDir>/                # cook install (host backend)
├── app/                     # connectome-host checkout (bun install'd; extensions under app/extensions/)
├── <repo-basename>/         # MCP source checkouts (mirrors the container layout)
├── recipes/                 # lowered configurations with host-absolute paths
├── .env                     # shell-sourceable operator values (mode 0600)
├── run.sh                   # launcher: source .env, cd app, exec bun
└── connectome.lock
```

The build context for `docker build` is `<outDir>` itself — operators don't need to clone connectome-cook to build the resulting image.

## Repo layout

```
connectome-cook/
├── bin/
│   └── cook                     # the CLI shim (defers to src/cli.ts)
├── src/
│   ├── cli.ts                   # subcommand dispatch + flag parsing
│   ├── walker.ts                # load + traverse fleet children
│   ├── source-detector.ts       # collect + dedupe McpSource list
│   ├── env-collector.ts         # scan recipes for ${VAR} references
│   ├── prompts.ts               # interactive collection of missing values
│   ├── init.ts                  # cook init templates
│   ├── slug.ts                  # shared slugify helper
│   ├── runtimes/                # per-install-pattern Dockerfile fragments
│   │   └── {npm,pip,custom,index}.ts
│   ├── generators/              # one file per output artifact
│   │   └── {dockerfile,compose,overlay,env,readme}.ts
│   └── vendor/
│       └── recipe.ts            # vendored from connectome-host (re-sync periodically)
├── examples/
│   └── triumvirate/             # canonical hand-curated reference + cook test target
├── docs/
│   ├── DESIGN-NOTES.md          # lessons from building the hand-curated examples
│   └── BUILD-PLAN.md            # phased implementation plan
└── test/
    └── e2e.test.ts              # cook build → verify artifacts round-trip
```

## Why a separate repo

- **connectome-host** is the framework — code, modules, recipe loader. Stays focused on the runtime.
- **Recipe repos** declare what to run, not how to deploy it.
- **connectome-cook** is the bridge: takes any recipe, emits a deployable artifact bundle. Versioned and released independently.

## Future home

For now this lives in @Tengro's namespace. Once the CLI is meaningfully battle-tested against richer recipe trees (multi-source, BuildKit secrets, mixed install patterns), it'll be handed off to anima-research alongside connectome-host.

## License

Apache 2.0. See [LICENSE](./LICENSE).
