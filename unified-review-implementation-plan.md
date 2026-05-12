# Unified Review Surface — Implementation Plan

Companion to `unified-review-proposal.md`. The proposal answers *what*
and *why*; this doc answers *which files, in what order, with what
shape*. Both live on the `unified-review-surface` branch.

The work is entirely frontend (`packages/web/`) plus one small additive
DTO field. No DB migrations, no API endpoint changes.

## Phase summary

| Phase | What | Estimate |
|---|---|---|
| α | Extract reusable tab/panel components (refactor only, no UX change) | ~1 day |
| β | Host three tabs in `SessionDetailPage`; route redirects | ~2 days |
| γ | Unified detail pane + Actions menu | ~1-2 days |
| δ | Shared filter strip with URL-param state | ~1-2 days |
| ε | Rule provenance badges + "Accept this cluster" from Rows mode | ~1 day |
| ζ | Keyboard shortcuts + cheat-sheet | ~0.5 day |

Each phase is independently shippable. After any phase the system is
coherent; nothing depends on a phase that hasn't landed yet.

## Pre-flight — file inventory

Read before touching anything else (these are the load-bearing files):

- `packages/web/src/pages/SessionDetailPage.tsx` (~620 lines) — the
  current host. Has sidebar tabs (review/config), detail tabs
  (comparison/history/pairs), wires `SessionResultsList` +
  `ComparisonDetail`. The unified surface lands here.
- `packages/web/src/pages/ClustersPage.tsx` (~265 lines) — category
  index. Manages its own data fetch + filter state + bulk-accept
  dialog state.
- `packages/web/src/pages/ClusterDetailPage.tsx` (~360 lines) — single
  cluster. Manages its own data fetch + accept/reject dialog state.
- `packages/web/src/pages/AnomaliesPage.tsx` (~140 lines) — flat list.
- `packages/web/src/components/SessionResultsList.tsx` (~300 lines) —
  the row list + filter chips. Stays as-is in α-β; phase δ overhauls
  its filter chips.
- `packages/web/src/components/ComparisonDetail.tsx` (~520 lines) —
  focused comparison panel.
- `packages/web/src/App.tsx` — routes.
- `packages/web/src/api/client.ts` — already has all the cluster +
  category endpoints.

## Phase α — component extraction

Goal: pull the bodies out of the cluster/anomalies pages into
reusable, prop-controlled components. Pages become thin shells. **No
visible UX change.**

### Components to create

- `packages/web/src/components/ClustersTab.tsx` — the body of
  `ClustersPage.tsx` from below the `<header>` block down. Props:
  ```ts
  {
    sessionId: string;
    reviewStateFilter: ClusterReviewState | 'all';
    onClusterFocus?: (cluster: ClusterSummaryDto) => void;
    onMutated?: () => void;  // bulk-accept refresh hook
  }
  ```
  Internal state: cluster list, loading, error. Bulk-accept dialog
  stays internal — it's a per-tab concern.
- `packages/web/src/components/AnomaliesTab.tsx` — body of
  `AnomaliesPage.tsx`. Props: `{ sessionId; onClusterFocus? }`.
- `packages/web/src/components/ClusterDetailPanel.tsx` — body of
  `ClusterDetailPage.tsx` from below the `<Link>` back-link. Props:
  ```ts
  {
    sessionId: string;
    clusterId: string;
    onChanged?: () => void;  // for parent to refresh its data
  }
  ```
  Internal state: cluster detail, accept/reject dialog state.

### Components that don't change in α

- `SessionResultsList` — already self-contained, no extraction needed.
- `ComparisonDetail` — same.

### Pages after α (thin shells)

- `ClustersPage.tsx` renders its current header chrome + the
  `<ClustersTab/>` component. State management for the filter chip row
  stays in the page (until δ moves it out).
- `AnomaliesPage.tsx` same shape.
- `ClusterDetailPage.tsx` renders the back-link + `<ClusterDetailPanel/>`.

### Tests

- No new tests in α (pure refactor).
- Existing tests are API-side and unaffected.
- Run `pnpm typecheck` in `packages/web/` after each extraction.
- Spot-check the three pages render identically in the browser.

### Definition of done

- Three new components compile, render inside their now-thin pages.
- No visual or behavioral change observable in the UI.
- `git diff` shows mostly moves: page content shrinking, new files
  appearing.

## Phase β — host tabs in SessionDetailPage

Goal: surface the three modes as tabs inside the existing session
detail page. This is the load-bearing UX change.

### SessionDetailPage edits

- Add a `mode` state derived from URL: `'clusters' | 'rows' | 'anomalies'`.
  Default `'clusters'` (the funnel start).
- Add a tab strip below the `<header>` row, above the existing sidebar
  tabs. Visual: large pill-style tabs `Clusters / Rows / Anomalies`.
- Render per-tab body in the main content area:
  - `clusters` → `<ClustersTab/>` (current sidebar layout doesn't
    apply; the cluster surface is its own full-width body).
  - `rows` → the existing review sidebar + `ComparisonDetail` layout.
    This is the current page's behavior, untouched.
  - `anomalies` → `<AnomaliesTab/>`.

### Routing changes (App.tsx)

- `/sessions/:id` → `<SessionDetailPage/>`, reads `mode` from URL.
- `/sessions/:id/clusters` → redirect to `/sessions/:id?mode=clusters`,
  preserving any other query state.
- `/sessions/:id/anomalies` → redirect to `/sessions/:id?mode=anomalies`.
- `/sessions/:id/clusters/:cluster_id` → stays as its own route
  (`<ClusterDetailPage/>`) in this phase. γ folds it into the unified
  surface.
- The "Cluster review" button currently on `SessionDetailPage` is now
  redundant (the tab strip does the job) — remove it.

### Lazy mounting

- Only the active tab's component mounts. State for non-active tabs
  isn't preserved between switches (acceptable for α-β; phase δ adds
  URL-param-backed persistence so a re-mount lands in the same state).

### Tests

- Add a basic web test (if any web test framework exists; otherwise
  defer). For now, manual smoke:
  - Navigate to `/sessions/:id` → lands in Clusters tab.
  - Click Rows → switches.
  - Visit `/sessions/:id/clusters` → redirects, lands in Clusters tab.
  - Visit `/sessions/:id/anomalies` → redirects, lands in Anomalies tab.
- Run `pnpm typecheck` in `packages/web/`.

### Definition of done

- Three tabs visible and functional from any session.
- Legacy URLs redirect correctly.
- "Cluster review" button removed from the header (tabs subsume it).

## Phase γ — unified detail pane + Actions menu

Goal: collapse the cluster-detail standalone page into a panel inside
the unified surface. Add the Actions menu in the detail pane chrome.

### Unified detail pane shell

- New component
  `packages/web/src/components/DetailPane.tsx`. Props:
  ```ts
  {
    sessionId: string;
    focused:
      | { kind: 'row'; pairKey: string; comparisonId: string | null }
      | { kind: 'cluster'; clusterId: string }
      | null;
    onClose?: () => void;
    onChanged?: () => void;
  }
  ```
  Renders `ComparisonDetail` for `kind: 'row'`, `ClusterDetailPanel`
  for `kind: 'cluster'`, an empty-state hint for `null`.
- The Actions menu lives in the pane's top-right (next to a close
  button if applicable). New component
  `packages/web/src/components/ActionsMenu.tsx`. Props:
  ```ts
  {
    focused: DetailPaneProps['focused'];
    sessionId: string;
    onAccepted?: () => void;
    onRejected?: () => void;
    onModeChange?: (mode: Mode, focus?: string) => void;
  }
  ```
  Internally computes the action list per the proposal §3.5 (focused
  row / focused cluster / focused anomaly). Disabled-with-reason for
  inapplicable items.

### SessionDetailPage edits

- `mode === 'clusters'`: layout becomes split-pane —
  `<ClustersTab/>` on the left, `<DetailPane/>` on the right.
  `onClusterFocus` on the tab sets a `focused: { kind: 'cluster', ... }`
  state which drives the pane.
- `mode === 'rows'`: existing layout already has a detail panel;
  swap `ComparisonDetail`'s direct mount for `<DetailPane focused=
  { kind: 'row', ... } />`. Most rendering identical, but Actions
  menu now lives in the shared pane chrome.
- `mode === 'anomalies'`: same as rows mode — focused anomaly maps
  1:1 to a comparison, so the pane shows `ComparisonDetail`.

### Routing changes

- `/sessions/:id/clusters/:cluster_id` redirects to
  `/sessions/:id?mode=clusters&focus=<cluster_id>` and the standalone
  page is retired.
- `App.tsx`: remove the route; replace with a redirect.

### Tests

- Manual smoke: focused cluster opens in pane, Actions menu items
  appear correctly, accept/reject still work.
- `pnpm typecheck`.

### Definition of done

- Cluster detail no longer requires leaving the unified surface.
- Actions menu visible in detail pane top-right, lists context-correct
  items with disabled-with-reason for the rest.
- Cross-mode gestures (e.g. "Show members in Rows" from a cluster)
  work via the menu, switching `mode` via URL.

## Phase δ — shared filter strip

Goal: replace per-page filter chips with the four-zone strip
described in proposal §3.4. URL params drive state.

### Components

- New `packages/web/src/components/FilterStrip.tsx`. Props:
  ```ts
  {
    mode: Mode;
    filters: FilterState;
    counts: FilterCounts;  // per-chip badges from the response summary
    onChange: (next: FilterState) => void;
  }
  ```
  Renders the four zones; hides/disables zones per mode per the
  applicability tables in proposal §3.4.
- New `packages/web/src/api/filterState.ts` — a tiny module that
  serialises/deserialises `FilterState` to/from URL `URLSearchParams`.
  Single source of truth for the query-param contract.

### Tab edits

- `ClustersTab` accepts `filters: FilterState` as a prop and applies
  them in-memory to the cluster list.
- `AnomaliesTab` same.
- `SessionResultsList` — its existing filter logic is replaced by the
  shared `FilterState`. The component keeps the histogram strip but
  the chip row is removed (it's been hoisted into `FilterStrip`).

### SessionDetailPage edits

- Read filter state from URL on mount; write back to URL on change.
- Pass the state down to whichever tab is active.

### URL-param contract

Documented in proposal §5.3. Implementation note: keep all params
flat (no nested JSON), comma-separated for multi-select.

### Tests

- New unit tests for `filterState.ts` (round-trip serialise / parse).
- Manual smoke: filter state survives mode switch, survives reload.

### Definition of done

- Filter strip visible above all three tabs.
- Filter state in URL; reload preserves state; back/forward navigates
  between states.

## Phase ε — rule provenance + accept-cluster-from-row

Goal: surface that a row was accepted via a cluster/category rule, and
make it possible to accept a cluster from inside Rows mode.

### Backend DTO changes (additive)

- `packages/api/src/types.ts`: extend `SessionResultRow` with:
  ```ts
  acceptance_rule_id: string | null;
  cluster_id: string | null;             // the row's cluster, if any
  cluster_review_state: ClusterReviewState | null;
  ```
- `packages/api/src/services/evaluator.ts`: populate the three new
  fields. `acceptance_rule_id` is already on the `acceptances` row;
  `cluster_id` requires joining `differences.signature` with
  `difference_clusters` for the row's comparison. New field on the
  imagick-regions lookup or a parallel cluster lookup.

### Frontend edits

- `SessionResultsList` — render a small badge on rows where
  `acceptance_rule_id !== null`: "via cluster" / "via category"
  depending on the rule's scope (fetched lazily, cached at the row
  level or precomputed in the DTO).
- `ActionsMenu` — Rows mode menu's "Accept this cluster" item is now
  enabled when `cluster_id !== null` and `cluster_review_state !==
  'accepted'`. Opens the cluster accept dialog.
- `ComparisonDetail` — when `acceptance_rule_id !== null`, show a
  "Accepted via cluster rule" indicator above the per-row Accept
  affordance.

### Tests

- Extend an existing evaluator test to assert the new fields are
  populated on rows that belong to clusters.
- Manual smoke: accept a cluster, navigate to Rows mode, see the
  badge on member rows.

### Definition of done

- DTO carries rule provenance; row badges visible; cluster accept
  available from a focused row.

## Phase ζ — keyboard model + cheat-sheet

Goal: wire the cross-tab shortcuts; surface them.

### Edits

- `SessionDetailPage` (or a new `useKeyboardShortcuts` hook):
  - `1` / `2` / `3` — switch mode.
  - `c` (from any mode with a focused row) — jump to that row's
    cluster (Clusters mode + `focus`).
  - Existing `a` / `A` / `r` remain wired but now route through the
    Actions menu's primary actions.
- Add a `?` overlay that shows the keyboard cheat-sheet. Optional but
  cheap.
- Empty-state hint in the detail pane mentions the shortcuts.

### Tests

- Manual smoke. No unit tests for keyboard plumbing.

### Definition of done

- Shortcuts work; cheat-sheet accessible.

## Cross-phase concerns

### State management

No new state library. React state in `SessionDetailPage` is the parent
of truth; URL params back what needs to be shareable / persistent;
per-tab internal state stays in the tab components.

### Performance

- Lazy-mount only the active tab.
- Filter state changes don't trigger refetch — they filter in-memory
  against the cached list. The list itself refetches only on session
  load, on explicit Refresh, or after a mutation (accept/reject).
- Cluster index might be large (the sitemap session has 410 clusters);
  Rows list is virtualised today and stays virtualised.

### Testing

- No web tests currently exist in the repo. Adding vitest +
  react-testing-library would be a meaningful investment that's out of
  scope for this work; defer.
- Manual smoke after each phase against the dev session.
- Existing API tests stay green throughout (none of the API surface
  changes except the additive DTO fields in ε).

### Risk register

- **Filter chip removal in `SessionResultsList`** (phase δ) — existing
  reviewers may have muscle memory for the chip positions. The new
  `FilterStrip` should keep the chip *order* (status first, then
  outcome, then level) so the visual flow is similar.
- **Routing redirects** — preserve the full query string when
  redirecting; otherwise existing bookmarks lose their filter context.
- **Actions menu disabled-with-reason** is text-heavy. Keep tooltips
  short and don't let them block accidental clicks.

## Commit & PR strategy

One commit per phase, with a concrete commit message structure (same
shape as the cluster-review-design phase commits). Branch
`unified-review-surface` accumulates them. PR after ζ (or earlier if
we want incremental review).

## Validation gates

Between phases, check:
- `pnpm typecheck` in both packages — green
- API test suite — green (serial run; the known parallel flakes are
  pre-existing per CLAUDE.md)
- Manual smoke against the dev session — the new tab/feature works
  AND the previous behavior still works
- No new accessibility regressions (keyboard, focus, tab order)

If any gate fails, the phase doesn't merge until it's resolved.
