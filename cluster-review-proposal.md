# Cluster-driven Review: Data Model, UI Flow, and Validation Plan

Status: proposal v0.2 — taxonomy validated, ready for Phase A implementation.
Branch: `cluster-review-design` (worktree at `cluster-review-design/`).
Reviewer: BDB.

Companion documents in this worktree:
- `experiments/findings.md` — Experiment A + B results (v0 measurement, v1 simulation)
- `experiments/v1-taxonomy.md` — locked-in spec for the cluster-signature taxonomy
- `experiments/experiment_a_v0_leverage.py`, `experiment_a_cluster_inspection.py`, `experiment_b_v1_simulation.py` — reproducible measurement scripts
- `packages/api/src/services/lm.ts` — ready-to-merge prompt + schema changes for v3 (held behind `DEFAULT_PROMPT_VERSION='v2'` until Phase C cutover)

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

**Code path.** `packages/api/src/services/lm.ts` on this branch has the full v3 prompt, the extended zod schema (optional v1 fields for back-compat with v2 cached responses), a strict `LM_JSON_SCHEMA_V3` sent to LM Studio, and a `jsonSchemaForPromptVersion(version)` helper that routes by prompt-version label. `DEFAULT_PROMPT_VERSION` stays at `'v2'`; Phase C is the cutover.

### v2 — semantic backstop (not planned)

If v1's canonical-label scheme proves too brittle in practice, a fallback would re-embed `description` text and cluster by cosine similarity. The DB column `signature_version` is designed to admit a `'v2'` value coexisting with v1 if we ever need it. Not on the roadmap.

## 5. UI flow

Three top-level views, replacing the current single results list as the primary triage surface (the list view stays available as an "advanced" tab).

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

The category-level "Accept all" is a one-click affordance backed by an `acceptance_rules` row with `scope='category'`. It's intentionally a separate gesture from cluster-level accept; we expect it to be used sparingly (and offer a confirm step that shows the 1-2 sample diffs that would be auto-accepted).

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

Key affordances:
- **Crop view**, not full screenshot. Show only the cluster's bbox region from A, B, and diff. The point of clustering is to surface the *same change shown once*; full screenshots reintroduce noise.
- **Sample rotation** — clicking a different member swaps the crops. This catches false positives in the cluster (a row whose change *isn't* actually the footer-year edit) without forcing the reviewer to open each one.
- **Split cluster** is the escape hatch: select a subset of members and pull them out into a new cluster (re-tagged manually, or sent to anomaly queue).
- **Per-member override** — clicking a member opens the existing per-row ComparisonDetail in a side panel; the existing per-row Accept stays available as a fallback.

### 5.3 Anomaly queue

Default-sorted by descending pair-area or severity. This is where most of the actual reviewer attention should end up *after* the bulk pass is done. UI is closer to the existing one-row-at-a-time review.

### 5.4 Keyboard model

Cluster view inherits the current bindings (`a` accept, `r` reject) but rebound to cluster scope. Member-level shortcuts (`m`+`a`, `m`+`r`) for overrides. Worth pinning the cheatsheet visibly given the dual-scope ambiguity.

## 6. Decision propagation

A cluster-level `accept` does the following, atomically:
1. Inserts `acceptance_rules(scope='cluster', signature, signature_version)`.
2. For each `differences` row with this signature, look up its `comparison_id`, then ensure an `acceptances` row exists for that `(session, url_pair, viewport)` with the cluster's metadata snapshotted in (label, notes, current pixel pct, current regions). Existing per-row acceptances are *preserved* (not overwritten) — they may have stricter notes the reviewer added by hand.
3. Sets `difference_clusters.review_state = 'accepted'`.

A cluster-level `reject` does the reverse for any acceptances created by *this rule* (we track rule_id on the inserted acceptances; manually-created acceptances are left alone), and sets `review_state = 'rejected'`. Rejected clusters stay visible in their category so the reviewer can drill into specific members.

On the next evaluation run:
- New `differences` rows get signed at write time.
- For each new signature, if an `acceptance_rules` row exists, the rule fan-out runs again for the newly-added members. This is what "decisions persist across runs" means concretely.

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

### Experiment B — does v1 separate what v0 collapsed?  [done (simulation), live test deferred to Phase C]

**Done so far**: post-hoc simulation in `experiment_b_v1_simulation.py`. Existing LM `description` text was mapped to v1 tags via a rule-based classifier faithful to the taxonomy spec, then re-clustered.

- Both v0 failure modes resolved (sidebar merge, cluster #7 split).
- A third failure mode discovered and fixed mid-iteration: breadcrumb changes were splitting by verb-of-change. The `text_changed`-for-single-element-edits rule was added to the taxonomy.

**Pass criterion (simulation)**: both v0 failure modes resolved without introducing new ones. **Met.** Top clusters under v1 are semantically coherent on inspection.

**Live test deferred to Phase C**: the real validation happens once the v3 prompt is live and the actual LM is emitting tags from images, not the simulator working off existing descriptions. At that point, measure:
- **Recall** on a curated set of ~10 known shared changes per session.
- **Precision** by sampling the top 10 v1 clusters and counting members that don't belong.

**Pass criterion (live)**: recall ≥ 0.85, precision ≥ 0.90. Below precision 0.90 we hold mass-accept (Phase D) behind another iteration.

### Experiment C — does the UI flow actually feel faster?  [not started — Phase B and B-end]

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

## 8. Phased rollout

Phase order revised after Experiment A: v1 signature ships **before** any
mass-accept gesture, because v0 alone isn't safe for bulk-accept (cluster
#7-style precision failures). Read-only browsing on v0 is fine; the
dangerous operation is the fan-out.

1. **Phase A — schema + v0 backfill + read-only API.** Add `signature`/`signature_version` columns to `differences`, add `difference_clusters` table, add `acceptance_rules` table (empty for now), add a `/sessions/:id/clusters` API that returns clusters for inspection. Backfill v0 signatures on existing LM-sourced differences. (~1-2 days.)
2. **Phase B — read-only cluster browsing UI.** Category index + cluster detail views, no acceptance affordances yet. Reviewers can browse; cluster #7-style false equivalences are visible but harmless (no mass action available). Gives us Experiment C's "time to triage" baseline. (~3-5 days.)
3. **Phase C — ship v1 signature.** Flip `DEFAULT_PROMPT_VERSION` from `'v2'` to `'v3'` (the `lm.ts` patch on this branch is already prepared and tested). Run the LM second pass on a representative subset; re-cluster under v1; measure recall/precision on curated known-shared changes. If pass criteria hold, recluster the whole session under `signature_version='v1'` and surface v1 clusters in the UI instead of v0. (~2-3 days.)
4. **Phase D — mass-accept on v1.** Wire up the cluster-accept/reject buttons, the `acceptance_rules` row creation, and the fan-out into `acceptances`. Add the "show me N sample members" friction step before any large-cluster bulk-accept. (~2-3 days.)
5. **Phase E — Category bulk-accept + anomaly queue.** Only after v1 mass-accept is trusted in practice. (~1-2 days.)

## 9. Open questions

Resolved (formerly here):
- ~~"Sessions with non-LM diffs"~~ — decided: imagick uses v0 fallback, isn't part of cluster review unit.
- ~~"Smallest cluster worth surfacing"~~ — decided: yes, surface singletons; uniform UI.

Still open:

- **Signature stability across re-runs.** For the v0 fallback path, if a tiny pixel jitter shifts a bbox into a different grid cell, the signature flips. Less of a concern for v1 (signature isn't centroid-based) but worth measuring once Phase C is live.
- **Per-viewport clusters vs merged at display time.** Current design keys signatures by viewport. A header change on both desktop and mobile becomes two clusters. Pro: avoids cross-viewport accept-leak. Con: doubles reviewer count for changes that legitimately span viewports. Lean toward collapsing at *display* time (group by `(region_role, change_type, element_label)` and show viewport facets inline) without changing the signature.
- **Rule revocation semantics.** If a reviewer accepts cluster X, then later splits cluster X into X1+X2, do X1's pre-existing acceptances survive? Proposed: yes, the rule is re-tagged to X1 (the "majority" half); X2's members get their acceptances revoked. Confirm before Phase D.
- **Live precision/recall measurement.** The simulation in Experiment B is a proxy. Phase C needs the live measurement on a curated change-set before Phase D's mass-accept gesture is wired up. Curated set TBD; recommend ~10 known shared changes per session, hand-picked by skimming the v0 top-10 clusters.
- **Stale prompt-cache invalidation on the v2 → v3 cutover.** When `DEFAULT_PROMPT_VERSION` flips to `'v3'`, all previously-cached LM verdicts will miss the cache (cache key includes prompt_id, which is the hash of the system prompt text). That's intended — but means the first run after the cutover is a full LM re-evaluation. Worth callling out so it isn't a surprise.

## 10. What this proposal does *not* commit to

- Any change to the equivalence pipeline, matched_at_level semantics, or pixel comparison logic.
- Any change to the existing `acceptances` table shape — it stays the per-row source of truth.
- Clustering imagick-sourced differences as first-class review units. They stay in the schema as pixel-level evidence in per-comparison drill-downs.
- Cross-session learning, embeddings, or any ML beyond the LM that's already in the pipeline.
- Mobile/tablet-specific UI work; cluster UI is desktop-first.

If we keep that surface area small, every phase above is a contained, reversible change.
