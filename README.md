# visual-compare

Local-first web tool that imports paired URLs from CSV, captures viewport
screenshots with Playwright, and compares them with ImageMagick. An
optional LM second pass adjudicates ambiguous pixel diffs and tags each
difference with a v1 change-type taxonomy that drives a cluster-review
workflow.

The original design is in `plans/completed/improved-visual-compare-plan.md`.
The current iteration plan (phases 1–5 shipped, Phase 6 deferred) is in
`plans/in-progress/refactoring-plan.md`.

## Layout

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

## Requirements

- Node 22 (managed via `mise.toml`)
- pnpm 10
- ImageMagick 7 (`brew install imagemagick`) — provides the `magick` CLI
- Playwright Chromium browser binaries (`pnpm install:playwright`)

## Getting started

```sh
pnpm install
pnpm install:playwright
pnpm dev          # API on :3001, Vite on :5173
```

For a single package:

```sh
pnpm dev:api
pnpm dev:web
```

Production-style local run (after `pnpm build`):

```sh
pnpm start        # runs the built API from packages/api/dist
```

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

You can also override either path explicitly via the `DB_PATH` and
`IMAGES_DIR` env vars.

### Reusing captures across worktrees

A fresh worktree's `capture_cache` starts empty, so even with the shared
images dir it would re-fire Playwright captures for every URL. To skip
that work when you've already captured the slice in another worktree:

```sh
pnpm import-capture-cache -- \
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

## Deployment

Single-environment Scaleway bring-up lives under `deploy/scaleway/`.
End-to-end docs (provisioning, DNS, deploy, secrets rotation, backups,
GPU lifecycle, costs, troubleshooting) are in
`deploy/scaleway/README.md`.

Two convenience wrappers are exposed from the repo root:

```sh
pnpm provision -- check    # sanity-check env + scw auth
pnpm provision -- gpu      # create the LM Studio GPU VM
pnpm provision -- api      # create the API VM + block volume
pnpm deploy                # rsync code, rebuild, reload services
```

Both wrappers forward arguments to the underlying scripts in
`deploy/scaleway/scripts/`.

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
