# visual-compare

Local-first web tool that imports paired URLs from CSV, captures viewport
screenshots with Playwright, and compares them with ImageMagick.

See `plans/in-progress/improved-visual-compare-plan.md` for the design.

## Layout

This repository uses a bare-repo layout to support multiple worktrees:

```
visual-compare/
├── .bare/         # bare git repo
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

## Layout (runtime)

Image artifacts are stored content-addressed under `data/images/sha256/<2hex>/<full>.png`.
SQLite database lives at `data/visual-compare.sqlite`. The `data/` directory is
gitignored.

### Sharing the image store across worktrees

When you work in multiple git worktrees, each one resolves `data/images` and
`data/visual-compare.sqlite` to its own copy by default — captures don't
dedupe across branches, and a fresh worktree starts with no images. The
recommended setup is **shared images, per-worktree DB**:

```sh
scripts/share-images-dir.sh
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
scripts/import-capture-cache.sh \
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
