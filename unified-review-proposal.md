# Unified Review Surface — Scope

Status: scope, not yet committed to.
Branch: `unified-review-surface` (worktree at `unified-review-surface/`).
Reviewer: BDB.

This document scopes Option B from the harmonization conversation:
collapse the existing row-by-row review and the new cluster/anomaly
pages into a single review surface with mode tabs and a shared filter
taxonomy. No backend changes; the work is React + routing.

Companion code (read-only references):
- `packages/web/src/pages/SessionDetailPage.tsx` — current home of the
  row-by-row review (the page that wraps `SessionResultsList` and
  `ComparisonDetail`)
- `packages/web/src/pages/ClustersPage.tsx` — category index + bulk-accept
- `packages/web/src/pages/AnomaliesPage.tsx` — singleton long-tail
- `packages/web/src/pages/ClusterDetailPage.tsx` — focused cluster
- `packages/web/src/components/SessionResultsList.tsx` — row list + filter chips
- `packages/web/src/components/ComparisonDetail.tsx` — focused comparison

## 1. Problem

Today the reviewer has two parallel surfaces:

- `/sessions/:id` — row-by-row, with filter chips ("Needs review",
  "Accepted", level buckets, missing-page outcomes) and a focused
  `ComparisonDetail` pane.
- `/sessions/:id/clusters` and `/sessions/:id/anomalies` — cluster-driven
  triage, with its own review_state filter and a different visual
  shape (category groups, cluster cards, bulk-accept dialogs).

The two surfaces don't conflict, but they cohabit without a connecting
story:

1. **Rule provenance is invisible row-side.** A row accepted via cluster
   fan-out looks identical to one accepted manually. The reviewer can't
   tell why a row is already accepted.
2. **No funnel from bulk → residuals.** Reviewer cluster-accepts the
   broad patterns, then is left to find their way back to the row-by-row
   surface and figure out what's "left over". Nothing guides the handoff.
3. **Two filter vocabularies.** Cluster review uses `review_state`
   (open / accepted / rejected / split / anomaly); row review uses
   `needs_review` / `accepted` / `regressed` / `expanded` / missing /
   levels. Reviewer learns two taxonomies on two pages.
4. **Anomalies are their own page.** Singletons need per-row review and
   would benefit from the row review's affordances (`ComparisonDetail`
   side panel, accept dialog with full per-row knobs), but they live in
   a separate flat list right now.

## 2. Core hypothesis

**One review surface with mode tabs reduces the cognitive load of
switching contexts and unifies the gestures (accept, reject, filter,
focus) across triage shapes.**

Operationally: a reviewer should be able to start a session at one URL,
work top-down (high-pair-count clusters → smaller clusters → anomalies
→ residual rows), and never feel like they "left" the review page.

Counter-argument: the cluster and row modes do reflect genuinely
different mental models — one is "what kind of change happened
session-wide", the other is "did this specific pair pass". Conflating
them might smear two distinct workflows. We'll validate against that
risk (§7).

## 3. Concrete UX shape

### 3.1 Layout

Single page at `/sessions/:id/review` (or `/sessions/:id` for back-compat
— TBD in §9). Same outer chrome as today's `SessionDetailPage`:

```
┌────────────────────────────────────────────────────────────────────────┐
│ visual-compare / Sessions / <session name>           [Recapture] [LM] │
├────────────────────────────────────────────────────────────────────────┤
│ 312 diffs across 47 pairs · last evaluated 12m ago · [Plan & Evaluate]│
├────────────────────────────────────────────────────────────────────────┤
│ ┌─ Mode ──────────────────────────────┐                                │
│ │ [ Clusters ] [ Rows ] [ Anomalies ] │   Shared filter chips →        │
│ └──────────────────────────────────────┘                                │
│ [ Needs review ] [ Accepted ] [ Regressed ] [ Expanded ] …             │
├──────────────────┬─────────────────────────────────────────────────────┤
│                  │                                                     │
│  list / index    │              detail pane                            │
│  (changes by     │            (focused item)                           │
│   mode)          │                                                     │
│                  │                                                     │
└──────────────────┴─────────────────────────────────────────────────────┘
```

Three structural pieces are shared across modes:

- **Mode tabs** (`Clusters` / `Rows` / `Anomalies`) — large, persistent.
- **Filter chip strip** — shared status filters with mode-aware extras
  (level buckets in Rows mode; region/change-type facets in Clusters
  mode). The user's selection persists across mode switches when the
  filter is applicable to both.
- **Detail pane** — right-side panel that displays whichever item is
  focused, regardless of mode. Closes / opens via the same toggle.

### 3.2 Per-tab body

**Clusters tab.** Today's `ClustersPage` content — category groups
(Header & Navigation, Main content, …) with per-subgroup bulk-accept
buttons, cluster rows sorted by pair_count desc within each category.
Focusing a cluster shows it in the detail pane.

**Rows tab.** Today's `SessionResultsList` — virtualised row list with
verdict glyph, URL, viewport, ssim/metrics. Focusing a row shows
`ComparisonDetail` in the detail pane. New: a small badge on each row
noting rule provenance ("via cluster rule" / "via category rule") when
the acceptance was created by a fan-out.

**Anomalies tab.** Hybrid — visually a row list (one anomaly per row,
like the Rows tab) but content-wise the singleton clusters. The
underlying record is still a cluster, but in this tab the focused item
opens into a row-style detail (`ComparisonDetail`) rather than the
cluster-style one, because singletons map 1:1 to a single comparison.
Best of both worlds for the long-tail review.

### 3.3 Detail pane

The right pane adapts to focused item type, but its outer chrome is
constant. Three variants:

- **Comparison detail** — for Rows mode and Anomalies mode. The
  existing `ComparisonDetail` component, gaining a small "Cluster: X"
  pill above the actions (clickable; switches mode to Clusters and
  focuses the cluster).
- **Cluster detail** — for Clusters mode. Today's `ClusterDetailPage`
  content as a panel rather than a separate route: representative
  image triple, members list with focus/drill-down buttons, Accept /
  Reject / Split actions. The members list's "Open →" still navigates
  to the row's comparison.
- **Empty state** — no selection. Shows a hint about keyboard
  shortcuts and the recommended workflow ("start with Clusters tab,
  bulk-accept the broad patterns, then drop to Rows for residuals").

### 3.4 Filter strip — shared taxonomy

Filters are the most consequential shared concept. The strip has three
zones, left to right, with consistent visual treatment:

```
[ Status: all needs-review accepted regressed expanded ]    ← shared
[ Level: pp strict tolerant loose none pending missing ]    ← Rows + Anomalies only
[ Region: hdr nav main hero aside ftr ovrly alert other ]   ← Clusters only
[ Change: added removed replaced text-changed translated ⋯] ← Clusters only
[ Outcome: present a-missing b-missing both-missing ]       ← Rows + Anomalies only
```

#### Shared status chips (zone 1, always visible)

Single-select. Maps to a shared `status` URL param. Each mode interprets
the same status against its own underlying record.

| Status | Rows | Clusters | Anomalies |
|---|---|---|---|
| `all` | every row | every cluster | every singleton cluster |
| `needs_review` (default) | `r.status === 'pending'` OR `matched_at_level` weaker than target OR `acceptance_status` ∈ {`regressed`, `expanded_diff`} | `review_state === 'open'` | `review_state === 'open'` |
| `accepted` | `acceptance_status === 'accepted'` | `review_state === 'accepted'` | `review_state === 'accepted'` |
| `rejected` | n/a — chip is **disabled with tooltip** ("Rejected is a cluster concept; switch to Clusters mode") | `review_state === 'rejected'` | `review_state === 'rejected'` |
| `regressed` | `acceptance_status === 'regressed'` | n/a — disabled | passes through to the underlying singleton row |
| `expanded` | `acceptance_status === 'expanded_diff'` | n/a — disabled | passes through |

Disabled-with-tooltip is the right behavior (over hiding) — the chip
position stays stable across mode switches, and the reviewer learns
the cross-mode shape of each status.

#### Level facets (zone 2, Rows + Anomalies modes)

Multi-select. Maps to `level=<csv>` URL param. Each chip surfaces a
count drawn from the response's `summary.by_level` histogram.

| Chip | Filter |
|---|---|
| `pp` | `matched_at_level === 'pixel-perfect'` |
| `strict` | `matched_at_level === 'strict'` |
| `tolerant` | `matched_at_level === 'tolerant'` |
| `loose` | `matched_at_level === 'loose'` |
| `none` | `matched_at_level === 'none'` |
| `pending` | `status === 'pending'` (no verdict yet) |
| `missing` | `pair_outcome !== 'both_present'` |

In Anomalies mode, the chips filter by the underlying comparison's
level. (Cluster `change_type` is shown as text inside each row.)

Hidden in Clusters mode (cluster signature has no `matched_at_level`).

#### Region & change-type facets (zone 3, Clusters mode only)

Multi-select. Maps to `region=<csv>` and `change=<csv>` URL params.
Chips surface the cluster count per facet value (drawn from
`difference_clusters` rows for the session).

Region values: `header`, `nav_primary`, `nav_secondary`, `hero`,
`main_content`, `aside`, `footer`, `overlay`, `alert_banner`, `other`.

Change values: the 10 entries from `CHANGE_TYPES` in
`services/lm.ts` (`element_added`, `element_removed`,
`element_replaced`, `text_changed`, `text_translated`, `image_changed`,
`style_changed`, `count_changed`, `state_changed`, `other`).

The current category grouping in `ClustersPage` (Header & Navigation,
Main content, …) becomes one possible *grouping* of the cluster list,
toggled separately — not a filter. Reviewer can group by category or
flat-list by pair_count.

Hidden in Rows and Anomalies modes (rows don't carry these tags
directly; their cluster does, but you'd filter on the cluster, not the
row).

#### Outcome facet (zone 4, Rows + Anomalies modes)

Single-select. Maps to `outcome=<value>` URL param. Surfaces the
`pair_outcome` of the underlying comparison.

| Chip | Filter |
|---|---|
| `present` (default) | `pair_outcome === 'both_present'` |
| `a-missing` | `pair_outcome === 'a_missing'` |
| `b-missing` | `pair_outcome === 'b_missing'` |
| `both-missing` | `pair_outcome === 'both_missing'` |

Distinct from the level facet because missing-page rows are a
qualitatively different review case (no diff to look at) and reviewers
often want to sweep them as a batch.

Hidden in Clusters mode.

#### State persistence

All filter params live in the URL query string, so:
- Shareable: paste a URL, land in the same filter state.
- Back/forward: browser navigation moves between filter states.
- Mode-switch: applicable params persist; inapplicable ones are
  preserved in the URL but not applied. Switching back re-engages
  them. Example: `?status=accepted&level=tolerant` set in Rows mode
  → switching to Clusters mode keeps `status=accepted` active and
  preserves `level=tolerant` in the URL (no-op while in Clusters).

#### Defaults

Landing at `/sessions/:id` with no query string defaults to:
`?status=needs_review&outcome=present` (current `SessionResultsList`
behaviour). Default mode is **Clusters** (recommended start of the
funnel).

### 3.5 Actions menu

A single, stable affordance: an **Actions** dropdown in the top-right
of the detail pane, available regardless of mode. The button label
stays `Actions ▾` so the muscle memory is one click + one selection,
not a hunt for context-specific buttons scattered across the UI.

The menu's contents are computed per focused item — the focused item
knows its type (row, cluster, anomaly) and the menu lists what's
applicable. Items that don't apply aren't hidden — they're disabled
with a one-line reason, same UX principle as the disabled filter chips
(§3.4): predictable layout, learnable cross-mode shape.

#### Menu contents per focused-item type

**Focused row** (Rows mode, or Anomalies mode after drill-in):

| Action | Effect | Disabled when |
|---|---|---|
| Accept (with dialog) | Opens the per-row accept dialog (current behaviour). | row has no `matched_at_level` yet |
| Quick accept | Reuses last-used label, no dialog. | same as above |
| Clear acceptance | Deletes the per-row acceptance. | no acceptance exists |
| —————————— | | |
| Accept this cluster | Opens the **cluster** accept dialog for the row's cluster. The row's `cluster_id` from the DTO (§5.2) drives this. | row has no cluster (e.g. imagick-only row with no v1 tags) |
| Show this row's cluster | Switches to Clusters mode and focuses the cluster. | same as above |
| —————————— | | |
| Open in new tab | Opens `/comparisons/:id` as a standalone permalink. | — |

**Focused cluster** (Clusters mode):

| Action | Effect | Disabled when |
|---|---|---|
| Accept cluster | Opens the cluster accept dialog (current behaviour). | `review_state === 'accepted'` |
| Reject cluster | Opens the cluster reject dialog. | `review_state !== 'accepted'` |
| Split cluster | (Deferred — disabled with the "Coming in a later phase" tooltip the cluster detail page already shows.) | always, for now |
| —————————— | | |
| Show members in Rows | Switches to Rows mode, applies a filter limiting to that cluster's `(url_pair_id, viewport)` pairs. URL: `?mode=rows&cluster=<id>` — Rows mode reads it and filters in-memory. | cluster has no members |
| Accept entire category | Opens the category bulk-accept dialog for this cluster's `(region_role, change_type)`. | cluster has no region_role or no change_type, or category rule already exists |
| —————————— | | |
| Open in new tab | Opens `/sessions/:id/clusters/:cluster_id` as a permalink. | — |

**Focused anomaly** (Anomalies mode):

Same as the focused-row menu — singletons map 1:1 to a single
comparison, so the per-row actions apply directly. The "Accept this
cluster" item is effectively the same as "Accept (with dialog)" for a
singleton, so it's collapsed: only the per-row actions show, plus
"Show in Clusters" for jumping to the singleton's cluster card view.

#### Keyboard parity

Each action gets a single-letter shortcut surfaced in the menu (e.g.
`Accept (with dialog) — A`). The menu is a discoverability surface;
keys are the fast path. Shortcuts are unchanged from §3.6.

#### Why a menu over inline buttons

- One affordance to learn, regardless of focused-item type.
- Layout doesn't shift as the item type changes — buttons appearing
  and disappearing in toolbar slots is the worst kind of visual jitter.
- Easy to extend in later phases (split cluster, "lock this cluster
  signature", "mark for follow-up") without re-organising the toolbar.
- Disabled-with-reason items teach the cross-mode model: a reviewer
  who tries to "Accept this cluster" on a row that has none learns
  *why* there's no cluster, which deepens their mental model of how
  cluster review interacts with row review.

### 3.6 Keyboard model

Current row review has: `a` accept dialog, `A` quick-accept, `r` clear.
Unified surface adds:

- `1` / `2` / `3` — switch to Clusters / Rows / Anomalies tab.
- Existing `a` / `A` / `r` work in Rows and Anomalies modes (target the
  focused row).
- `a` in Clusters mode opens the cluster accept dialog; `A` does
  quick-accept with the cluster's element_label as the default label;
  `r` opens cluster reject.
- `c` from Rows mode jumps to that row's cluster (cross-mode).

Cheat-sheet visible from the empty state.

## 4. Data model implications

**None.** The unified surface is a UI rearrangement over the existing
API. No new tables, no new columns, no migrations.

The backend already supports everything we need:
- `GET /api/sessions/:id/results` returns rows with `acceptance_status`.
- `GET /api/sessions/:id/clusters` returns clusters with state.
- `acceptance_rule_id` on `acceptances` is the rule-provenance signal
  the Rows mode needs to render the "via cluster" badge. The DTO that
  Rows mode consumes (`SessionResultRow`) doesn't expose it today —
  needs a small additive change (§5.2).

## 5. What changes, what stays

### 5.1 Pages

- `SessionDetailPage` becomes the unified surface (or a new
  `ReviewPage` replaces it; URL design decided in §9). It hosts the
  mode tabs and routes to the per-mode body.
- `ClustersPage` content extracted into a `ClustersTab` component
  reused by the unified page. The standalone route can stay as a
  deep-link target or be retired.
- `AnomaliesPage` content extracted into an `AnomaliesTab` component.
- `ClusterDetailPage` content extracted into a `ClusterDetailPanel`
  component for the detail pane. The standalone route can stay for
  permalinks or be retired.
- `SessionResultsList` and `ComparisonDetail` stay essentially as-is,
  rendered inside the Rows tab and the detail pane respectively.

### 5.2 API surface additions

Minimal — one extension:

- `SessionResultRow` DTO gains an optional `acceptance_rule_id: string |
  null` field so the Rows tab can render the "via cluster rule" badge.
  Already in the DB row, just not in the DTO today.

Maybe also:
- Cluster summary in `SessionResultRow`: `cluster_id: string | null`,
  `cluster_review_state: ClusterReviewState | null`, so the
  "Show cluster" action knows where to jump without an extra fetch.

These are additive and backwards compatible. No new endpoints.

### 5.3 URL design

**Decision: option C.** `/sessions/:id` is the canonical unified
surface. Existing routes redirect into it:

| Old URL | New behavior |
|---|---|
| `/sessions/:id` | The unified surface (default mode: Clusters). |
| `/sessions/:id/clusters` | Redirects to `/sessions/:id?mode=clusters` with the user's last-used filter state replayed. |
| `/sessions/:id/clusters/:cluster_id` | Redirects to `/sessions/:id?mode=clusters&focus=<cluster_id>`. The cluster opens in the detail pane. |
| `/sessions/:id/anomalies` | Redirects to `/sessions/:id?mode=anomalies`. |
| `/comparisons/:id` | Unchanged. Stays as a standalone permalink route for sharing a single comparison without a session context. (Already supported by the API; reviewers paste these into bug reports.) |

Query params drive the unified surface's state, all optional:
- `mode` — `clusters` (default) / `rows` / `anomalies`
- `status` — `all` / `needs_review` (default) / `accepted` / `rejected` / `regressed` / `expanded`
- `level` — comma-separated subset (Rows + Anomalies only)
- `region`, `change` — comma-separated subset (Clusters only)
- `outcome` — `present` (default) / `a-missing` / `b-missing` / `both-missing` (Rows + Anomalies only)
- `focus` — the id of the currently-focused item (row's `pair_key` or cluster's id)
- `group` — `category` (default in Clusters) / `flat` — grouping toggle within Clusters mode

The router translates legacy URLs into the canonical form. Old
browser bookmarks and external deep-links keep working without
behavior change.

## 6. Phased rollout

Each phase is independently shippable. Stopping after any phase leaves
the system coherent.

1. **Phase α — extract reusable tab components.** Pure refactor: pull
   the bodies out of `ClustersPage` / `AnomaliesPage` /
   `ClusterDetailPage` into `ClustersTab` / `AnomaliesTab` /
   `ClusterDetailPanel`. Existing pages render the extracted
   components inside their existing chrome — no UX change yet. (~1
   day.)
2. **Phase β — host all three modes in `SessionDetailPage`.** Add the
   mode tab strip; render the per-mode body inside the existing main
   content area. Existing routes still work (redirect or directly
   render to the appropriate tab). Detail pane stays comparison-only
   until phase γ. (~2 days.)
3. **Phase γ — unify the detail pane.** Add the cluster-detail variant
   to the right pane so Clusters mode no longer needs to navigate
   away. Add the "Show cluster" / "Show members in Rows" cross-mode
   gestures. (~1-2 days.)
4. **Phase δ — shared filter strip.** Replace the current filter chip
   bar with one that's tab-aware. Filter state in URL query params for
   shareability. (~1-2 days.)
5. **Phase ε — rule provenance badge + cluster acceptance from Rows.**
   Add `acceptance_rule_id` (and optionally `cluster_id`) to the
   `SessionResultRow` DTO. Render the badge. Add the "Accept this
   row's cluster" affordance. (~1 day.)
6. **Phase ζ — keyboard model + cheat-sheet.** Wire the tab-switch
   bindings and the cross-mode shortcuts. (~0.5 day.)

Total estimate: 6-8 days of focused work. Phases α-β are the load-
bearing UX change; γ-ζ are quality-of-life.

## 7. Validation plan

This is a UX consolidation — the value is qualitative. Three
measurements worth taking:

### 7.1 Time-to-decision (per-pair)

Before B: time `cluster-review-design`-baseline session through the
existing two-surface workflow. After B: same session, same reviewer,
through the unified surface. Compare decisions-per-minute.

**Pass criterion**: B is no slower than the existing flow, ideally
faster (~20% improvement). Below baseline = the consolidation isn't
worth it.

### 7.2 Mode-switching frequency

Instrument tab clicks in B's UI. If reviewers switch tabs constantly
(say, > 1 switch per 5 decisions), the modes might not reflect genuine
mental-model boundaries — they're being used as filters rather than
distinct workflows. That'd indicate the modes should be collapsed or
the chip filters should subsume them.

### 7.3 Disagreement rate

Re-review a sample of B-bulk-accepted clusters one-by-one in the Rows
tab. Count "I'd have flagged this" overrides.

**Pass criterion**: disagreement rate ≤ 5% (same bar as the original
cluster review's Phase D gate).

### 7.4 Qualitative survey

Two short questions to anyone who triages a session under B:
- "Where would you go to do X?" (find a regression, accept a
  cross-page pattern, look at one-off changes)
- "Did anything feel like it should be in a different mode?"

Answers shape phase-γ+ refinements.

## 8. Out of scope

- New cluster-review functionality. B is layout, not feature work.
  Split, crop view, keyboard model for cluster gestures
  (deferred-from-cluster-review-proposal items) remain deferred.
- Multi-session views. The unified surface is per-session.
- Schema changes. Everything required is additive at the DTO layer.
- LM prompt or signature changes. Untouched.

## 9. Open questions

Resolved during iteration:
- ~~Canonical URL~~ — §5.3 decided: `/sessions/:id` is canonical; old
  routes redirect with state preserved.
- ~~Anomalies tab as its own surface vs collapse into Rows filter~~ —
  kept as own tab. Flagged for revisit if Experiment 7.2 surfaces it.

Still open:

- **Performance on large sessions.** Mounting both `ClustersTab` and
  `SessionResultsList` even when one is hidden could be costly. Lean
  toward lazy-mounting per tab (only the active tab renders), with
  state persisted at the parent level so a tab-switch doesn't refetch.
- **Anomalies tab content shape.** The current `AnomaliesPage` is
  flat. The unified Anomalies tab might be richer (verdict glyph, ssim
  metrics, like Rows mode). Worth a UX sketch before phase β.
- **Filter chip backward compat.** Existing reviewers have URLs with
  filter state in `localStorage` or muscle memory for the current chip
  bar. Phase δ should preserve as much as possible.
- **Actions menu placement on multi-select.** The menu is described as
  per-focused-item. If a future phase adds multi-select on rows or
  clusters (e.g. select 5 anomalies → bulk accept), does the menu
  switch to multi-target mode automatically, or does multi-select get
  its own toolbar? Probably the former, but worth deciding before
  multi-select lands.

## 10. What this scope does *not* commit to

- Any backend rewrite or DB migration.
- Removing existing pages outright. They become thin shells around
  the extracted components, or auto-redirect into the unified surface.
- A specific UI library. Stays vanilla React + CSS as the rest of the
  app.
- A timeline. Estimates above are working-day estimates, not
  calendar.
