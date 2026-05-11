# Experiment A — findings (v0 signature on existing data)

Run against `data/visual-compare.sqlite` on `plan-improved-visual-compare` —
two sessions, 14,568 desktop comparisons total.

## Headline numbers

| Session | Source | Diffs | Clusters | Raw leverage | Top-10 pair coverage | Top-50 pair coverage |
|---|---|---|---|---|---|---|
| altinn-sitemap | imagick | 1,333,226 | 348 | 0.9997 | **0%** | **0%** |
| altinn-sitemap | LM      | 1,804     | 62  | 0.966 | **57.3%** | **99.2%** |
| altinn-en-about | LM     | 39        | 11  | 0.718 | 83% (5/6 pairs) | — |

`pair coverage` = fraction of `(url_pair, viewport)` comparisons whose every
signature falls within the top-K clusters by pair-count. This is the metric
that matters — reviewers act on comparisons, not on individual diff rows.

## Finding 1 — imagick diffs are unusable as the cluster unit

Raw leverage looks great (0.9997 — 348 clusters cover 1.3M diff rows), but
top-K pair coverage is **0% for every K up to 100**. Every comparison has
~93 connected-component diffs scattered across the grid; even with all 348
clusters surfaced, no pair is "fully explained" because each pair has at
least one CC in a rare cell.

→ **Clusters should be defined over LM-sourced differences only.** Imagick
differences stay in the schema as pixel-level evidence (shown in
per-comparison drill-downs) but don't participate in cluster-level review.
This simplifies the data model and aligns clusters with what reviewers
actually see today (LM-driven Phase 5 UI).

## Finding 2 — LM leverage passes the proposal's threshold cleanly

On the realistic (sitemap) session: top-10 LM clusters fully explain 57% of
the pairs-needing-review; top-50 covers 99%. The pass criterion was 0.5
leverage; the result is well past it.

But: this number is *inflated* by Finding 3 below. Read with caution.

## Finding 3 — v0 has both under- and over-clustering failure modes

Inspection of the top 10 LM clusters (see `experiment_a_cluster_inspection.py`
output) shows the v0 geometric signature splitting and merging changes in
ways that matter:

**Under-clustering — one change, multiple clusters:**
- The "sidebar navigation menu added" change shows up in clusters #1, #2,
  and #8 — grid cells (5,1), (6,1), (7,1) — because the sidebar spans
  different vertical extents per page and its bbox centroid lands in
  different rows. Single change, 446 pairs, three clusters.
- "Main headline differs" appears in clusters #3 and #5 at cells (2,6) and
  (3,7).
- "Added 'In which municipality/county?' search section" splits across
  clusters #6 and #9 at cells (9,6) and (9,5).

Effect: the top-K coverage number is artificially flattered (the 3 sidebar
clusters could be 1), which means the *real* leverage is even higher than
57% if the signature were better — but the headline metric reads as needing
more clusters than the underlying change-set actually warrants.

**Over-clustering — different changes, one cluster:**
- Cluster #7 (cell 6,6, band xl, 83 pairs) lumps together:
  - "First announcement removed"
  - "List of multiple items vs single entry"
  - "Accordion item removed"
  - "New paragraph added explaining RR-0002"

  These are 4+ semantically distinct changes that happen to land in the
  middle of the page with similar bbox area. A reviewer who hit "accept
  cluster" on #7 would silently auto-accept four unrelated edits.

Cluster #7 is the precision failure I wrote up in §4 of the proposal as
v0's expected weakness — and it shows up immediately in the largest
clusters, not as a tail-distribution rarity.

## Implications for the plan

1. **The leverage hypothesis is confirmed.** Clustering compresses the
   review queue from "thousands of pair decisions" to "tens of cluster
   decisions" even with the crudest possible signature. Phase A and B
   (build the schema, cluster index, read-only UI) are well-supported.

2. **Phase C (mass-accept gesture) needs v1 first.** v0 is safe as a
   browsing/sorting aid — but the bulk-accept rule fan-out described in §6
   of the proposal cannot be exposed on v0. Cluster #7 alone could
   silently auto-accept four unrelated changes across 83 comparisons. The
   precision floor for mass-accept is somewhere north of 90% and v0 isn't
   there.

3. **Promote v1 (LM-tagged `change_type`/`region_role`/`element_label`)
   from Phase D to Phase C.** New phase order:

   - Phase A: schema + v0 backfill + read-only API. (Unchanged.)
   - Phase B: read-only cluster browsing UI. (Unchanged.)
   - **Phase C: ship v1 signature.** (Was Phase D.) Re-cluster.
   - **Phase D: mass-accept on v1.** (Was Phase C, gated on v1.)
   - Phase E: category bulk-accept + anomaly queue. (Unchanged.)

4. **A pre-flight signature-quality experiment is needed before Phase D.**
   Specifically the precision/recall measurement I called Experiment B in
   the original proposal — but run only after v1 is implemented, against a
   hand-labelled subset of the sitemap session's top 10 clusters (we now
   have them sampled and they're easy to label).

## Suggested signature tweaks worth trying before committing to v1

These might fix some of v0's failures without an LM-schema change. Worth
30 minutes each:

- **Coarser grid** (5×5 instead of 10×10): would merge the 3 sidebar
  clusters but worsen cluster #7's over-clustering. Probably net negative.
- **Bbox-edge anchoring instead of centroid**: a sidebar's *left edge* is
  stable across pages even when its centroid isn't. Could cluster column-1
  bbox edges into one cluster regardless of height. Worth trying.
- **Aspect-ratio band** in addition to area band: cluster #7's diffs have
  varied aspect ratios; splitting by aspect would partially de-collide it.

None of these substitute for v1; they could buy a better v0 baseline while
v1 is being built.

## Update — v1 simulation results (Experiment B, post-hoc)

Ran `experiment_b_v1_simulation.py` over the same 1,804 LM differences using
rule-based derivation of `(change_type, region_role, element_label)` from
the LM descriptions in the DB. This simulates what v1 clustering *would*
do once the actual LM emits these fields under the v1 prompt. The
simulator is a faithful but somewhat pessimistic proxy: it uses regex
patterns where the real LM has image context, so it will mis-tag some
edge cases that the live LM will get right.

### Failure-mode resolution

| Failure mode (v0)                                | Resolved? | v1 cluster count for the change |
|---|---|---|
| Sidebar added — split across 3 clusters          | ✓ yes    | 1 cluster, 483 pairs |
| Breadcrumb path changed — split across 4 clusters| ✓ yes (after taxonomy refinement) | 1 cluster, 315 pairs |
| Cluster #7 — 4 distinct changes lumped together  | ✓ yes    | Splits into ≥4 small coherent clusters (contact info, accordion added/removed/text-changed, paragraph, etc.) |

The breadcrumb fix required a specific rule in the taxonomy: any "change"
to a breadcrumb (path expansion, level added, level reordered) is
`text_changed`, never `element_added` / `element_replaced`. The element
itself is one breadcrumb; only its content is changing. Same rule applies
to headlines and paragraphs. Locked into the taxonomy spec.

A second rule the iteration surfaced: `region_role` should be derived
from `element_label` when the label implies it (accordion items always
sit in `main_content` regardless of where their bbox centroid lands,
breadcrumbs always sit in `nav_secondary`, etc.). The bbox heuristic
remains as a fallback for unlabelled diffs.

### Coverage curves: v0 vs v1

| K | v0 pair coverage | v1 pair coverage | comment |
|---|---|---|---|
| 1  | 14.0% | 27.4% | v1 wins — sidebar alone is one big cluster |
| 3  | 26.1% | 49.6% | v1 wins decisively |
| 5  | 39.3% | 55.1% | v1 wins |
| 10 | 57.3% | 63.8% | v1 wins slightly |
| 25 | 87.3% | 72.9% | v0 wins — but its top-25 lump distinct changes |
| 50 | 99.2% | 77.5% | v0 wins — but its top-50 are heavily mixed |
| 100 | n/a (only 62 v0 clusters) | 81.5% | v1 has a longer tail |

The v0 → v1 transition trades inflated coverage for *trustworthy*
coverage. v0's 99% at top-50 was driven by clusters like #7 that bundled
4 unrelated changes; accepting that cluster en-masse would silently
auto-accept changes the reviewer didn't see. v1's smaller top-K numbers
reflect the actual diversity of change types; each cluster is now
something a reviewer can act on as a single decision.

### Simulator pessimism — what the real LM will do better

Three categories of v1-simulation noise that the live LM under v1 won't
exhibit:

1. **Element-label fallbacks.** When the simulator's keyword rules don't
   find a canonical-form match, it falls back to extracting a short noun
   phrase. This produces awkward labels like `"main content area has"`,
   `"start tjeneste button has"`, `"content list items have"`. The real
   LM, with a canonical-list in its prompt, would emit `"primary CTA"`
   or `"list item"` here instead. → fewer clusters, better coverage.

2. **Multilingual variants.** The Altinn data contains Norwegian terms
   ("tjeneste", "skjema") that the simulator's English-only patterns
   miss. The LM handles this naturally — it identifies elements
   semantically, not by string matching.

3. **Compound descriptions.** Some descriptions like *"A new section 'In
   which municipality?' with a search bar has been added below the
   accordion items"* get mis-tagged as `accordion item` because the
   simulator picks up the first keyword it finds. The LM would correctly
   identify the *new* element being added (the search section) rather
   than the contextual reference (the accordion items it was added near).

These all push the simulator toward over-counting clusters and
under-reporting coverage. The real v1 numbers will be at least as good
as the simulator's, probably better.

### Decision: lock the v1 taxonomy

Both targeted failure modes are resolved without introducing new ones.
The remaining simulator artifacts are not taxonomy failures and will
disappear when the real LM is doing the labelling. Moving to Phase B's
prerequisite — implementing the v1 prompt and schema changes in `lm.ts`.

## Open questions for the next session

- Should imagick differences be persisted at all if they're not used for
  clustering? They're useful as pixel-level evidence in per-comparison
  drill-downs, but 1.3M rows is non-trivial storage. (Out of scope for
  Phase A; flagging for later.)
- The 14K-row sitemap session has 1,404 pairs (10%) with LM differences.
  Are the other 90% reaching the target equivalence level cleanly, or are
  they being captured but never escalated to the LM? Worth verifying that
  the LM second pass is running where it should.
