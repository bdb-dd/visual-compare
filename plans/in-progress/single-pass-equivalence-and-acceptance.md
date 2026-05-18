# Single-Pass Equivalence and Acceptance

## Goal

Replace the current per-level evaluation model (one comparison run per equivalence level) with a single-pass model where each comparison is evaluated once and assigned the strictest level at which it is equivalent. Then build acceptance and regression detection on top of that, so users can mark current diffs as known-and-fine and automatically be alerted when later evaluations show *new or expanded* differences.

## Core insight

The four threshold levels — `pixel-perfect`, `strict`, `tolerant`, `loose` — form a monotonic hierarchy: anything equivalent at a stricter level is equivalent at every looser level. So the per-comparison output is not "passes/fails at level X" repeated N times — it's a single value: `matched_at_level`, the strictest level at which this comparison is equivalent (or `none` if it fails everywhere).

This collapses N comparison runs per evaluation into one, makes the Review panel's filter/sort by level natural, and gives acceptance a clean anchor point. `semantic` does not fit this hierarchy; it becomes an orthogonal "also require LM-judged content equivalence" axis, not a rung.

## User workflow this enables

1. **Pick a session-wide default level.** A single cheap pixel/SSIM pass populates `matched_at_level` for every comparison. The Review panel shows a histogram across levels; the user moves a slider and sees pass/fail counts update. No LM at this stage.
2. **Activate LM evaluation as a second pass on remaining failures.** LM is invoked only on comparisons that didn't match at the user's chosen level (plus anything in that level's ambiguity band). An LM "equivalent" verdict promotes `matched_at_level` to the user's target. LM runs at most once per comparison per evaluation.
3. **Review remaining real diffs and accept classes.** For each true diff, the user accepts it (optionally with a label like "cookie banner"). Acceptance snapshots enough state to detect later regressions. New evaluations check fresh comparisons against persisted acceptances and surface "new issues" in the Review panel when a diff has grown or regressed.

---

## Data model changes

DB is dropped and recreated; no data migration needed.

### Drop

- `comparison_runs.equivalence_level` — runs are no longer per-level.
- `comparisons.equivalence_level` — replaced by `matched_at_level`.
- `sessions.default_equivalence_levels` (plural list) — replaced by a single default level.
- `sessions.allow_list` — fully subsumed by acceptances. An "allow this no matter what" entry becomes an acceptance with no upper bound.

### Add / change

**`comparisons` (rewritten):**
- `matched_at_level` TEXT — one of `pixel-perfect`, `strict`, `tolerant`, `loose`, or `none`. Nullable until comparison completes.
- `matched_decided_by` TEXT CHECK IN (`pixel`, `lm`) — provenance of the level assignment.
- `lm_diff_summary` TEXT — LM-generated description of the diff, cached for UI display and for seeding label suggestions.
- Existing pixel metrics (`changed_pixel_percentage`, `ssim`, etc.), LM fields, and bounding-box / connected-component fields stay.
- Drop the redundant `equivalence_level` and the per-level `is_equivalent` column.

**`comparison_runs`:**
- Drop `equivalence_level`. One run per evaluation, not per level.

**New table `acceptances`:**
```
acceptances (
  id                          TEXT PRIMARY KEY,
  session_id                  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  url_pair_id                 TEXT NOT NULL REFERENCES url_pairs(id) ON DELETE CASCADE,
  viewport_name               TEXT NOT NULL,
  accepted_level              TEXT NOT NULL,    -- pixel-perfect | strict | tolerant | loose | none
  accepted_pixel_pct          REAL,             -- null when accepted_level = none AND no upper bound
  accepted_ssim               REAL,
  accepted_diff_regions_json  TEXT NOT NULL DEFAULT '[]',  -- bounding boxes at time of acceptance
  accepted_capture_a_sha      TEXT NOT NULL,
  accepted_capture_b_sha      TEXT NOT NULL,
  accept_any                  INTEGER NOT NULL DEFAULT 0,  -- 1 = ignore regardless of diff growth (replaces allow_list)
  label                       TEXT,
  notes                       TEXT,
  created_at                  TEXT NOT NULL,
  UNIQUE(session_id, url_pair_id, viewport_name)
);
CREATE INDEX idx_acceptances_session ON acceptances(session_id);
CREATE INDEX idx_acceptances_label ON acceptances(label);
```

`accept_any = 1` is the migration target for the old `allow_list` semantics: any diff is fine, no regression check.

**`sessions` config additions:**
- `default_equivalence_level` TEXT — single value, replaces the list.
- `region_match_config_json` TEXT — defaults: `{ growth_margin_px: 8, displacement_tolerance_px: 16, pixel_pct_delta: 0.5 }`.

**New table `url_pair_config_overrides`** (no generic per-pair override mechanism exists today, so we add one):
```
url_pair_config_overrides (
  url_pair_id           TEXT PRIMARY KEY REFERENCES url_pairs(id) ON DELETE CASCADE,
  equivalence_level     TEXT,             -- null = inherit session default
  region_match_config_json TEXT,          -- null = inherit session default; otherwise partial override merged over defaults
  updated_at            TEXT NOT NULL
);
```
Resolution at read time: `pair_override.<key> ?? session.<key> ?? system_default.<key>`. Future per-pair settings (capture options, prompts, etc.) extend this table rather than spawning new ones.

---

## Pipeline changes

### Comparison service (`services/comparison.ts`, `services/equivalence.ts`)

Rewrite `decideEquivalence` to return `matched_at_level` instead of a per-level boolean:

```
function computeMatchedAtLevel(metrics, sessionConfig) -> {
  level: 'pixel-perfect' | 'strict' | 'tolerant' | 'loose' | 'none',
  ambiguous: boolean,    // true if metrics fall in the ambiguity band of the session's target level
}
```

Walk levels strictest → loosest, return the first that passes (`changed_pct ≤ threshold` AND `ssim ≥ floor` if floor set). Ambiguity band detection is computed against the session's *target* level, not every level.

### Evaluation orchestration (`services/evaluator.ts`)

Single-pass flow per evaluation:

1. **Capture pass** — unchanged.
2. **Pixel pass** — for every (url_pair, viewport): fetch cached or compute pixel/SSIM metrics, derive `matched_at_level` greedily.
3. **LM pass (conditional)** — for comparisons where `matched_at_level` is weaker than the session target *or* falls in the target's ambiguity band, invoke LM. If the user explicitly disables LM for this evaluation, skip. LM "equivalent" verdict promotes `matched_at_level` to the session target; LM "different" leaves it where it is. Cache LM verdict + summary.
4. **Acceptance check** — for each completed comparison, if an acceptance exists for `(session, url_pair, viewport)`, compare current state against the snapshot and produce a derived `acceptance_status` (`accepted`, `regressed`, `expanded_diff`, `unaccepted`). This is computed at read time, not stored — region geometry is cheap.

The `lm_invocation_reason` enum loses `semantic_mode` (since semantic is no longer a level) and gains `target_level_failure` for the second-pass case.

### Region matching (new module)

`services/regionMatch.ts` — pure function `compareRegions(accepted, current, knobs) -> 'covered' | 'expanded' | 'displaced'`. Uses the three config knobs from `region_match_config_json`. Same module is invoked when the user changes region knobs, to re-derive `acceptance_status` for existing acceptances without re-running captures.

---

## Review UI changes (`packages/web/src/components/`)

Building on the existing two-panel review layout (`SessionResultsList.tsx` + `ComparisonDetail.tsx`).

### Left panel

- **Histogram strip at top:** counts per level (`pixel-perfect: 142 · strict: 88 · tolerant: 21 · loose: 9 · fails: 14`). Clicking a bucket filters the list to that level; shift-click extends.
- **Filter chips:** `All · Needs review · Accepted · Regressed · Expanded`. "Needs review" = unaccepted and weaker than session target. "Regressed" / "Expanded" surface acceptances that regressed at the level or grew in region terms.
- **Sort:** by level (default, weakest first), by changed %, by label.
- **Row chip:** existing pass/fail glyph extended with `~` (accepted), `△` (expanded diff), `↓` (level regressed).

### Right panel — comparison detail

- Show `matched_at_level` and (if present) `lm_diff_summary`.
- New "Accept" affordance. Default form:
  - Label (free text; suggestions seeded from `lm_diff_summary` and from existing labels in the session).
  - Notes (optional).
  - "Accept any future diff for this pair/viewport" toggle (sets `accept_any = 1`).
  - Snapshot is auto-populated from current metrics + regions; user does not edit numbers.
- If accepted and current state is `regressed` or `expanded`, the panel shows the diff between accepted snapshot and current state (e.g., "accepted at tolerant, now matches at loose" or "new region at (x,y,w,h) outside accepted regions").

### Bulk actions

- Select multiple rows in the left panel and bulk-accept with a shared label.
- "Auto-suggest labels" button: groups unaccepted comparisons by similarity of `lm_diff_summary` and proposes labels.

### Keyboard

Existing keys (`j`/`k`/`f`/`Esc`) plus:
- `a` — accept current comparison (opens label dialog).
- `A` — accept with last-used label, no dialog.
- `r` — re-review (clears acceptance).

---

## Config knobs

Session-level defaults in `region_match_config_json`:

| Knob | Default | Purpose |
|------|---------|---------|
| `growth_margin_px` | 8 | How much an accepted region's bbox can grow before it counts as expanded. |
| `displacement_tolerance_px` | 16 | How far a region can shift and still match an accepted region. |
| `pixel_pct_delta` | 0.5 | Percentage-point allowance over `accepted_pixel_pct` before flagging. |

Per-URL-pair overrides live in the new `url_pair_config_overrides` table. A pair's override JSON is merged over the session defaults at read time (partial override — set only the knobs you want to change). Defaults stay strict-ish; users relax per-pair when a specific page is known to be flaky.

`session.default_equivalence_level` — single value, default `tolerant`.

---

## Implementation phases

1. **Schema + types.** New migration that drops & rebuilds the affected tables, adds `acceptances`, adds `url_pair_config_overrides`, and adjusts the `sessions` config columns. Update TS types in `types.ts`. Drop `allow_list` and `default_equivalence_levels` references throughout. Implement the override-resolution helper (`resolveConfig(pair, session)`) and route all callers through it.
2. **Core pipeline.** Rewrite `decideEquivalence` → `computeMatchedAtLevel`. Rewrite `comparison.ts` to write the new comparison shape. Rewrite `evaluator.ts` orchestration: one comparison run per evaluation, conditional LM second pass.
3. **Region matching + acceptance read path.** New `regionMatch.ts`. Service layer to compute `acceptance_status` per comparison on read. New routes: `POST /sessions/:id/acceptances`, `DELETE /sessions/:id/acceptances/:id`, `GET` for listing.
4. **API surface for the histogram.** Endpoint that returns per-level counts and acceptance-status counts for a comparison run.
5. **Review UI.** Histogram strip, filter chips, accept dialog, bulk select, regression badges. Wire keyboard shortcuts.
6. **Tests + sample data refresh.** Existing test corpus regenerated for the new model. Add cases for: regression detection, region growth, region displacement, `accept_any` semantics, label auto-suggest.

Each phase is independently testable; phases 3–5 can overlap with each other but all depend on 1 + 2.

---

## Non-goals / deferred

- **Partial acceptance** (accepting some regions of a comparison but not others). Acceptance is whole-comparison for v1; the data model supports extending later because regions are stored as a list.
- **Acceptance versioning / audit log.** A single acceptance per `(session, pair, viewport)`. If the user re-accepts after a regression, the previous snapshot is overwritten. Add history later if needed.
- **LM-driven "is this the same diff as before?"** as a regression-resolution step (option (c) from the discussion). Start with geometric region matching; add LM fallback only if false-positive rate is annoying in practice.
- **Cross-session acceptance reuse.** Acceptances are session-scoped.

---

## Open questions

- Should `matched_at_level = 'none'` comparisons be eligible for acceptance with `accept_any = 0`? Yes — snapshot the current pixel pct and regions, alert if either grows beyond the knobs. The pipeline does not need to know whether a comparison "passed" to compute regression.
- When the user changes the session's `default_equivalence_level`, do existing acceptances stay valid? Yes — acceptances pin to their own `accepted_level`, independent of the session default. The session default only governs which comparisons are surfaced as "needs review."
