# Cluster-driven Review: Data Model, UI Flow, and Validation Plan

Status: **shipped** — Phases A through E landed on this branch as six commits
on top of `plan-improved-visual-compare`. The cluster review system is
end-to-end usable. This document was originally the design; what follows
has been amended in place to reflect what was actually built. Where the
implementation diverged from the original design, the reason is noted.

Branch: `cluster-review-design`.
Reviewer: BDB.

Commits on this branch:
| Phase | Commit | What landed |
|---|---|---|
| Design | `7529cd8` | Design doc + experiments + v3 prompt prep (held off-by-default) |
| A | `2e18e59` | Schema + signature service + read-only API + 32 tests |
| B | `08ba524` | Read-only cluster review UI (ClustersPage, ClusterDetailPage) |
| C | `ce6df73` | v3 prompt + v1 cluster signatures activated by default |
| D | `86d7b63` | Cluster Accept / Reject with rule-owned fan-out + 15 tests |
| E | `91ec21c` | Category bulk-accept + applySessionRules + Anomaly queue + 9 tests |

Companion documents:
- `experiments/findings.md` — Experiment A + B results
- `experiments/v1-taxonomy.md` — locked-in taxonomy spec
- `experiments/experiment_a_v0_leverage.py`, `experiment_a_cluster_inspection.py`, `experiment_b_v1_simulation.py` — reproducible measurement scripts
- `PHASE_C_NOTES.md` — per-session upgrade procedure for the v3 prompt cutover
- `packages/api/src/services/cluster-signature.ts` — v0 + v1 signature implementation
- `packages/api/src/services/clusters.ts` — cluster materialisation
- `packages/api/src/services/acceptance-rules.ts` — cluster + category rule fan-out
- `packages/api/src/routes/clusters.ts` — read + mutation endpoints
- `packages/web/src/pages/{ClustersPage,ClusterDetailPage,AnomaliesPage}.tsx` — UI

## 1. Problem

The current review unit is the `(comparison, url_pair, viewport)` row. With N pairs and K shared edits (nav/footer/alert/etc.), a reviewer faces ~N×K decisions even though the underlying *human* decisions are closer to K.

Categorisation is the hard part; spotting differences is solved. So: assume we can attach a stable *signature* to each `differences` row. Build the review workflow around that signature, not around `comparisons`.

## 2. Core hypothesis

**A small set of cluster signatures explains most differences in a session.**

Operational claim: in a representative session, more than ~60% of `differences` rows fall into the top 10 clusters by size. If true, cluster-level decisions cut reviewer load by an order of magnitude, and what remains (the long tail of singletons) is the real signal.

If the signature is too coarse → silent false-accepts; if too fine → no clustering, no leverage. Designing and validating the signature is the load-bearing risk.

## 3. Data model

Layered on top of the existing schema (`sessions → url_pairs → comparisons → differences`, plus `acceptances` keyed by `(session, url_pair, viewport)`). All new tables are additive; nothing about the pipeline today changes except that the per-difference write step also writes a signature.

### 3.1 New columns on `differences`

```sql
ALTER TABLE differences ADD COLUMN signature TEXT;          -- canonical key, see §4
ALTER TABLE differences ADD COLUMN signature_version TEXT;  -- e.g. 'v0', 'v1' — lets us recluster without losing the old grouping
ALTER TABLE differences ADD COLUMN change_type TEXT;        -- enum, LM-extracted (v1+); NULL in v0
ALTER TABLE differences ADD COLUMN region_role TEXT;        -- enum, LM-extracted (v1+); NULL in v0
ALTER TABLE differences ADD COLUMN element_label TEXT;      -- canonicalised string from LM (v1+); NULL in v0
CREATE INDEX idx_differences_signature ON differences(signature, signature_version);
```

The `*_version` column matters: we will iterate on signatures, and old verdicts (acceptance rules etc.) must be auditable against the signature scheme they were made under.

### 3.2 `difference_clusters` — materialised view of grouped diffs

A cluster is a derived object: `(session_id, signature, signature_version)` plus aggregates. Rebuilt incrementally as new differences land.

```sql
CREATE TABLE difference_clusters (
  id                  TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  signature           TEXT NOT NULL,
  signature_version   TEXT NOT NULL,
  -- denormalised facets the UI sorts/filters on
  viewport_name       TEXT,
  region_role         TEXT,
  change_type         TEXT,
  element_label       TEXT,
  -- representative diff, picked by largest bbox area or highest LM confidence
  representative_difference_id TEXT REFERENCES differences(id) ON DELETE SET NULL,
  member_count        INTEGER NOT NULL DEFAULT 0,
  pair_count          INTEGER NOT NULL DEFAULT 0,  -- distinct url_pair_ids the cluster touches
  -- review state
  review_state        TEXT NOT NULL DEFAULT 'open'
                       CHECK(review_state IN ('open', 'accepted', 'rejected', 'split', 'anomaly')),
  review_notes        TEXT,
  reviewed_at         TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE(session_id, signature, signature_version)
);

CREATE INDEX idx_clusters_session_state ON difference_clusters(session_id, review_state);
CREATE INDEX idx_clusters_session_region ON difference_clusters(session_id, region_role);
```

### 3.3 `acceptance_rules` — cluster-level decisions that persist

The existing `acceptances` table is per-`(pair, viewport)`. We *keep* it (it's the source of truth for individual rows) but add a higher-level abstraction so a single cluster verdict can mass-create or mass-revoke per-row acceptances.

```sql
CREATE TABLE acceptance_rules (
  id                  TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  signature           TEXT NOT NULL,
  signature_version   TEXT NOT NULL,
  scope               TEXT NOT NULL CHECK(scope IN ('cluster', 'category')),
  -- 'cluster': matches exactly this signature.
  -- 'category': matches any cluster sharing this (region_role, change_type) tuple
  --             at the same signature_version. Lets reviewers say "all
  --             footer-text-changes are fine" in one shot.
  category_region_role TEXT,
  category_change_type TEXT,
  label               TEXT,
  notes               TEXT,
  created_by          TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX idx_acceptance_rules_session ON acceptance_rules(session_id);
CREATE INDEX idx_acceptance_rules_signature ON acceptance_rules(signature, signature_version);
```

When a rule is created, a service worker fan-outs to write per-`(pair, viewport)` rows into `acceptances` (so the existing pixel/region regression machinery keeps working unchanged). When a rule is deleted, the fan-out reverses. The fan-out is the only side-effect; everything downstream (the histogram, the SessionResultRow stream) reads from `acceptances` as today.

### 3.4 Why not collapse `differences` into clusters directly?

Because differences are per-comparison facts we want to keep intact (LM-extracted bounding boxes, severities, captions are useful in their own right, even outside the cluster UI). Clusters are an *index* over them. If we ever change the signature, we recompute clusters; the underlying differences don't move.

## 4. Signature design — staged rollout

The signature is a hash of canonical inputs. We propose **two versions** rolled out behind `signature_version` (v0 as a fallback for unlabelled rows; v1 as the steady-state cluster key). A semantic-similarity v2 stays on the shelf as a contingency but isn't planned.

### v0 — purely geometric / heuristic (fallback only)

```
sig_v0 = sha1(viewport_name | grid_cell | size_band | source)
```

- `grid_cell` = bbox centroid quantised to a 10×10 grid.
- `size_band` = log-bucketed bbox area in percent (`xs<0.1%`, `s<1%`, `m<5%`, `l<20%`, `xl>=20%`).
- `source` = `'imagick' | 'lm'`.

v0 was the Experiment A measurement substrate and now serves as **the fallback signature** for two cases:
1. **v2-era cached LM differences** that don't have v1 tags (avoids forcing a re-run of the LM on already-cached comparisons).
2. **imagick-sourced differences.** Per Finding 1 in `experiments/findings.md`, imagick CCs (~93 per comparison) are too noisy to cluster meaningfully at the pair level. They stay in the schema as per-comparison evidence but aren't first-class cluster citizens.

**Why v0 is not the primary signature.** Experiment A's cluster inspection found both failure modes:
- *Under-clustering*: one "sidebar nav added" change split across 3 top-10 clusters because the bbox centroid landed in different grid rows per page.
- *Over-clustering (the dangerous one)*: cluster #7 (83 pairs) lumped 4 semantically distinct changes — announcement removal, list expansion, accordion edits, paragraph addition — into one cluster. Mass-accepting it would silently auto-accept four unrelated edits.

### v1 — structured LM extraction (primary)

```
sig_v1 = sha1(viewport_name | region_role | change_type | normalize(element_label))
```

Three structured fields on every LM-sourced `differences` row, defined in `experiments/v1-taxonomy.md`:

- `change_type` — 10-value enum: `element_added`, `element_removed`, `element_replaced`, `text_changed`, `text_translated`, `image_changed`, `style_changed`, `count_changed`, `state_changed`, `other`.
- `region_role` — 10-value enum: `header`, `nav_primary`, `nav_secondary`, `hero`, `main_content`, `aside`, `footer`, `overlay`, `alert_banner`, `other`.
- `element_label` — short noun phrase (≤64 chars). The prompt provides a canonical-form list (`main heading`, `breadcrumbs`, `sidebar navigation`, `footer`, `announcement`, `accordion item`, `primary CTA`, `search input`, `hero image`, `page state`, `language`, etc.) and instructs the LM to prefer these when applicable; otherwise emit a short freeform label.

Two non-obvious rules locked in during v1 validation:
1. **Single-element content edits stay `text_changed`.** Breadcrumb path expansion, headline rewording, paragraph revision are all `text_changed` — never `element_added` / `element_replaced` — when the element itself is present on both sides. Surfaced because the first taxonomy draft split breadcrumb changes into 4 clusters by verb-of-change.
2. **`region_role` is implied by canonical `element_label`** when one applies (`accordion item` → `main_content`, `breadcrumbs` → `nav_secondary`, etc.). Bbox-based inference is only the fallback for freeform labels.

Runtime normalisation is intentionally minimal: trim, lowercase, collapse whitespace, strip punctuation except hyphens/apostrophes. No synonym substitution — the LM does the canonicalisation work via the prompt.

**Validated behaviour** (v1 simulation on existing data — `experiment_b_v1_simulation.py`):
- 3 sidebar clusters → 1 cluster of 483 pairs. ✓
- 4 breadcrumb clusters → 1 cluster of 315 pairs. ✓
- Cluster #7's 4 distinct changes → 4 separate coherent clusters. ✓
- Top-3 pair coverage: 26.1% (v0) → 49.6% (v1). Top-10: 57.3% → 63.8%.

The v0 top-50 number (99.2%) was higher than v1's (77.5%) but inflated by lumping. v1's tail is longer because v1 reflects the actual diversity of distinct changes; each v1 cluster is now something a reviewer can act on as a single decision.

**Code path.** `packages/api/src/services/lm.ts` carries the extended zod
schema (v1 fields optional for v2-era cache back-compat), the strict
`LM_JSON_SCHEMA_V3` sent to LM Studio, and a content-based schema router.

*What shipped, slightly different from the original sketch.* The early
design routed by a `'v3'` prompt-version label. That broke on the
session-scoped prompt path where `args.prompt.id` is a sha256 hash, not a
version string. The fix (in Phase C, `ce6df73`) is content detection:
`usesV1Taxonomy(text)` checks for `'changeType'` AND `'regionRole'` in the
prompt body; `jsonSchemaForPrompt(text)` routes accordingly. A prompt that
teaches the v1 taxonomy gets the v3 schema; everything else gets v2. The
storage label `DEFAULT_PROMPT_VERSION` is now `'v3'` and used only as an
audit / cache-key annotation.

The v3 prompt body itself lives in `constants/lm-prompts.ts` as the
canonical source — `SYSTEM_PROMPT_V3` was originally duplicated in
`lm.ts` but was removed in Phase C to keep one source of truth.

### v2 — semantic backstop (not planned)

If v1's canonical-label scheme proves too brittle in practice, a fallback would re-embed `description` text and cluster by cosine similarity. The DB column `signature_version` is designed to admit a `'v2'` value coexisting with v1 if we ever need it. Not on the roadmap.

## 5. UI flow

Three React pages shipped, plus a button on the existing session detail
page to enter the cluster review surface. Tab-stripping with the existing
results list (originally proposed) was deferred — the cluster pages live
under `/sessions/:id/clusters` as a parallel surface that the session
header links to. Reviewers who want the row-by-row view stay on the
existing session detail.

### 5.1 Category index (entry point)

Layout sketch:

```
┌───────────────────────────────────────────────────────────────────────┐
│ Session: NRK rebrand — 2026-05-11 capture                             │
│ 312 diffs across 47 pairs · 23 clusters · 4 categories                │
├───────────────────────────────────────────────────────────────────────┤
│ ▾ Navigation (1 cluster, 47 pairs)            [Accept all]  [Open →] │
│   nav primary  ·  layout_shifted              ████████████  47 pairs │
│                                                                       │
│ ▾ Footer (2 clusters, 47 + 12 pairs)          [Accept all]  [Open →] │
│   footer copyright  ·  text_changed           ████████████  47 pairs │
│   footer social icons  ·  image_changed       ███           12 pairs │
│                                                                       │
│ ▾ Body content (9 clusters, 4–11 pairs each)  [Open →]               │
│ ▾ Anomalies (12 singleton clusters)           [Open →]               │
└───────────────────────────────────────────────────────────────────────┘
```

Categories are derived from `region_role` (header+nav merged for display; anomalies = clusters with `pair_count == 1`). Within each category, clusters are sorted by `pair_count` desc — biggest leverage first.

*What shipped, slightly different.* The proposal sketch shows one "Accept
all" per category. The actual UI surfaces one bulk-accept button per
`(region_role, change_type)` subgroup inside the category — because a
single category like "Main content" usually contains multiple distinct
change types (`element_added`, `text_changed`, `element_removed`, ...) and
each is a different decision. Each subgroup button is labelled
`<change_type> · open/total` and disabled when every cluster in that
subgroup is already accepted. A confirm dialog shows the cluster count,
total pair count, and a 3-sample list before committing.

There's an additional category called **Untagged (v0 fallback)** that
holds clusters lacking `region_role`/`change_type` — imagick rows and
v2-era LM responses that pre-date the v3 prompt. It has no bulk-accept
button (the API requires both tags). It exists for visibility and shrinks
as sessions are re-evaluated under v3.

### 5.2 Cluster detail

Clicking a cluster opens a focused view:

```
┌─ Cluster: footer copyright · text_changed ─────────────── 47 pairs ─┐
│                                                                     │
│   [ A capture crop ]      [ B capture crop ]      [ diff overlay ]  │
│                                                                     │
│   Sample: /en/about/contact  (viewport: desktop)                    │
│                                                                     │
│   LM summary: "Footer copyright year updated 2025 → 2026."          │
│   Confidence: 0.94 · Severity: low · Region role: footer            │
│                                                                     │
│   [ Accept cluster ]  [ Reject ]  [ Split cluster ]  [ Skip ]       │
│                                                                     │
├─ Members (47) ──────────────────────────────────────────────────────┤
│   ☑ /en/about/contact   desktop   ssim 0.998   ◧                    │
│   ☑ /en/news/index      desktop   ssim 0.997   ◧                    │
│   ☑ /no/forside         desktop   ssim 0.998   ◧                    │
│   ... [load 44 more]                                                │
└─────────────────────────────────────────────────────────────────────┘
```

Key affordances (what actually shipped):

- **Full-screenshot triple with bbox overlay**, not the crop view originally
  proposed. The existing `ImageWithBoxes` component does the highlighting;
  cropping would have required a separate image pipeline. The bbox overlay
  was the cheaper-to-ship answer for the same UX intent ("show the change
  in context, not the whole page as noise"). Crop view remains a candidate
  improvement.
- **Member focus** — clicking a member's `◧` button replaces the bbox
  overlay with that member's bbox (description and bbox swap on top of the
  representative's image triple). Catches the false-positive case the
  proposal raised; full-image swap would require an extra fetch per
  member, deferred.
- **Per-member drill-down** — each member row has an "Open →" link that
  navigates to the existing `/comparisons/:id` detail page for full
  context.
- **Accept / Reject buttons** (Phase D) — Accept opens a confirm dialog
  with up to 5 sample member URLs + an optional Label / Notes textarea.
  Reject is a simpler counterpart. State drives enablement: Accept
  disabled when already accepted, Reject disabled when not yet accepted.
  An action banner reports counts after success
  ("✓ Cluster accepted — N acceptances created (M pre-existing preserved)").
- **Split cluster** is shown but disabled with a "Coming in a later phase"
  tooltip. Not in scope for A-E; would need a UI for selecting members
  + a service for splitting a signature into two, which the schema
  doesn't currently support.

### 5.3 Anomaly queue

Shipped at `/sessions/:id/anomalies` as a flat list of singleton clusters
(`pair_count = 1`), sorted by severity desc (high → medium → low → null),
then by region_role and change_type. Each row shows: severity pill +
tags (region/change/label) + the LM description + the URL + the review
state. Clicking a row navigates to the cluster detail page where Accept
/ Reject already work.

Reachable from the ClustersPage header via an "Anomaly queue →" button.

### 5.4 Keyboard model

Deferred. No cluster-scope keyboard shortcuts in this rollout. Worth
adding once UX feedback identifies the most common reviewer paths.

## 6. Decision propagation

What shipped, end-to-end:

**Cluster Accept** (Phase D, `acceptCluster` in `acceptance-rules.ts`).
Atomically:
1. Inserts `acceptance_rules(scope='cluster', signature, signature_version, label, notes, created_by)`.
2. For every `(pair, viewport)` the cluster's signature touches, INSERT
   acceptances ON CONFLICT DO NOTHING with the comparison's current
   snapshot (matched_at_level, pixel pct, ssim, **the full comparison's
   region set** — not just the cluster's bboxes), tagged with the rule's
   id. Manual acceptances at conflicting keys are preserved as-is.
3. Sets `difference_clusters.review_state = 'accepted'`.

**Cluster Reject** (`revokeClusterAcceptance`). Atomically deletes the
rule and acceptances WHERE `acceptance_rule_id` matches; sets cluster's
`review_state = 'rejected'`. Manually-created acceptances and rows from
other rules are untouched.

**Category Accept** (Phase E, `acceptCategory`). Inserts an
`acceptance_rules` row with `scope='category'` carrying
`(category_region_role, category_change_type)`, finds every cluster in
the session matching that tuple at the same `signature_version`, and
runs the per-cluster fan-out across each one. Clusters that already have
`review_state='accepted'` are **skipped and counted separately** — their
own cluster rule already covers them, no need to double-up.

**Category Revoke** (`revokeCategory`). Deletes rule-owned acceptances
and the rule. **Smart cluster-state rollback**: for each cluster the
rule had touched, count remaining rule-owned acceptances via the
signature join. If zero → flip the cluster back to `'open'`. If non-zero
(another rule still covers it) → leave it `'accepted'`. So a cluster
protected by both a cluster rule *and* a category rule survives the
category-rule revoke with its 'accepted' state intact.

**Decisions persist across runs** (`applySessionRules`). Wired into the
backfill script and the `/clusters?recompute=1` API path. Walks every
rule on the session and replays its fan-out — INSERT ON CONFLICT DO
NOTHING makes it safe to re-run. New clusters that match a rule (new
sidebar pages landed since the rule was authored) get rule-tagged
acceptances and their `review_state` flips to `'accepted'`. The
"decisions persist across runs" promise is concrete behavior, not just a
design intent.

`recomputeClusters` stays a pure structural pass — it doesn't call
`applySessionRules` internally. That separation avoids a circular module
import and keeps the structural rebuild cheap; callers that want both
(backfill, recompute API) invoke them in sequence.

## 7. Validation plan

**Experiments A and B are complete.** Findings in `experiments/findings.md`.
Below kept as a record of what was measured and what's left.

### Experiment A — does v0 cluster at all?  [done]

**Goal**: confirm that *any* signature meaningfully reduces reviewer load on a real session, before investing in v1's LM-schema work.

**Method**:
1. Pick 2 real sessions with known characteristics — one with broad nav/footer changes, one with mostly content changes.
2. Backfill `signature_v0` for every existing `differences` row.
3. Compute the *cluster size distribution*. Plot it.
4. Compute the **leverage ratio**: `1 - (cluster_count / differences_count)`. A leverage of 0.9 means a reviewer making one decision per cluster does 10× less work than per-difference.

**Pass criterion**: leverage ≥ 0.5 on the broad-changes session. **Result: passed on the LM-source slice** (top-10 LM clusters explain 57.3% of pairs; top-50 explain 99.2%). The criterion *failed* on imagick-sourced differences (0% top-K coverage at any K), which led to Finding 1 — imagick is excluded from cluster review.

**Disconfirming evidence found**: cluster #7 (83 pairs) collapsed 4 distinct changes, and the "sidebar nav added" change split across 3 separate clusters. Both became the motivating cases for v1, and both are resolved under the v1 taxonomy.

### Experiment B — does v1 separate what v0 collapsed?  [simulation done; live spot-check done; full live measurement pending]

**Simulation** (`experiment_b_v1_simulation.py`): both v0 failure modes
resolved (sidebar merge, cluster #7 split). A third failure mode
(breadcrumb verb-of-change splitting) discovered and fixed by adding the
`text_changed`-for-single-element-edits rule to the taxonomy.

**Live spot-check** (Phase C smoke-test): 5 random comparisons under the
v3 prompt, 10 differences total, 10/10 valid canonical v1 tags via the
strict json_schema path. Including the cluster-#7-style case (list
items replaced) and the breadcrumb special rule under multi-diff load.
The live LM behaviour matches the simulator's prediction.

**Still pending**: full recall/precision measurement on a curated set of
~10 known shared changes per session, after the user has re-evaluated a
session under v3. The pass criterion was recall ≥ 0.85, precision ≥
0.90. The five-comparison spot-check suggests we'll clear it, but a
formal measurement against a labelled set would be required before
trusting category bulk-accepts at scale.

### Experiment C — does the UI flow actually feel faster?  [not started]

**Goal**: validate that the cluster-first UX wins on wall-clock time *and* that reviewers trust the bulk gestures.

**Method**:
1. Two reviewers (BDB + one other), each session, A/B between current row-by-row UI and cluster UI. Same session, same target level.
2. Measure: (a) time to a complete pass; (b) post-hoc disagreement — re-review the bulk-accepted clusters one-by-one and count any the reviewer would have flagged on the row-by-row pass.

**Pass criterion**: cluster UI ≥ 3× faster, with disagreement rate < 5% of bulk-accepted rows.

**Failure mode to watch for**: reviewers blow through clusters without inspecting samples (over-trust). If disagreement spikes, add a friction step — e.g. require viewing N rotated samples before a cluster-accept of size > M.

### Out of scope for first validation

- Cross-session memory (carrying acceptance rules from session to session).
- Auto-suggested category bulk-accepts based on confidence priors.
- Active-learning sampling of cluster members.

All three are reasonable v2 directions but only worth building once we know v1 clusters are trustworthy.

## 8. Phased rollout (shipped)

All five phases landed. v1 signature ships *before* mass-accept, because
v0 alone isn't safe for bulk-accept (the cluster #7-style precision
failures Experiment A surfaced).

1. **Phase A — schema + v0 backfill + read-only API. [done, `2e18e59`]**
   `signature` / `signature_version` columns + v1 taxonomy columns on
   `differences`; `difference_clusters` and `acceptance_rules` tables;
   `cluster-signature.ts` service; `clusters.ts` materialisation;
   `GET /api/sessions/:id/clusters` and `GET .../clusters/:id`; backfill
   script. 32 new tests.
2. **Phase B — read-only cluster browsing UI. [done, `08ba524`]**
   `ClustersPage` (category index with subgroups, filter chips, sample
   diff per cluster); `ClusterDetailPage` (representative image triple +
   bbox overlay + member list); routes wired; "Cluster review" link in
   the existing session header. ~300 lines of dark-theme CSS.
3. **Phase C — v3 prompt + v1 cluster signatures by default. [done, `ce6df73`]**
   `DEFAULT_PROMPT_VERSION='v3'`; `constants/lm-prompts.ts` carries the
   taxonomy body (single source of truth); `usesV1Taxonomy` /
   `jsonSchemaForPrompt` route the JSON schema by prompt content;
   `seedLmPromptDefaults` now upserts seed-sourced rows so existing dev
   DBs auto-upgrade on next boot. Per-session upgrade procedure for
   customised prompts documented in `PHASE_C_NOTES.md`. Live LM
   smoke-test confirmed 10/10 v1 tags across 5 random comparisons.
4. **Phase D — cluster Accept / Reject. [done, `86d7b63`]**
   `acceptance_rule_id` column on `acceptances` for provenance;
   `acceptCluster` / `revokeClusterAcceptance` services with
   transactional fan-out; POST `.../clusters/:id/accept` and `.../reject`
   endpoints; functional buttons + Accept/Reject dialogs +
   "✓ accepted, N created" banner in `ClusterDetailPage`. 15 new tests.
5. **Phase E — Category bulk-accept + Anomaly queue. [done, `91ec21c`]**
   `acceptCategory` / `revokeCategory` with smart cluster-state rollback;
   `applySessionRules` for cross-run persistence (wired into backfill
   and `?recompute=1` API); POST/DELETE `.../clusters/category-accept`
   endpoints; per-subgroup bulk-accept buttons in `ClustersPage`;
   `AnomaliesPage` for the singleton long-tail. 9 new tests.

### Deferred to future phases

- **Split cluster.** UI affordance visible but disabled. Would need a
  selection UI for picking member subsets + a service that splits a
  signature in two (requires schema thought — a "parent signature"
  concept, or just retagging members manually).
- **Crop view** in cluster detail. Currently full screenshot + bbox
  overlay via `ImageWithBoxes`. Crops would reduce noise on large
  comparisons but need a separate image extraction pipeline.
- **Keyboard model** for the cluster review surface.
- **Cross-session memory.** Acceptance rules currently live within one
  session. Sharing them across sessions ("we always accept this kind of
  change in our nav rollouts") is a candidate future feature.
- **Auto-suggested category bulk-accepts** based on confidence priors.
- **Active-learning sampling** of cluster members for the friction step.

## 9. Open questions

Resolved during implementation:
- ~~Sessions with non-LM diffs~~ — imagick uses v0 fallback, isn't part of
  the cluster review unit.
- ~~Smallest cluster worth surfacing~~ — yes; singletons live in the
  Anomalies group / `/anomalies` page.
- ~~Rule revocation semantics for cluster split~~ — moot until split lands.
  Phase E's smart cluster-state rollback for category revoke shows the
  pattern (count remaining rule-owned acceptances; reopen only if zero).
- ~~Stale prompt cache on v2 → v3 cutover~~ — documented in
  `PHASE_C_NOTES.md`. First evaluation after the cutover does re-run the
  LM for every comparison that needs one; that's intended.

Still open:

- **Signature stability across re-runs.** v0 fallback uses bbox centroid
  quantised to a 10×10 grid — a small pixel jitter that moves the centroid
  across a cell boundary will flip the signature. Worth measuring once a
  v3 session has been re-evaluated twice. Not a concern for v1 (signature
  is content-based, not bbox-based).
- **Per-viewport clusters vs merged at display time.** Signatures
  currently key by viewport. A header change on both desktop and mobile
  becomes two clusters. We have no multi-viewport sessions in the dev DB
  to test against; revisit when one appears.
- **Live precision/recall measurement on a curated change set.** The
  Phase C spot-check (5 comparisons) suggests v1 clears the recall ≥
  0.85 / precision ≥ 0.90 bar, but a formal measurement on ~10 known
  shared changes per session is still pending. Worth running before
  inviting other reviewers to mass-accept on a fresh session.
- **Experiment C** (does the UI feel faster than row-by-row?). Not yet
  run. The right shape is BDB + one other reviewer A/B-ing the same
  session between the existing row-by-row UI and the cluster review,
  measuring time-to-complete-pass and post-hoc disagreement rate on
  bulk-accepted clusters.
- **`acceptance_rule_id` column adoption in existing services.** The
  manual acceptance path (`services/acceptances.ts:upsertAcceptance`)
  leaves `acceptance_rule_id` NULL, which is correct. But the existing
  ComparisonDetail page that handles per-row acceptance doesn't surface
  rule provenance ("this acceptance was created by cluster rule X").
  Adding a "this row came from a cluster decision" indicator would help
  reviewers understand why a comparison is already accepted.

## 10. What this proposal does *not* commit to

(Restated for the record — these all held through the rollout.)

- ~~No change to the equivalence pipeline, matched_at_level semantics, or
  pixel comparison logic.~~ Held — the pipeline emits the new taxonomy
  fields on `differences` rows, but the equivalence decision logic is
  untouched.
- ~~No change to the existing `acceptances` table shape.~~ One additive
  column (`acceptance_rule_id`) was added in Phase D — backwards-compatible.
- ~~Imagick differences as first-class review units.~~ Held — imagick
  rows stay in `differences` with v0 signatures, surfaced only in the
  Untagged category of the cluster index for visibility.
- ~~Cross-session learning, embeddings, or any new ML.~~ Held — every
  decision uses only the existing LM via the v3 prompt.
- ~~Mobile/tablet-specific UI work.~~ Held — cluster UI is desktop-first.

The surface stayed small. Every phase was independently shippable; we
could stop at any commit and the system would still be coherent.

## 11. What to do next

If the cluster review surface is going to be used in earnest:

1. **Run a real evaluation under v3 on the sitemap session.** Reset the
   session's prompts to defaults (per `PHASE_C_NOTES.md`), recapture or
   re-evaluate. Watch v1 clusters land in the Header & Navigation /
   Main content / Footer categories instead of the v0 "Untagged" bucket.
2. **Use the system to triage one real session.** Time it; note the
   gestures that felt missing. That's the input for Experiment C and for
   prioritising Split / keyboard / crop-view.
3. **If precision feels right, open a PR** against
   `plan-improved-visual-compare` to merge the branch back. The
   commits are scoped and reviewable individually.

If concerns surface during real use, the proposal's safety hooks are
still in place:
- v0 fallback signatures keep the Untagged category functional even when
  v3 prompt edits drift.
- Manual acceptances at any (pair, viewport) key always win over cluster
  rules.
- Category and cluster revoke are non-destructive of manual data;
  reviewers can roll back any rule without losing per-row work.
