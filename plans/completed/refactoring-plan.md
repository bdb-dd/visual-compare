# Refactoring plan — phased implementation (shipped)

Phase 1 → 5 of the 2026-05 refactor. All committed and merged to
`main`. Phase 6 (Worker VM pool) was extracted into its own plan at
`plans/in-progress/worker-vm-pool.md` because it's a multi-week infra
change that's qualitatively different from the UI/data-model work in
this document.

## Shipped commits

| Phase | Commit  | Title                                                            |
|-------|---------|------------------------------------------------------------------|
| 1     | 18bfecd | UI polish + LM toggle moves to Config                            |
| 2     | 840f3ba | cluster surface (tabs, kb nav, rep treatment, A&#124;B, reject fix)   |
| 3     | de153f9 | metrics row, error log tab, CPU usage indicator                  |
| 4     | 0289b6a | session-scoped comparison route + URL audit                      |
| 5     | fea363c | per-member accept, split cluster, contextual acceptance          |
| polish| 1af747b | Members list: viewport tabs, overflow menu, end-anchored URLs    |

Item sizes used through this plan: **XS** (hour), **S** (day),
**M** (few days), **L** (week), **XL** (multi-week, needs design doc).


## Phase 1 — Quick UI wins (1–2 days, fully parallelizable) — **shipped**

No design needed. Pure component / config changes.

Notes worth carrying forward:

- **1.A**: only new sessions get `default_invoke_lm = true` (the DB
  column DEFAULT stays 0; the createSession INSERT now sets it
  explicitly). Existing sessions retain their persisted value. The
  client stopped passing `invoke_lm` from `getResults` /
  `evaluate` — the server reads `session.default_invoke_lm` in
  `resolveEvaluationConfig`.
- **1.G**: detail pane has `overflow: hidden`, so a true viewport-wide
  slider would clip. Practical fix was dropping the 720px max-width
  on `.cluster-detail__images--slider` so it fills the pane.
- The unused `.cluster-detail__members` CSS (left over from a
  pre-Phase-γ surface) was not touched — dead but harmless and out
  of scope.

### 1.A — LM second pass: default on, move into Config (S)
- Flip `default_invoke_lm` default to `true` in API session defaults
  (`services/sessions.ts`).
- Toggle moves from `PlanAndEvaluate` to `SessionConfigPanel` with
  autosave; lifted state and prop-drilling through
  `SessionDetailPage` removed.

### 1.B — Non-primary actions into "…" menu (XS)
- `HeaderOverflowMenu` in `SessionDetailPage` swallows Archive/Unarchive
  and Recapture all. Uses existing `.actions-menu*` styles. Evaluate
  stays primary.

### 1.C — Collapsible filter strip (S)
- `FilterStrip` wrapped in `<details>` with an active-chip summary
  line. Collapse state persists per session in `localStorage`.

### 1.D — Members filmstrip height cap (XS)
- `.member-list` capped at `max(200px, 50vh)` with internal scroll.

### 1.E — Filmstrip moves above image triple (XS)
- Reordered the `cluster-detail__sample` section.

### 1.F — Larger LM output font (XS)
- `.cluster-detail__lm-summary` 13 px → 16 px with 1.5 line height.

### 1.G — Slider fills the detail pane (XS)
- See note above on the viewport-wide vs pane-wide trade-off.

### 1.H — Export A / B URL buttons (XS)
- Client-side blob download per side from the focused cluster's members.


## Phase 2 — Cluster surface (~1 week) — **shipped**

Larger interaction changes. Shared surface area (ClustersTab,
ClusterDetailPanel, ActionsMenu) — done together to avoid merge
conflicts.

Notes worth carrying forward:

- **2.E**: the §0 Phase-0 design doc was inlined. The user clarified
  that open clusters must be directly rejectable, so the state
  machine is encoded directly in `rejectCluster` (split / rejected
  stay terminal). The legacy `revokeClusterAcceptance` name remains
  as a one-release deprecated re-export.
- **2.B**: Shift+Arrow pushes one history entry per step. Plain
  arrows for rows still replace. Watch how this lands in practice —
  if it floods history we can switch to replace.
- **2.C**: Per-cluster member focus uses a `Map<clusterId, memberId>`
  in `SessionDetailPage` React state, not in the URL. Share links
  always open at the representative.

### 2.A — Categories as tabs (S)
- Six cluster category sections → tab control. Active tab persists in
  URL (`&cat=`). Empty categories disabled with `(0)`.

### 2.B — Shift+arrow keyboard navigation (S)
- `Shift+ArrowUp/Down` steps clusters in the active category tab and
  anomalies in `AnomaliesTab`. New `onClusterStep` prop pushes
  history; clicks still replace. No wrap-around.

### 2.C — Representative member treatment (S)
- Representative sorted to top of filmstrip + inline Members list.
  Gold ★ badge. Label "Representative member:" in the detail.

### 2.D — "A | B" view mode (S)
- Third view mode (alongside triple + slider). New `ImageAB`
  component. Two-column grid.

### 2.E — Fix Reject UX (M)
- Renamed `revokeClusterAcceptance` → `rejectCluster`. Broadened the
  state machine: `open → rejected` and `anomaly → rejected` are
  no-ops on the rule table; `accepted → rejected` keeps the existing
  full revoke. Blocks `rejected → rejected` (`already_rejected`) and
  `split → rejected` (`not_rejectable`). UI gating dropped from
  `ActionsMenu` + `ClusterDetailPanel`. Tests cover all transitions.


## Phase 3 — Metrics & visibility (a few days) — **shipped**

Independent of Phase 2 — different surface (top header, new tab).

Notes worth carrying forward:

- **3.A**: speed and ETA are computed client-side from a rolling
  30-second sample buffer of polled progress updates — no server
  changes needed. Buffer resets on evaluation id or phase change.
- **3.B**: `/api/sessions/:id/errors` joins captures/comparisons with
  url_pairs and returns up to 500 entries per table. Frontend groups
  by exact `error_message` string. A first-render guard
  (`errors === null`) is required because the load effect runs after
  the first paint; without it the body de-references a null array
  (fixed mid-Phase-3).
- **3.C**: the in-process tracker (`services/worker-activity.ts`)
  mirrors the LM tracker's shape so Phase 6 (`worker-vm-pool.md`)
  can replace the data source without UI changes. Capacity is
  observed at runtime via `observeCapacity(n)` from capture/comparison;
  seed value is `availableParallelism()` from `node:os`.

### 3.A — Metrics redesign (S)
- `EvaluationMetrics` strip below the Evaluate button while running:
  phase, total, remaining, items/sec (30s rolling), formatted ETA.

### 3.B — Error log tab (S)
- New tab in the detail pane to the right of "URL pairs". Capture +
  comparison errors grouped by exact message; pills colour-code
  capture (orange) vs comparison (purple).

### 3.C — CPU usage indicator (S, in-process)
- New `services/worker-activity.ts` mirrors `lm-activity`. Capture
  and comparison wrap their `limit()` callbacks with `trackCall()`
  and call `observeCapacity(concurrency)`. New endpoint
  `GET /api/meta/worker-activity`. `WorkerActivityHistogram` sits
  next to the LM histogram in the header, green bars.


## Phase 4 — Routing consolidation (~1 week) — **shipped**

Notes worth carrying forward:

- **4.A**: legacy `/comparisons/:id` is a client-side redirect
  (loads the comparison to learn its session id, then
  `<Navigate replace>`s). The `!sessionId` heuristic in
  `ComparisonDetail`'s Recapture path broke once the standalone
  page also has a session id; replaced with an explicit
  `onComparisonIdChange?` callback (parent decides).
- **4.B**: URL schema documented inline at the top of
  `SessionDetailPage`'s state block. Push history for discrete
  navigation (mode switch, cross-mode jumps, Shift+Arrow), replace
  for in-place edits (cluster click, filter chip, view-mode
  toggle). View mode now lives at `?view=ab|slider` (triple is
  canonical and omitted).

### 4.A — Session-scoped comparison route (M)
- New `/sessions/:id/comparisons/:comparison_id` renders
  `ComparisonDetailPage` with session id from the URL. Legacy
  `/comparisons/:id` redirects via `LegacyComparisonRedirect`.
  Internal links in `ClusterDetailPanel`, `ClustersTab`, and
  `ActionsMenu` updated to the session-scoped form.

### 4.B — URL audit and consolidation (M)
- `setMode`, the `c` keyboard cross-mode jump, and the row→cluster
  cross-mode gestures (`onRowAcceptCluster`, `onRowShowCluster`)
  push history. View mode persists in URL with replace-on-change.


## Phase 5 — Acceptance model & unified detail view (~1–2 weeks) — **shipped**

Notes worth carrying forward:

- **5.A**: per-member acceptance reuses the row-acceptance endpoint
  (`POST /api/sessions/:id/acceptances`) — no parallel mechanism.
  The cluster header shows partial state ("3/12 accepted") as a
  separate facet, distinct from cluster-rule acceptance. Filmstrip
  + inline members list tag accepted entries with ✓.
- **5.B**: split implemented by rewriting selected differences'
  `signature` to `<original>:split:<uuid>`, then recomputing the
  cluster index. The source cluster keeps its identity and state;
  the new cluster starts open. Splits do not survive a full
  re-evaluation — new differences land with the canonical signature.
  The dialog locks the representative into the source half so the
  source's signature anchor doesn't move.
- **5.C**: scoped to "context-aware acceptance UI" rather than a
  full `ComparisonDetail` rewrite. The cluster detail view keeps its
  own triple/AB/slider rendering; the member-accept flow gets the
  full label / notes / accept_any dialog matching the row flow, and
  the meta block carries a contextual banner reading the cluster's
  review_state for the focused member. **Deferred**: a full
  `ComparisonDetail`-everywhere unification (single component
  rendered in both row and cluster contexts) — exit criteria met
  without it; revisit if the divergence becomes painful.
- **Cluster list refresh**: `ClustersTab` takes a `refreshTick` prop
  bumped by `SessionDetailPage` on every cluster-shape-changing
  action (Accept/Reject/Split) so the list re-fetches without
  manual intervention.

### 5.A — Accept single member (M)
- New per-member accept path through the existing row endpoint.
  Cluster header gains a partial-acceptance facet; filmstrip + list
  rows mark accepted entries.

### 5.B — Finish Split cluster (M)
- New `POST /api/sessions/:id/clusters/:cluster_id/split`. Service
  in `services/clusters.ts:splitCluster` rewrites signatures + runs
  `recomputeClusters`. `SplitDialog` in `ClusterDetailPanel`
  multi-selects members, locks the rep in the source.

### 5.C — Context-aware acceptance UI (M, scoped)
- `MemberAcceptDialog` with label / notes / accept_any. Cluster-state
  banner above member actions explains what the cluster's review
  state means for the focused member.


## Post-Phase-5 polish (1af747b)

A round of feedback-driven cleanup on the Members list after Phase 5
landed:

- Per-row Recapture + "Open →" buttons removed from `InlineMemberList`.
  Per-pair Recapture moved next to the per-member Accept controls in
  `ClusterDetailPanel` so it travels with the focused member.
- "Members (xx)" title replaced with a viewport tab strip. Tabs are
  derived from the cluster's actual member viewport set, sorted by
  count, defaulting to the representative's viewport. The per-row
  viewport column drops out — grid becomes URL (1fr) · changed %
  (70px).
- Export A / B URLs collapsed into a "⋯" overflow menu right-aligned
  in the tab bar.
- URLs in the list truncate at the start (`direction: rtl;
  text-align: left;`) so the distinguishing path tail stays visible.


## Lessons / patterns established

- **Per-phase commits + plan notes**: each phase's "Notes worth
  carrying forward" sections capture decisions that aren't obvious
  from the code (e.g., why representative member focus is in React
  state, not URL). Worth doing for future multi-phase efforts.
- **In-process trackers as seams**: `worker-activity.ts` was built
  with the explicit intent that its DTO survive the Phase 6
  remote-worker swap. Pattern: introduce the abstraction in-process
  first, then change the data source. Lower-risk than building the
  abstraction in tandem with the remote system.
- **Test flakes**: a handful of parallel-suite tests flaked under
  contention (one cache-invalidation test, one clusters-api test,
  the evaluator-cancel batching test). All passed in isolation; the
  retries were absorbed into the relevant phase commits. None
  represented real regressions.
- **URL schema discipline**: documented push-vs-replace policy
  inline (top of `SessionDetailPage`'s state block) so subsequent
  changes have a place to fit.


## What stayed deferred

Carried forward as separate work:

- **Phase 6**: extracted to `plans/in-progress/worker-vm-pool.md`.
- **Full `ComparisonDetail` unification** (the "all the way"
  interpretation of 5.C): cluster context still renders its own
  triple/AB/slider, not `ComparisonDetail`. Tracker in 5.C's notes.
- **Cross-session rule memory**, **live precision/recall on a
  curated change-set**, and **UI time-to-triage A/B vs row-by-row
  review** — listed at the bottom of the original
  `cluster-review-proposal.md` and still untouched.
