# visual-compare

Local or remote deployable web tool that imports paired URLs from CSV, captures viewport
screenshots with Playwright, and compares them with ImageMagick. An
optional LM second pass adjudicates ambiguous pixel diffs and tags each
difference with a change-type taxonomy that drives a cluster-review
workflow.


## Requirements

- Node 22 (managed via `mise.toml`)
- pnpm 10
- ImageMagick 7 (`brew install imagemagick`) — provides the `magick` CLI
- Playwright Chromium browser binaries (`pnpm install:playwright`)

## Getting started

These steps are shared by both run modes below. Use `mise exec -- pnpm`
in this repo (the `mise.toml` pins Node + pnpm); plain `npm` produces
hard-to-debug version skew.

```sh
pnpm install                # installs both packages/api and packages/web
pnpm install:playwright     # Chromium binaries for capture
pnpm build                  # required for `pnpm start` and for deploy
```

From here, pick a run mode:

- [**Running locally**](#running-locally) — dev servers against an LM Studio you run on your machine.
- [**Running in Docker**](#running-in-docker) — single all-in-one container against an external OpenAI-compatible LM endpoint.
- [**Deployment**](#deployment) — Scaleway API VM with the LM on a separate GPU instance.

## Running locally

Start both servers (API on :3001, Vite on :5173):

```sh
pnpm dev
```

Or one at a time:

```sh
pnpm dev:api
pnpm dev:web
```

Production-style local run (after `pnpm build`):

```sh
pnpm start        # runs the built API from packages/api/dist
```

### LM Studio

The optional LM second pass talks to [LM Studio](https://lmstudio.ai) over
its OpenAI-compatible API on `http://localhost:1234/v1`. Install LM
Studio, pull a vision-capable model — `google/gemma-4-26b-a4b` is the
recommended (and current) default — and set `LM_STUDIO_MODEL` if you've
loaded a different id. With `LM_STUDIO_AUTO_START` and `LM_STUDIO_AUTO_LOAD`
on (defaults), the API will start the server and load the model via
the `lms` CLI on the first comparison that needs a verdict.

### Environment variables

All read by `readLmConfigFromEnv()` in
`packages/api/src/services/lm.ts` unless noted. Defaults in parentheses.

| Var | Default | Purpose |
| --- | --- | --- |
| `LM_STUDIO_BASE_URL` | `http://localhost:1234/v1` | OpenAI-compatible endpoint. Also used by the Scaleway backend, pointed at the GPU VM. |
| `LM_STUDIO_API_KEY` | `lm-studio` | Authorization token; LM Studio doesn't enforce it. |
| `LM_STUDIO_MODEL` | `google/gemma-4-26b-a4b` | Model id to load and route to. |
| `LM_STUDIO_PROMPT_VERSION` | `v3` | System prompt version (see `constants/lm-prompts.ts`). |
| `LM_STUDIO_MAX_TOKENS` | `1024` (overridden to `4096` in `mise.toml`) | Output-token cap. |
| `LM_STUDIO_TEMPERATURE` | `0.1` | Sampling temperature. |
| `LM_STUDIO_TIMEOUT_SECONDS` | `240` | Per-call timeout. |
| `LM_STUDIO_AUTO_START` | `true` | Run `lms server start` when `/v1/models` is unreachable. |
| `LM_STUDIO_AUTO_LOAD` | `true` | Run `lms load <model>` when the configured model isn't loaded. |
| `LM_STUDIO_PREFLIGHT_CACHE_SECONDS` | `30` | TTL for the cached preflight result. |
| `LM_STUDIO_INCLUDE_DIFF_IMAGE` | `false` | Send the red-highlight diff PNG alongside A and B. |
| `LM_STUDIO_PARALLEL` | `2` | Concurrent in-flight LM calls (read in `index.ts`). |
| `DB_PATH` | `data/visual-compare.sqlite` | SQLite path. |
| `IMAGES_DIR` | `data/images` | Image artifact root. |

### Sharing the image store across worktrees

When you work in multiple git worktrees, each one resolves `data/images` and
`data/visual-compare.sqlite` to its own copy by default — captures don't
dedupe across branches, and a fresh worktree starts with no images. The
recommended setup is **shared images, per-worktree DB**:

```sh
pnpm share-images
```

This symlinks `<worktree>/data/images` to `<repo-parent>/.shared/images`
(a sibling of the worktree directories and the `.bare` repo). Captures
made in any worktree become reachable from every other one via their
content-addressed `sha256` filenames; identical screenshots dedupe
automatically. The SQLite DB stays per-worktree on purpose so a schema
change on one branch can't corrupt another branch's data. The script is
idempotent and refuses to clobber a non-empty `data/images` directory.

### Reusing captures across worktrees

A fresh worktree's `capture_cache` starts empty, so even with the shared
images dir it would re-fire Playwright captures for every URL. To skip
that work when you've already captured the slice in another worktree:

```sh
pnpm import-capture-cache \
  --src ../other-worktree/data/visual-compare.sqlite \
  --dst data/visual-compare.sqlite
```

This copies the `captures` and `capture_cache` rows from `--src` into
`--dst`. The destination DB is created with the schema if it doesn't
exist yet. Foreign keys are turned off for the duration, so the imported
captures' references to the source's `capture_runs` / `url_pairs` (which
don't exist in the destination) are accepted. Idempotent via
`INSERT OR IGNORE`.

The destination's planner will then hit the cache for any URL whose
`(url, viewport, capture_opts_hash)` matches a row from the source —
so use **the same capture options** when uploading the CSV, or the
hash diverges and captures fire anyway.

## Repository Layout

This repository uses a bare-repo layout to support multiple worktrees:

```
visual-compare/
├── .bare/         # bare git repo
├── .shared/       # cross-worktree image store (see below)
├── main/          # worktree for the main branch
└── <feature>/     # additional worktrees as siblings
```

To work on a new branch, add a sibling worktree:

```sh
git -C main worktree add ../my-feature -b my-feature
```

## Packages

- `packages/api` — Express + SQLite + Playwright + ImageMagick backend
- `packages/web` — Vite + React frontend (proxies `/api` and `/images` to the API)

Cross-package types live in `packages/api/src/types.ts` and are imported via
the `@visual-compare/api/*` path alias declared in `tsconfig.base.json`.


## Running in Docker

A single all-in-one image is provided at the repo root: Node 22 API + Vite
SPA build + Caddy reverse-proxy + ImageMagick + Playwright Chromium, with
`supervisord` orchestrating Caddy and the Node process. Designed for
pointing at an **external** OpenAI-compatible LM endpoint (your own
gateway, OpenRouter, a self-hosted LM Studio on another host, etc.) —
`LM_BACKEND` defaults to `none` inside the image, so the API will not try
to spawn the local `lms` CLI.

### Volumes and ports

| Mount inside container | Purpose |
| --- | --- |
| `/data` | Persistent state: `visual-compare.sqlite` + `images/` (content-addressed PNG store) + `lm-last-use`. |
| `/config` | Read-only env drop. Entrypoint sources `/config/.env` before starting supervisord. |

Caddy listens on `:80` inside the container; `docker-compose.yml` maps it
to `:8080` on the host.

### Quick start with docker compose

```sh
mkdir -p docker-data docker-config
cp docker/config.env.example docker-config/.env
$EDITOR docker-config/.env       # fill in LM_STUDIO_BASE_URL/API_KEY/MODEL

docker compose build
docker compose up -d
```

Then open <http://localhost:8080>. Logs:

```sh
docker compose logs -f visual-compare
```

### Plain `docker run`

```sh
docker build -t visual-compare:local .

docker run -d --name visual-compare \
  -p 8080:80 \
  --shm-size=1g \
  -v "$(pwd)/docker-data:/data" \
  -v "$(pwd)/docker-config:/config:ro" \
  visual-compare:local
```

`--shm-size=1g` matters for headless Chromium: Playwright allocates shared
memory per tab and the default 64 MB OOMs during multi-tab captures.

### Required environment for the LM verdict pass

The user-supplied LM credentials map straight onto the same env vars
`readLmConfigFromEnv()` reads (see `packages/api/src/services/lm.ts`):

| Your value | Env var |
| --- | --- |
| OpenAI-compatible base URL (ends in `/v1`) | `LM_STUDIO_BASE_URL` |
| API key / bearer token | `LM_STUDIO_API_KEY` |
| Model id | `LM_STUDIO_MODEL` |

Put these in `docker-config/.env`; the entrypoint exports them so both
the Node process (via supervisord) and any child spawned by the API
inherit them. `docker/config.env.example` lists the optional tuning
knobs (`LM_STUDIO_MAX_TOKENS`, `LM_STUDIO_PARALLEL`,
`LM_STUDIO_TIMEOUT_SECONDS`, etc.).

The model must be vision-capable — the v3 prompt sends the A/B
screenshots inline as image content parts.

### Backups

The container's persistent state is entirely under `/data`. To back up,
stop the container (so SQLite finishes any WAL checkpoint) and tar the
host-side `docker-data/`:

```sh
docker compose stop
tar -C docker-data -czf visual-compare-backup-$(date +%F).tar.gz .
docker compose start
```


## Deployment

Single-environment Scaleway bring-up lives under `deploy/scaleway/`.
End-to-end docs (provisioning, DNS, deploy, secrets rotation, backups,
GPU lifecycle, costs, troubleshooting) are in
`deploy/scaleway/README.md`.

The LM backend swaps from local LM Studio to a Scaleway GPU instance
via `LM_BACKEND=scaleway`. Required env in that mode: `SCW_GPU_ZONE`,
`SCW_GPU_INSTANCE_ID`, `SCW_SECRET_KEY`, `LM_STUDIO_BASE_URL` (pointed
at the GPU VM), and `LM_STUDIO_MODEL`. The full SCW env reference lives
in `deploy/scaleway/README.md`.

Two convenience wrappers are exposed from the repo root:

```sh
pnpm provision <subcommand>   # → bash deploy/scaleway/scripts/provision.sh
pnpm deploy                   # → bash deploy/scaleway/scripts/deploy.sh
```

`pnpm deploy` takes no arguments — it rsyncs code, rebuilds on the API
VM, and reloads services.

`pnpm provision` is a multi-subcommand wrapper covering the full
Scaleway lifecycle. The common ones:

```sh
pnpm provision check          # sanity-check env + scw auth
pnpm provision gpu            # create the LM Studio GPU VM
pnpm provision api            # create the API VM + block volume
pnpm provision status         # print IDs + IPs from state.env
pnpm provision start-gpu      # power an existing stopped GPU back on
pnpm provision stop-gpu       # power the GPU off (default state)
pnpm provision resize-api <commercial-type>
                              # in-place API VM resize
```

(Don't pass a literal `--` between `pnpm provision` and the subcommand;
pnpm 10 forwards it through as a positional arg and the script will
reject it with `unknown subcommand: --`.)

There are more (IP reservation, instance recreate, port opening,
cloud-init tailing). See `deploy/scaleway/README.md` for the full list
and operational context.

## Implementation status

What's live on `main` / `refactor`:

- **CSV intake → capture → pixel compare → optional LM verdict** end-to-end.
- **Cluster review surface.** Differences carry a v1 signature
  (`change_type`, `region_role`, `element_label`) materialised into
  `difference_clusters`. The UI groups members by cluster, supports
  Shift+arrow navigation, "A | B" view, per-member accept, contextual
  acceptance rules (cluster + category), and split-cluster placeholders.
- **Acceptance rules.** `acceptance_rules` fan out into `acceptances`
  via `acceptCluster` / `acceptCategory` / `applySessionRules` (see
  `packages/api/src/services/acceptance-rules.ts`).
- **LM v3 prompt.** Default prompt version is `v3`; JSON-schema routing
  is content-based on the prompt text. Existing sessions retain their
  prior prompt version until reset — see `PHASE_C_NOTES.md` for the
  per-session upgrade procedure.
- **Session-scoped routing**, metrics row, error log tab, in-process
  CPU usage indicator, capture-failed outcome filter.

Refactor phases 1–5 are shipped (see `plans/in-progress/refactoring-plan.md`).
Phase 6 (worker VM pool) is deferred — see the section at the end of
this README.

## Runtime layout

Image artifacts are stored content-addressed under
`data/images/sha256/<2hex>/<full>.png`. SQLite database lives at
`data/visual-compare.sqlite`. The `data/` directory is gitignored.
Both paths apply to local dev and the deployed API; override either
via the `DB_PATH` / `IMAGES_DIR` env vars.

## Planned: capture / comparison execution infrastructure

Today, captures and pixel compares run in-process on the API VM via
`services/evaluator.ts`. That works for the current single-tenant scale,
but is the bottleneck once concurrency or throughput grows: the API
host pays for always-on Playwright + ImageMagick capacity it usually
isn't using.

The deferred Phase 6 (**Worker VM pool**) of `plans/in-progress/refactoring-plan.md`
proposes pulling capture and compare out of the API process:

- Define a worker RPC interface at the current in-process boundary in
  `services/evaluator.ts` (capture pair, compare pair).
- Build a worker image with Playwright + ImageMagick.
- Add scheduling, scale-to-zero, and cross-worker retry.
- Make `.shared/images` reachable from workers (shared volume or
  object store with per-job sync).
- Shrink the API VM to management-only sizing.
- Reuse the existing `/api/worker-activity` shape so the in-process
  CPU indicator (3.C) keeps working with no client-side change once
  it starts reporting real worker pool data (6.B).

Phase 6 is gated on the §0 design doc (transport, shared image
storage, scale-to-zero policy, cross-worker retry, observability).
See `plans/in-progress/refactoring-plan.md` for the full dependency
map and exit criteria.
