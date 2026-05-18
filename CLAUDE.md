# Repo conventions for Claude Code

Pointers for working in this repo. Code itself is authoritative; this file
captures the things that aren't obvious from reading the tree.

## Layout

Bare-repo + worktrees setup at `/Users/bdbrodie/dev/portals/visual-compare/`:

```
.bare/                bare repository (refs, objects, no working tree)
.shared/images/       deduplicated image artifact store (capture + diff PNGs)
main/                 the only active worktree — branch `main`, canonical state
```

There is currently exactly one active worktree (`main`) and one branch
(`main`). Don't create new worktrees unless explicitly asked; if you do, use
`git worktree add -b <branch> <path> main`. New worktrees inherit the
`.shared/images` store via `scripts/share-images-dir.sh`.

## Data

Local-only state lives in `main/data/`:

- `visual-compare.sqlite` — the canonical dev DB (~1.2 GB). Carries
  cluster-review migrations + backfilled signatures + accepted-state
  testing.
- `visual-compare.pre-cluster-review.sqlite` — pre-Phase-A baseline
  (~750 MB) kept as a recovery point. Don't touch unless rolling back.
- `images` — symlink to `.shared/images`. The `share-images-dir.sh`
  script wires this up for any new worktree.

The default `DB_PATH` in `packages/api/src/index.ts` resolves to
`<repo-root>/data/visual-compare.sqlite`, so starting the dev server from
`main/packages/api` Just Works.

## Tooling

- Package scripts run via `mise exec -- pnpm`, **never** `npm`. mise pins
  the Node version + pnpm globally; bypassing it produces hard-to-debug
  version skew. The repo's `mise.toml` is trusted in this checkout.
- pnpm workspaces — `pnpm install` from the repo root installs both
  `packages/api` and `packages/web`.
- TypeScript across the monorepo; vitest for API tests; Vite for the web
  app. `mise exec -- pnpm typecheck` and `mise exec -- pnpm vitest run`
  work from any package dir.

## Test suites

API tests run in two phases (see `packages/api/package.json` scripts):

- `test:parallel` — the default suite under vitest's normal file-parallel
  mode. Fast.
- `test:serial` — a small set of timing-sensitive tests that need
  `fileParallelism: false` because event-loop starvation between parallel
  worker files makes them flake. Currently:
  - `test/comparison-concurrency.test.ts`
  - `test/imagick-runtime.test.ts`

  Listed once in `vitest.serial-tests.ts`; the default config excludes
  them and `vitest.config.serial.ts` includes them.

`pnpm test` runs both phases. Failures in either phase are real
regressions — the flake workaround is the serial config itself, not a
license to ignore them.

## Cluster review feature

The cluster-driven review surface is live in `main`. Top-level summary so
you don't have to re-derive it:

- Schema: `differences` carries `signature` / `signature_version` plus the
  v1 taxonomy columns (`change_type`, `region_role`, `element_label`).
  New tables: `difference_clusters` (materialised index) and
  `acceptance_rules` (cluster + category rules with fan-out into
  `acceptances`).
- Service entry points: `packages/api/src/services/cluster-signature.ts`
  (v0/v1 signature dispatcher), `clusters.ts` (`recomputeClusters`,
  `listClusters`), `acceptance-rules.ts` (`acceptCluster`,
  `acceptCategory`, `applySessionRules`, plus their revoke counterparts).
- API: `GET/POST /api/sessions/:id/clusters[...]` and
  `category-accept[/:rule_id]` in `routes/clusters.ts`.
- Web: `ClustersPage`, `ClusterDetailPage`, `AnomaliesPage` in
  `packages/web/src/pages/`.
- LM prompt: the v3 system prompt in `constants/lm-prompts.ts` teaches the
  taxonomy. `DEFAULT_PROMPT_VERSION = 'v3'`. JSON-schema routing is
  content-based (`usesV1Taxonomy` / `jsonSchemaForPrompt`); a prompt
  containing `changeType` + `regionRole` triggers the v3 strict schema.
- Design + experiments: `cluster-review-proposal.md` (amended in place,
  reflects what shipped), `experiments/findings.md`,
  `experiments/v1-taxonomy.md`, `PHASE_C_NOTES.md` (per-session upgrade
  procedure for the v3 prompt cutover).

## Upgrading an existing session to v3

Existing sessions retain their v2 prompts after the cutover unless the
user explicitly resets:

```
POST /api/sessions/<session_id>/lm-prompts/target_level_failure/reset
POST /api/sessions/<session_id>/lm-prompts/ambiguous_pixel_result/reset
```

Then re-evaluate. The `lm_verdict_cache` keys on `prompt_id`, so the first
run after the reset re-invokes the LM for every comparison that needs a
verdict.

## What's deferred / not in scope

Documented at the bottom of `cluster-review-proposal.md`:

- Split cluster gesture (UI placeholder is disabled with a tooltip)
- Crop view in cluster detail (currently full screenshot + bbox overlay)
- Keyboard shortcuts on the cluster surface
- Cross-session memory for rules
- Live precision/recall measurement on a curated change-set
- Experiment C (UI time-to-triage A/B vs row-by-row review)
