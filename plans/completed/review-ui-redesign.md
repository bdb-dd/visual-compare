# Review UI Redesign

## Goal

Improve human iteration speed when reviewing comparison results. The primary bottleneck is that reviewing N comparisons currently requires N full-page navigations, no visual scanning, and no keyboard flow. At 50+ comparisons this is meaningfully slow; at 200+ it is genuinely painful.

## Core insight

Visual judgment ("is this a real issue?") is faster with images than with numbers. A diff thumbnail with a red splotch is recognisable in ~200ms. Reading changed % and SSIM and deciding whether to click through takes several seconds. The redesign must put images first.

---

## Proposed layout

### Session page — two-panel review mode

Once a comparison run has results, the session page shifts into a review layout. The workflow controls collapse to a summary bar; the full viewport is given to the review UI.

```
┌─────────────────────────────────────────────────────────────────────┐
│ ← Sessions   Session name                                           │
│ Captured: desktop, mobile · Compared: tolerant  [New run ▾]         │
├──────────────────┬──────────────────────────────────────────────────┤
│  Filter: All ▪ Failed · Passed          Sort: Failed first ▾        │
│  ──────────────────                                                  │
│  [diff thumb] label       │  Side A          Side B         Diff    │
│  desktop  ✗  4.21%        │  ┌──────────┐  ┌──────────┐  ┌───────┐ │
│  ──────────────────       │  │          │  │          │  │       │ │
│  [diff thumb] label       │  │          │  │          │  │       │ │
│  mobile   ✗  1.83%        │  └──────────┘  └──────────┘  └───────┘ │
│  ──────────────────       │                                          │
│  [diff thumb] label       │  Changed: 4.213%   SSIM: 0.9821         │
│  desktop  ✓  0.00%        │  Equivalent: No · Level: tolerant       │
│  ──────────────────       │                                          │
│  ...                      │  [LM notes if present]                  │
│                           │  [Differences list]                     │
└──────────────────┴──────────────────────────────────────────────────┘
```

**Left panel (~320px, fixed)**
- Scrollable list of all comparisons for the active comparison run
- Each row: 72px diff thumbnail | pair label | viewport badge | changed % | pass/fail chip
- Default sort: non-equivalent first, then changed % descending
- Filter toggle: All | Failed | Passed
- Selected row is highlighted; clicking updates the right panel

**Right panel (fills remaining width)**
- Three-image grid: Side A | Side B | Diff (same layout as current ComparisonDetailPage)
- Metrics strip below images: changed %, SSIM, bounding box area, component count, final verdict
- LM details section if LM was invoked
- Differences list
- Updates in place — no page navigation

### Workflow controls — collapsed summary bar

After a capture or comparison run exists, the "1. Capture" and "2. Compare" cards collapse to a single bar:

```
Captured: desktop, mobile  (run 3b2a1f · 5 min ago)   [Recapture ▾]
Compared: tolerant  (run 9c4d2e · 4 min ago)            [Recompare ▾]
```

Clicking "Recapture ▾" or "Recompare ▾" expands a dropdown/panel with the existing controls. This keeps the top of the page clean so the review area starts high on screen.

The full expanded workflow cards remain the default when no runs exist yet.

### Keyboard navigation

When the left panel is focused (or by default once results are loaded):

| Key | Action |
|-----|--------|
| `j` / `↓` | Next comparison |
| `k` / `↑` | Previous comparison |
| `f` | Toggle filter: cycle All → Failed → Passed |
| `Escape` | Deselect / return focus to list |

No modal or lightbox — the split-panel avoids the need for one.

### History section

The existing "Run history" card (capture runs + comparison runs) remains accessible but moves below the review panel, or into a collapsible "History" section. Clicking "Load" on a history entry populates the left panel with that run's comparisons and resets the selected item to the first one.

---

## What changes

### New components

- `ComparisonList` — the scrollable left panel; props: `comparisons`, `selected id`, `onSelect`, `filter`, `onFilterChange`
- `ComparisonDetail` — the right panel; props: `comparison id` (fetches its own detail, or accepts pre-fetched data)
- `WorkflowBar` — the collapsed summary bar with expand affordance

### Modified pages/components

- `SessionDetailPage` — restructured into the two-panel layout; conditionally renders WorkflowBar (collapsed) vs. expanded workflow cards
- `ComparisonDetailPage` — keep as-is for deep-link access (direct URL to `/comparisons/:id`); it can reuse `ComparisonDetail` internally

### New CSS

- Two-column grid for the review layout (`display: grid; grid-template-columns: 320px 1fr`)
- Left panel: fixed height with `overflow-y: auto`; `position: sticky top` for filter bar
- Thumbnail in list rows: `72px × 72px`, `object-fit: cover`, content-addressed from `im_diff_url`
- Selected row highlight using existing card/border tokens

### API changes

None required. All necessary data is already available:
- `GET /api/comparison-runs/:id` returns all `ComparisonDto[]` with `im_diff_url`
- `GET /api/comparisons/:id` returns the full detail needed for the right panel

---

## Open questions

1. **Thumbnail source** — `im_diff_url` gives the full-size diff image. The browser will scale it down with CSS. We could add a server-side thumbnail endpoint later if performance is a concern, but CSS scaling should be fine for initial implementation.

2. **Right panel loading state** — clicking a new row will trigger a fetch for `ComparisonDetailDto`. Should show a skeleton or spinner while loading. Could pre-fetch adjacent items for snappier keyboard nav.

3. **Viewport grouping** — if a session has multiple viewports, comparisons for the same URL pair appear as separate rows. An optional "group by pair" mode could cluster them. Deferred for now; the sort order (failed first) mitigates this.

4. **`ComparisonDetailPage` as deep link** — it should remain functional as a standalone page so direct URLs work. It can simply render `ComparisonDetail` in a full-page wrapper. No regression.

5. **Mobile / narrow screens** — the two-panel layout collapses badly below ~900px. Acceptable for a desktop-first internal tool; can be addressed later.

---

## Implementation order

1. Extract `ComparisonDetail` component from `ComparisonDetailPage` (pure refactor, no behaviour change)
2. Build `ComparisonList` component with thumbnail, filter bar, and selection state
3. Build `WorkflowBar` collapsed summary component
4. Restructure `SessionDetailPage` into two-panel layout, wiring up list → detail
5. Add keyboard navigation to `ComparisonList`
6. Update `ComparisonDetailPage` to use extracted `ComparisonDetail` component
