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
