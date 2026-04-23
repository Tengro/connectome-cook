# connectome-cook

Recipes in, Docker images out. A CLI that takes a [connectome-host](https://github.com/anima-research/connectome-host) recipe (single agent or multi-agent fleet) and cooks it into a runnable Docker image with all required MCP servers baked in.

> **Status:** scaffold. The CLI is not yet implemented. This repo currently holds the hand-curated reference example and design notes that will guide the implementation. Once the CLI exists, the example serves as its canonical test target.

## What it will do (planned)

1. Accept a recipe path or URL.
2. Walk recipes recursively (parent → fleet children).
3. Discover required MCP servers, default to pinned commits, allow ref overrides.
4. Interactively prompt for any secrets / env vars the recipes reference.
5. Generate `Dockerfile` + `docker-compose.yml` + `README.md` + recipe overlays into a target directory (`cook build` mode).
6. Optionally build + run the resulting image (`cook run` mode).

## Repo layout

```
connectome-cook/
├── examples/                       # hand-curated reference Docker setups that
│   └── triumvirate/                # the CLI must produce equivalent output for
│       ├── Dockerfile              # — the canonical test target
│       ├── docker-compose.yml
│       ├── README.md
│       └── recipes/
├── docs/
│   └── DESIGN-NOTES.md             # lessons + reusable patterns extracted from
│                                   # building the examples by hand; the spec
│                                   # the CLI implementation works against
└── src/                            # the CLI itself (TBD)
```

## Why a separate repo

- **connectome-host** is the framework — code, modules, recipe loader. Stays focused on the runtime.
- **Recipe repos** (e.g. `lynx-conhost-recipes`) declare what to run, not how to deploy it.
- **connectome-cook** is the bridge: takes any recipe, emits a deployable artifact bundle. Versioned and released independently.

## Future home

For now this lives in @Tengro's namespace. Once the CLI is meaningfully working it'll be handed off to anima-research alongside connectome-host.

## License

TBD — likely Apache 2.0 to match anima-research/connectome-host.
