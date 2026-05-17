# Refactoring plan — phased implementation

Each phase is sized to ship as a coherent slice. Phases 1–3 are
parallelizable and need no upstream design. Phases 4–6 have
dependencies called out at the top of each.

Item sizes: **XS** (hour), **S** (day), **M** (few days), **L** (week),
**XL** (multi-week, needs design doc).


## Phase 0 — design docs (parallel, before Phase 6)

Two items need a design doc before implementation; everything else can
start from this plan as-is.

- **Worker VM pool** (§6.A). Open questions: transport (HTTP RPC vs
  queue), shared image storage (`.shared/images` mount vs object
  store), scale-to-zero policy, cross-worker retry, observability.
- **Reject state machine** (§2.E). Today the API treats Reject as
  "revoke acceptance" and 409s on open clusters
  (`services/acceptance-rules.ts:156`). The doc should enumerate the
  valid transitions (open → rejected, accepted → rejected,
  rejected → accepted, etc.) and decide whether to split the existing
  function or extend it.


## Phase 1 — Quick UI wins (1–2 days, fully parallelizable) — **done**

No design needed. Pure component / config changes. Ship as one PR or
several small ones.

Shipped on the `refactor` branch and verified visually. Notes worth
carrying forward:

- **1.A**: only new sessions get `default_invoke_lm = true` (the DB
  column DEFAULT stays 0; the createSession INSERT now sets it
  explicitly). Existing sessions retain their persisted value.
- **1.G**: detail pane has `overflow: hidden`, so a true viewport-wide
  slider would clip. Practical fix was dropping the 720px max-width so
  the slider fills the pane.
- The unused `.cluster-detail__members` CSS (left over from a
  pre-Phase-γ surface) was not touched — it's dead but harmless and out
  of scope for Phase 1.

### 1.A — LM second pass: default on, move into Config (S)

- Flip `default_invoke_lm` default to `true` in API session defaults
  (`services/sessions.ts`). Decide whether to backfill existing
  sessions or only apply to new ones.
- Remove the checkbox from `PlanAndEvaluate.tsx:177`.
- Add it to `SessionConfigPanel.tsx` alongside the other autosaved
  fields. The `invokeLm` state lifted into `SessionDetailPage.tsx:125`
  collapses into the panel's autosave path.
- Drop the prop drilling through PlanAndEvaluate.

**Exit**: toggle only exists in Config; new sessions default to true;
evaluator still respects the value per evaluation.

### 1.B — Non-primary actions into "…" menu (XS)

- Move Archive/Unarchive (`SessionDetailPage.tsx:652`) and Recapture all
  (`:649`) into an overflow menu in the top header zone.
- Evaluate stays as the primary CTA.
- Recapture confirm dialog stays.

### 1.C — Collapsible filter strip (S)

- Wrap `FilterStrip.tsx` body in `<details>` collapsed by default.
- Summary line shows active chips only:
  `Status: needs_review · Level: strict, tolerant`.
- Persist open/closed in localStorage per session (not URL).
- Same change applies to clusters and rows — single component.

### 1.D — Members filmstrip height cap (XS)

- Cap at `min(50vh, max(200px, ...))` with internal scroll.
- `ClusterDetailPanel.tsx` filmstrip block.

### 1.E — Filmstrip moves above image triple (XS)

- Reorder elements in `ClusterDetailPanel.tsx:96`.
- Verify the height cap from 1.D is in place first so it doesn't push
  the triple off-screen.

### 1.F — Larger LM output font (XS)

- Bump font-size in the LM output block of `ClusterDetailPanel.tsx`.
- Sanity check density on neighbors.

### 1.G — Slider fills viewport width (XS)

- A/B slider stretches to viewport width while active, reverts on
  exit. `ComparisonDetail.tsx` slider mode.

### 1.H — Export A / B URL buttons (XS)

- Two buttons next to the "Members" label in `ClusterDetailPanel.tsx`.
- Client-side blob download from `data.members[]`. No API change.
- Filenames: `cluster-{id}-A.txt` / `cluster-{id}-B.txt`.

**Phase 1 exit**: all 8 items shipped; no behavior regressions in
rows/clusters/anomalies views.


## Phase 2 — Cluster surface (~1 week) — **done**

Larger interaction changes. Some shared surface area (ClustersTab,
ClusterDetailPanel, ActionsMenu) — best done together to avoid merge
conflicts.

Shipped on the `refactor` branch. Notes worth carrying forward:

- **2.E**: §0 Phase-0 design doc deferred — the user clarified inline
  that open clusters must be directly rejectable, so the state machine
  is encoded directly in `rejectCluster` (split / rejected stay
  terminal). The legacy `revokeClusterAcceptance` name remains as a
  one-release deprecated re-export.
- **2.B**: Shift+Arrow pushes one history entry per step (per the
  plan). Plain arrows for rows still replace. Watch how this lands in
  practice — if it floods history we can switch to replace.
- **2.C**: Per-cluster member focus uses a `Map<clusterId, memberId>`
  in `SessionDetailPage` React state, not in the URL. Share links
  always open at the representative.

### 2.A — Categories as tabs (S)

- Convert the six category sections in `ClustersTab.tsx:41–55` to a
  tab control.
- Active tab persists in URL (`&cat=main_content`).
- Cluster count badge per tab; empty categories disabled with `(0)`.

### 2.B — Shift+arrow keyboard navigation (S)

- Add `Shift+ArrowUp` / `Shift+ArrowDown` for cluster-to-cluster nav
  within the active category tab.
- Plain arrows already used for rows (`SessionDetailPage.tsx:436`) —
  Shift modifier avoids clash.
- Each step `navigate()`s with a new `focus=` so back button walks
  history. No wrap-around.

### 2.C — Representative member treatment (S)

- Sort representative to first position in filmstrip.
- Visual badge / border on the representative thumbnail.
- Label "Representative member" in the detail context.
- First-focus of a cluster opens the representative. Subsequent focus
  within that cluster tracked in React state (per-cluster map), **not**
  in the URL.

### 2.D — "A | B" view mode (S)

- Third view mode alongside triple and slider in `ComparisonDetail.tsx`.
- Renders A and B side-by-side without diff overlay.
- New mode key persisted in URL.

### 2.E — Fix Reject UX (M, blocked on §0 design)

**Problem**: tooltip says "Only accepted clusters can be rejected"
(`ActionsMenu.tsx:252`, `ClusterDetailPanel.tsx:297`). The API mirrors
this — `revokeClusterAcceptance()` 409s for non-accepted clusters
(`services/acceptance-rules.ts:156`). The user should be able to reject
an open cluster directly.

- **API**: per the §0 design, either extend `revokeClusterAcceptance`
  to handle open → rejected, or introduce a `rejectCluster` function
  that handles `open → rejected` and keeps the existing one for
  `accepted → rejected`. Update `routes/clusters.ts:173` accordingly.
- **UI**: remove the "must be accepted first" gate in both
  `ActionsMenu.tsx:247–252` and `ClusterDetailPanel.tsx:20, 297`.
  Update the state-machine comment in ClusterDetailPanel to match.
- **Tests**: cover all transitions enumerated in the §0 doc.

**Phase 2 exit**: clusters surface usable with keyboard, category
tabs working with deep-links, representative visually clear, Reject
works from any state.


## Phase 3 — Metrics & visibility (a few days) — **done**

Independent of Phase 2 — different surface (top header, new tab).

Shipped on the `refactor` branch. Notes worth carrying forward:

- **3.A**: speed and ETA are computed client-side from a rolling
  30-second sample buffer of polled progress updates — no server
  changes needed. Buffer resets on evaluation id or phase change.
- **3.B**: `/api/sessions/:id/errors` joins captures/comparisons with
  url_pairs and returns up to 500 entries per table. Frontend groups
  by exact `error_message` string. A first-render guard (`errors === null`)
  is required because the load effect runs after the first paint;
  without it the body de-references a null array.
- **3.C**: the in-process tracker (`services/worker-activity.ts`)
  mirrors the LM tracker's shape so Phase 6 can replace the data
  source without UI changes. Capacity is observed at runtime via
  `observeCapacity(n)` from capture/comparison; seed value is
  `availableParallelism()` from `node:os`.

### 3.A — Metrics redesign (S)

Replace the current button-label progress + cache-hits badge with a
persistent metrics row during evaluation.

- **Total / Remaining / Speed (items/sec, 30s rolling) / ETA**
- Server already streams plan progress (`evaluator.ts`); verify the
  shape includes per-tick timestamps. Add them if missing.
- New component in the bottom header zone
  (`SessionDetailPage.tsx:659–675`), replacing the existing summary.

### 3.B — Error log tab (S)

- New tab in the detail pane tab strip (`SessionDetailPage.tsx:944`),
  to the right of "URL pairs".
- Lists capture errors (already surfaced via `capture-failed` outcome)
  and comparison errors, grouped by type, with pair/URL/timestamp.
- Audit whether comparison errors are persisted; add minimal schema
  field if not.

### 3.C — CPU usage indicator (S, in-process version)

- Mirror `LmActivityHistogram.tsx` exactly.
- New endpoint `GET /api/worker-activity` returning capture/compare
  concurrency samples from in-process `createLimit`
  (`services/concurrency.ts:10`).
- New component `WorkerActivityHistogram` next to the LM histogram in
  `SessionDetailPage.tsx:638`.
- This version stays correct after Phase 6 — the endpoint just starts
  returning data from the worker pool instead.

**Phase 3 exit**: evaluation surface shows live throughput, errors
discoverable in one place, capture/compare load visible.


## Phase 4 — Routing consolidation (~1 week)

**Depends on**: nothing structurally, but easier to land after Phase 1
(less component churn). **Unblocks**: cleaner deep-links for Phase 5.

### 4.A — Session-scoped comparison route (M)

The only non-session-scoped route is `/comparisons/:id` (`App.tsx`).
It loads the session id from the comparison record and shows a
back-link, but the URL has no session context.

- Add `/sessions/:id/comparisons/:comparison_id` rendering the same
  ComparisonDetailPage with session context baked in.
- Keep `/comparisons/:id` as a redirect for existing share-links;
  redirect by looking up the comparison's session.
- Update internal `navigate()` calls to use the session-scoped form.

### 4.B — URL audit and consolidation (M)

- Sweep `SessionDetailPage` and `ClusterDetailPanel` for places that
  swap query params silently — ensure user-perceived view changes push
  history entries.
- Codify the URL schema: `mode`, `focus`, `cat` (from 2.A),
  `filters[...]`, view mode (from 2.D). Type the parser.
- Confirm refresh / share / back behave consistently.

**Phase 4 exit**: every distinct view in the session is bookmarkable
and reachable via back/forward; old `/comparisons/:id` links continue
to work.


## Phase 5 — Acceptance model & unified detail view (~1–2 weeks)

**Depends on**: Phase 4 (clean URL contract makes the unified view's
state simpler). 5.C depends on 5.A.

### 5.A — Accept single member (M)

Today acceptance is cluster-wide
(`ClusterDetailPanel.tsx:143` → `routes/clusters.ts:136`, fanning out
per-row via `acceptance_rules`). Add per-member acceptance.

- **API**: a cluster member *is* a result row — reuse row acceptance
  rather than inventing a parallel mechanism. Expose
  `POST /api/sessions/:id/results/:result_id/accept` if not already
  there.
- **UI**: "Accept member" action when a single member is focused;
  "Accept cluster" remains the broader action.
- **State display**: cluster-level state needs to account for partial
  acceptance — e.g. "Accepted (5/12)" with a visual cue distinct from
  full acceptance.
- **Decision** (resolve before implementation): does full member
  acceptance promote to cluster acceptance automatically? Probably no
  — they're different intents — but call it out.

### 5.B — Finish Split cluster (M)

UI placeholder at `ActionsMenu.tsx:256` ("Coming in a later phase").

- **API**: new `POST /api/sessions/:id/clusters/:cluster_id/split`
  taking a list of member result ids to move into a new cluster.
  Recomputes signatures for both halves.
- **UI**: split dialog — multi-select members, preview the new
  cluster's signature/category, confirm.
- Update keyboard nav (2.B) to handle the new cluster appearing.

### 5.C — Unified comparison detail view (M)

Two views today:
- Cluster context (`ClusterDetailPanel` → `ComparisonDetail` embedded):
  no row-level acceptance bar.
- Row context (`SessionDetailPage` Rows mode → `ComparisonDetail`):
  full acceptance bar.

Unify into a single component with context-aware acceptance UI:

- Image triple + LM output + metadata: identical, always shown.
- Acceptance UI:
  - Row context: full acceptance bar as today.
  - Cluster context with 5.A in place: per-member acceptance bar **plus**
    a banner showing cluster-level acceptance state.
- View mode (triple / A|B / slider) identical in both.
- Recapture single pair: works in both contexts.

**Phase 5 exit**: any comparison detail view shows the right
acceptance affordances for its context; clusters can be split;
per-member acceptance works.


## Phase 6 — Worker VM pool (multi-week, after design doc)

**Depends on**: §0 design doc. Phases 1–5 ship independently and the
in-process CPU indicator from 3.C remains valid after this lands.

### 6.A — Worker pool implementation (XL)

Per the §0 design doc. Rough shape:

- Define the worker RPC interface (capture pair, compare pair) at the
  current in-process boundary in `services/evaluator.ts`.
- Build the worker image: Playwright + ImageMagick.
- Wire up scheduling, scale-to-zero, retry across workers.
- Make `.shared/images` accessible to workers (shared volume or object
  store + per-job sync).
- Migrate API VM down to management-only sizing.

### 6.B — Wire worker telemetry into the CPU indicator (S)

- The `/api/worker-activity` endpoint from 3.C starts returning real
  worker pool data instead of in-process concurrency.
- No client-side change if the response shape is preserved.

**Phase 6 exit**: API VM is small and always-on; capture/compare
scales on demand; existing UI surface unchanged from the user's
perspective except the CPU indicator now reflects real worker load.


---

## Dependency map

```
Phase 0 (design)  →  Phase 2.E (Reject) + Phase 6 (worker pool)
Phase 1           →  (none — fully independent)
Phase 2           →  benefits from Phase 1 landing first to reduce conflicts
Phase 3           →  independent
Phase 4           →  benefits from Phase 1; unblocks Phase 5 deep-linking
Phase 5.A         →  prerequisite for 5.C
Phase 5.B         →  independent within Phase 5
Phase 5.C         →  depends on 5.A
Phase 6           →  depends on Phase 0 design doc
                  →  no UI changes if 3.C is already shipped
```

Parallel tracks if multiple people working:

- **Track A** (frontend): Phase 1 → Phase 2 → Phase 5
- **Track B** (full-stack): Phase 3 → Phase 4 → assist Phase 5
- **Track C** (infra, after §0 doc): Phase 6
