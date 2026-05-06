# Sessions as Projects — Design Doc

## Goal

Grow the existing **session** concept into a long-lived, named, configurable container for a URL-pair set, and hide the imperative **runs** layer behind it. The user's primary mental model becomes "I have a project; I tune knobs; results update." Captures, comparison runs, jobs — those become an implementation detail of an *evaluator* that knows how to do only the work the cache doesn't already cover.

## Why now

The Altinn experiment surfaced the actual workflow pain. With 5,172 URL pairs and a half-dozen knobs (filter, viewport, level, hideSelectors, allow-list, LM model), every iteration cycle today costs:

- A new capture run (≈ minutes to hours, even when nothing material has changed for most pairs).
- A new comparison run (re-decodes the same captures, re-invokes the same LM with the same prompt).
- Mental bookkeeping to keep track of which run-id corresponds to which knob configuration.

The captures and verdicts are already content-addressed (SHA256 in `captures.screenshot_sha256`, `comparisons.im_diff_sha256`). The cache substrate exists — we just don't have a project model that exploits it.

## Non-goals (v1)

Explicit list to keep scope honest:

- Multi-user collaboration, sharing, or permissions.
- CI gating, scheduled re-evaluation, or alerting on regressions.
- Cross-project dashboards, aggregate reporting.
- Replacing the run-level API. Existing endpoints stay as escape hatches for power users and for backfilling cache from external runs.
- Importing arbitrary external screenshots (still drive captures through our pipeline).

If any of those become important, they're follow-up doc material, not v1.

---

## Concept changes

### Session evolves

Today: a session is a one-shot CSV upload. Its `url_pairs` are immutable. Comparison verdicts live on per-run rows.

Proposed: a session is a **named, editable URL-pair set** with a persistent **configuration** and a **current-results view** that's always live against the cache.

### Runs demote to evaluation history

Capture runs and comparison runs are still produced — they're how we *do* work — but the primary UI surface stops being "start a run, view its results." Instead it's "see the project's current state; press Evaluate to fill the gaps." Runs survive in a collapsible history panel for debugging.

### New concept: evaluation

An **evaluation** is the act of turning the project's current configuration into verdicts. Internally it computes a plan ("which `(url, viewport, opts_hash)` captures don't exist? which `(sha_a, sha_b, prompt_id, model_id, invocation_reason, pipeline_version)` LM verdicts don't exist?") and only enqueues the missing work. If everything is cached, evaluation is instantaneous and produces no new run rows. Concurrent calls coalesce onto a single in-flight evaluation.

---

## Data model

### `sessions` (extend)

Add columns:

```
default_viewports         JSON  -- e.g., ["desktop"]
default_capture_options   JSON  -- hideSelectors, settle_delay_ms, ua, locale, ...
default_equivalence_levels JSON -- e.g., ["tolerant", "semantic"] — multi-level by design
filter_query              JSON  -- structured predicate over url_pair facets (see below)
allow_list                JSON  -- [{url_pair_id, level, viewport}, ...] — viewport-aware
archived_at               TIMESTAMP NULLABLE
```

`filter_query` is a small DSL: `{ language: ["no"], category: ["starte-og-drive", "hjelp"], path_prefix: "/starte-og-drive/regnskap" }`. Empty predicate = all pairs. The query is intentionally narrower than SQL — it's what the UI knobs can produce.

### `url_pairs` (extend)

Promote known metadata out of `raw_row_json` for filterability:

```
language     TEXT NULLABLE
category     TEXT NULLABLE
subcategory  TEXT NULLABLE
path         TEXT NULLABLE  -- normalized path component for grouping
disabled     BOOLEAN DEFAULT 0  -- soft-remove without rebuilding the session
```

CSV upload pulls these from columns by exact name; falls back to `null`.

### Cache tables (new)

The evaluator's substrate. All keyed by stable hashes so the cache survives schema/UI changes. Both pixel and LM cache keys include `pipeline_version` — bumping it on a comparison-engine bug fix invalidates everything cleanly without a destructive migration.

```
capture_cache(
  url               TEXT,
  viewport_name     TEXT,
  capture_opts_hash TEXT,   -- sha256 of canonicalized capture options
  screenshot_sha256 TEXT NOT NULL,
  capture_id        TEXT NOT NULL,  -- FK to captures, for traceability
  created_at        TIMESTAMP,
  PRIMARY KEY (url, viewport_name, capture_opts_hash)
)

pixel_compare_cache(
  capture_a_sha     TEXT,
  capture_b_sha     TEXT,
  pipeline_version  TEXT,   -- bump to invalidate on engine bug fixes
  changed_pct       REAL,
  ssim              REAL,
  bbox_area_pct     REAL,
  component_count   INTEGER,
  im_diff_sha256    TEXT,
  comparison_id     TEXT NOT NULL,
  created_at        TIMESTAMP,
  PRIMARY KEY (capture_a_sha, capture_b_sha, pipeline_version)
)

lm_verdict_cache(
  capture_a_sha     TEXT,
  capture_b_sha     TEXT,
  prompt_id         TEXT,   -- sha256 of prompt_text (see lm_prompts)
  model_id          TEXT,
  invocation_reason TEXT,   -- 'semantic_mode' | 'ambiguous_pixel_result'
  pipeline_version  TEXT,
  verdict           INTEGER, -- 1/0
  summary           TEXT,
  confidence        REAL,
  comparison_id     TEXT NOT NULL,
  created_at        TIMESTAMP,
  PRIMARY KEY (capture_a_sha, capture_b_sha, prompt_id, model_id, invocation_reason, pipeline_version)
)
```

Notes:

- `capture_opts_hash` is sha256 over a canonical JSON of the option fields that affect rendering (viewports' fields, hideSelectors sorted, settleDelayMs, useNetworkIdle, userAgent, locale, timezoneId, reducedMotion). Adding a new option = include it in the canonical input → hash changes → recapture happens. Order doesn't matter.
- Pixel-compare cache is symmetric only by convention (we always order `(a, b)` consistently). If we ever swap, we look up by ordered pair.
- LM cache key includes `invocation_reason` because the prompt differs between semantic-mode and ambiguity-band tiebreaks (the corpus run surfaced this — the LM gives different verdicts on the same images under different prompts).
- `prompt_id` is a content hash of the prompt text. Edits to a session's prompt change `prompt_id`, which means cached rows under the old hash are still correct for any pre-edit verdict but won't be hit by post-edit lookups. No invalidation needed; old hash entries simply go stale.

Cache rows are upserted whenever a capture/comparison row reaches `complete` status. The runs themselves remain the ledger; the cache is a denormalized read-side index.

### LM prompts (new tables)

Prompts move out of env config into the database. Each session gets its own copies so they can be tuned per-project without affecting others; new sessions seed from a defaults table that's itself seeded from a checked-in config file.

```
lm_prompts(
  session_id        TEXT NOT NULL,
  invocation_reason TEXT NOT NULL,  -- 'semantic_mode' | 'ambiguous_pixel_result'
  prompt_text       TEXT NOT NULL,
  prompt_id         TEXT NOT NULL,  -- sha256(prompt_text); stable cache key
  updated_at        TIMESTAMP,
  PRIMARY KEY (session_id, invocation_reason)
)

lm_prompt_defaults(
  invocation_reason TEXT PRIMARY KEY,
  prompt_text       TEXT NOT NULL,
  prompt_id         TEXT NOT NULL,
  source            TEXT,           -- 'seed' (from constants file) | 'override' (admin-edited default)
  updated_at        TIMESTAMP
)
```

Source-of-truth flow:

- A checked-in constants file (e.g., `packages/api/src/constants/lm-prompts.ts`) defines the canonical defaults. This is the answer to "what does a fresh checkout do?"
- On migration / startup, `lm_prompt_defaults` is seeded from the constants file when empty. Subsequent deploys don't overwrite — admins can override defaults centrally without losing their edits to a redeploy.
- New sessions copy `lm_prompt_defaults` → `lm_prompts(session_id, ...)` at create time. From then on, prompts are session-scoped.
- Editing a session's prompt updates `lm_prompts.prompt_text` and recomputes `prompt_id`. Past LM verdicts remain valid (they're keyed on the old `prompt_id`) but won't be reused for that session's future evaluations — the next evaluation will see a cache miss for that `(sha_a, sha_b, new prompt_id)` and re-invoke the LM. This is the "session-scoped editing has local cache consequences" property by construction; no explicit invalidation step needed.

### `evaluations` (new)

A lightweight log of "I asked the project to evaluate at time T with config snapshot C." Useful for the history panel and for diffing config changes over time.

```
evaluations(
  id                   TEXT PRIMARY KEY,
  session_id           TEXT NOT NULL,
  config_snapshot_json TEXT NOT NULL,  -- frozen copy of session config at this moment
  enabled_pair_count   INTEGER,
  capture_run_id       TEXT NULLABLE,  -- created only if any captures were missing
  comparison_run_ids   JSON,           -- one per equivalence level evaluated
  cache_hits           JSON,           -- {captures: N, pixel: N, lm: N} summary
  started_at           TIMESTAMP,
  completed_at         TIMESTAMP NULLABLE
)
```

---

## Workflow change

**Before** (today):

1. Upload CSV → session.
2. POST `/api/capture-runs` → wait.
3. POST `/api/comparison-runs` with level X → wait.
4. Read results (scoped to the comparison run).
5. Want level Y? Goto 3.
6. Want to hide a banner? Goto 2 (re-capture everything).
7. Want a smaller subset? Today: build a new CSV, re-upload, re-everything.

**After**:

1. Upload/edit URL-pair set → session (named, persistent, addable).
2. Tweak config: viewports, hideSelectors, levels (multiple — see decision 2), allow-list (viewport-aware), filter, prompts. UI shows live "what would change" — number of captures needed, number of comparisons needed, what's already cached.
3. Press *Evaluate*. The system runs only the missing work. Most of the time most of the work is cached. Concurrent presses coalesce into a single in-flight evaluation.
4. Results view updates — pass/flag counts, mismatch list, soft list — at the session level, not per-run.
5. Repeat from step 2 with no penalty for whatever knob got changed.

Cache invalidation is manual and explicit (no TTLs — captures-on-real-URLs are deterministic enough that we'd rather force the user to acknowledge "the page changed"). UI affordances:

- *Invalidate this URL pair* — drops `capture_cache` rows for both `url_a` and `url_b` of one pair. Next evaluation recaptures.
- *Invalidate side A* (or B) of one pair — drops only one side. Useful when only one environment changed.
- *Invalidate side A of the entire list* (or B) — bulk drop for "Altinn just redeployed `inte`, recapture every B-side." This is the common case for pre-prod environment comparisons.

Prompt editing (per-session) doesn't need an invalidation gesture — changing the prompt text changes `prompt_id`, which naturally misses the LM cache and triggers re-invocation on next evaluation.

---

## API shape

Existing run endpoints stay. New session-scoped endpoints layer on top:

```
GET    /api/sessions/:id                       -- session + config + filter + url_pairs (with metadata)
PATCH  /api/sessions/:id                       -- update name, archived, etc.
PUT    /api/sessions/:id/config                -- replace/merge config object
POST   /api/sessions/:id/url-pairs             -- bulk add/remove (CSV upload OR JSON delta)
PATCH  /api/sessions/:id/url-pairs/:pair_id    -- edit-as-add+disable: creates new url_pair row,
                                                  marks old one disabled. Old captures stay tied
                                                  to the old row for traceability.
GET    /api/sessions/:id/results               -- session-level current verdicts (joins cache by
                                                  current config). Query params can override config
                                                  for ad-hoc views.
POST   /api/sessions/:id/evaluate              -- compute plan, enqueue missing work, return
                                                  evaluation_id. Coalesces: concurrent calls return
                                                  the same in-flight evaluation_id.
GET    /api/sessions/:id/evaluations           -- history list
GET    /api/evaluations/:id                    -- evaluation detail (config snapshot, cache hits,
                                                  run links)

GET    /api/sessions/:id/lm-prompts            -- session's prompts (per invocation_reason)
PUT    /api/sessions/:id/lm-prompts/:reason    -- edit one prompt; updates prompt_id implicitly
GET    /api/lm-prompts/defaults                -- defaults table
PUT    /api/lm-prompts/defaults/:reason        -- admin-only override of a default

POST   /api/sessions/:id/invalidate-captures   -- body: { pair_ids?: string[], side?: "a"|"b" }
                                                  Drops capture_cache rows; subsequent evaluation
                                                  re-captures. Omitting pair_ids = whole list.
                                                  Omitting side = both. So:
                                                    {} → invalidate everything for the session
                                                    {side:"b"} → all B-side captures (bulk)
                                                    {pair_ids:[...]} → those pairs, both sides
                                                    {pair_ids:[...], side:"a"} → those pairs, A only
```

`POST /api/capture-runs` and `POST /api/comparison-runs` keep working unchanged. Their results upsert into the cache when complete, so power-user runs feed the project model.

---

## UI shape (sketch)

The session detail page becomes the primary surface. Three regions:

```
┌────────────────────────────────────────────────────────────────────┐
│ Project: Altinn at23 vs inte                                       │
│ 5,172 URL pairs · last evaluated 4 min ago · 1 mismatch (allowed)  │
├──────────────┬─────────────────────────────────────────────────────┤
│ CONFIG       │ RESULTS (live against cache)                        │
│ Viewport ▾   │                                                     │
│ Level    ▾   │ Summary by level: pass / flag / soft / mismatch     │
│ Hide sel +   │                                                     │
│ Filter:      │ Mismatch table (clickable to comparison detail)     │
│  lang [no]   │                                                     │
│  cat ▾       │ [Evaluate] (5 captures + 1,820 comparisons missing) │
│  prefix /…   │                                                     │
│ Allow list   │                                                     │
└──────────────┴─────────────────────────────────────────────────────┘
```

The big win: the **Evaluate** button is honest about cost. It tells the user how many captures and comparisons are *actually* missing for the current config. If all green, the button greys out — done.

Runs disappear from primary nav. There's an "Evaluation history" disclosure that shows past evaluations for debugging.

---

## Migration

Backward-compatible by construction:

- Existing sessions become projects with default config (`viewports: ["desktop"]`, `levels: ["tolerant"]`, no filter, empty allow-list).
- `url_pairs.language/category/subcategory/path` populated from `raw_row_json` on first read; explicit backfill migration optional.
- Existing `capture_runs` / `comparison_runs` rows get walked once at deploy time to populate the three cache tables, tagged with `pipeline_version = "v1"`. After that, every new run upserts cache automatically.
- LM prompt seeding: on migration, if `lm_prompt_defaults` is empty, populate it from the constants file. New session creation thereafter copies defaults → `lm_prompts(session_id, …)`. Existing sessions get their prompts copied from `lm_prompt_defaults` as a one-shot backfill.
- The corpus runner script (`scripts/run-test-corpus.ts`) keeps using the run-level API for now — we can migrate it to evaluations later.

---

## Decisions

The eight open questions resolved (resolutions baked into the upstream sections of this doc):

1. **Filter expressiveness** — `{language, category, subcategory, path_prefix}` only. No tags in v1.
2. **Multi-level evaluation** — yes. `default_equivalence_levels: string[]` from day one. Results view shows verdicts at every selected level side-by-side.
3. **Cache invalidation on engine bug fixes** — yes. `pipeline_version` is part of pixel and LM cache PKs. Bumping it skips stale rows without a destructive migration.
4. **Capture freshness** — manual only, no TTL. UI exposes:
   - Invalidate one URL pair (both sides).
   - Invalidate one URL pair's A side or B side individually.
   - Invalidate all A-sides or all B-sides of the session in bulk (the "an environment got redeployed" gesture).
5. **Concurrent evaluations** — coalesce. A second `POST /evaluate` while one is in-flight returns the in-flight `evaluation_id`. Keeps results consistent and avoids redundant queue work.
6. **Allow-list scope** — viewport-aware. `(url_pair_id, level, viewport)` triples. A finding can be acknowledged on desktop without silencing it on mobile.
7. **LM prompt versioning** — moves into the database. Per-session `lm_prompts` table seeded from `lm_prompt_defaults`, which itself is seeded from a checked-in constants file. Editing a session's prompt automatically becomes a cache miss for that session via `prompt_id` (content hash). The constants file remains the source of truth for what a fresh checkout produces; admins can override defaults centrally without losing edits to a redeploy.
8. **Editable URL pairs** — add+disable. Editing a pair creates a new `url_pairs` row and disables the old one. Old captures stay attached to the old row so history is intact; the UI presents this as a single edit.

---

## Phasing

Smallest useful slice first; stop after any phase if priorities change.

- **Phase 1 — incremental evaluation under the hood.** Cache tables (with `pipeline_version`), upsert-on-run-complete, one-shot backfill of existing rows tagged `pipeline_version = "v1"`. No UI changes. The corpus runner gets faster on repeat invocations purely from cache hits. This is the highest leverage / lowest risk slice.
- **Phase 2 — `evaluate` endpoint.** `/api/sessions/:id/evaluate` (with coalescing) and `/api/sessions/:id/results`. Existing UI keeps working; runs still drive the visible workflow.
- **Phase 3 — session config + filter DSL.** `PATCH /api/sessions/:id/config`, multi-level support in results, allow-list persistence (viewport-aware).
- **Phase 4 — LM prompts in DB.** Constants file → `lm_prompt_defaults` seed; per-session `lm_prompts`; edit endpoint. Cache key flips from env-derived `prompt_version` to DB-derived `prompt_id`. Re-runs after this phase get cache misses for any pre-existing LM verdicts (acceptable one-time cost — and it forces us to validate cache-miss behaviour end to end).
- **Phase 5 — invalidation endpoints + UI affordances.** Per-pair, per-side, and bulk-per-side invalidation.
- **Phase 6 — new session detail UI.** Config + live results layout; runs demoted to history disclosure.
- **Phase 7 — URL-pair editing.** Add+disable mutation, evaluation history view.

Phase 1 alone is worth shipping — pure backend, low-risk, immediately useful.
