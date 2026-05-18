# Fresh Context Implementation Prompt

You are working in `/Users/bdbrodie/dev/portals/visual-compare/plan-improved-visual-compare` on branch `plan-improved-visual-compare`.

**Read the plan first** — it is the source of truth and has been updated past prior versions of this prompt:

`plans/in-progress/improved-visual-compare-plan.md`

If anything below contradicts the plan, the plan wins. This prompt only highlights the decisions you are most likely to forget mid-implementation.

## Product Goal

Build a local-first monorepo web tool that:

1. Imports paired URLs from CSV.
2. Captures viewport-only screenshots with Playwright.
3. Stores image files through a content-addressed artifact store.
4. Compares screenshots with ImageMagick using changed-pixel-percentage based on `AE`, with SSIM stored alongside as a perceptual signal.
5. Stores results and structured differences in SQLite.
6. Displays one comparison detail page in React with screenshot A, screenshot B, diff image, and differences.

LM Studio support is planned but comes after the non-LM vertical slice works end to end.

## Important Decisions Already Made

Architecture and storage:

- No separate `packages/shared` workspace. Cross-package types live in `packages/api/src/types.ts` and constants in `packages/api/src/constants/`, exposed to web via a TypeScript path alias in `tsconfig.base.json`.
- Use one persistent Playwright browser with bounded page/context concurrency (default `3`–`5`).
- Capture viewport-only screenshots for v1 to avoid dimension mismatch.
- API requests that start capture or comparison work return `202 Accepted` with a `job_id`. Use an in-process queue.
- Content-addressed image storage under `data/images/sha256/<first-2-hex>/<full-hash>.png`. The artifact store exposes `writeImage(tempPath) -> { sha256, byteSize }` and `pathFor(sha256) -> relativePath`.
- **Database rows store only the hash, never the path.** Paths are derived at read time. This applies to `captures.screenshot_sha256` and `comparisons.im_diff_sha256`.
- Use `crypto.randomUUID()` for IDs; do not add a UUID dependency.
- Migrations are hand-rolled sequential `.sql` files in `packages/api/src/db/migrations/`, applied in transaction at startup, tracked in a `schema_migrations` table. No external migration library.

Capture-run shape:

- Capture-run-wide settings (user agent, locale, timezone, reduced motion, default wait strategy, full viewport definitions including width/height/orientation/deviceScaleFactor) live in `capture_runs.options_json`. Do **not** denormalize these onto every `captures` row — `captures` carries `viewport_name` only and looks up the rest.

Wait strategy:

- **Default readiness sequence**: `domcontentloaded` + `load` → `document.fonts.ready` → optional configured selector → scroll bottom/top to trigger lazy assets → inject CSS to disable animations and hide configured banners → short settle delay.
- `networkidle` is **opt-in only**, not the default. It is flaky on pages with persistent connections.

Pixel comparison:

- Run `magick compare -metric AE -fuzz 5% a.png b.png diff.png`, divide AE by total pixel count for `changed_pixel_percentage` (the primary threshold metric).
- Run `magick compare -metric SSIM a.png b.png null:` and store in `comparisons.ssim` as a perceptual signal. RMSE is diagnostic-only.
- For connected-components, **prefer JSON output** (`-define connected-components:format=json`) when the pinned IM version supports it; fall back to verbose text only if needed. Whichever path is used, write fixture-based snapshot tests for the parser **before** wiring it into the comparison pipeline.
- Convert IM pixel bounding boxes to percentages on insert, using the diff image's dimensions. `differences.bounding_box_json` always stores percentages (0–100), regardless of `source`.

LM Studio (later — not for the first slice):

- Use OpenAI-compatible `response_format: { type: 'json_schema', json_schema: { strict: true, ... } }`. Validate with zod. Tolerant JSON-extraction fallback only if the model rejects `response_format`.

Frontend transport:

- Vite proxies `/api` and `/images` to `http://localhost:3001`. The web app uses relative paths only — no env-var base URL, no CORS config.

Server restart recovery:

- On boot, before the queue accepts work: mark every `running` job and every `processing` capture/comparison as `error` with `error_message = 'interrupted_by_restart'`. Leave `pending` rows alone — they're retried explicitly.

Schema enforcement notes:

- `comparisons.is_equivalent` is enforced as logically NOT NULL when `status = 'complete'` in the service layer, not via a CHECK constraint (SQLite can't express that cleanly).

## First Vertical Slice

Implement the smallest end-to-end flow. Do **not** build every page or every feature before proving the integration path.

1. Scaffold the root npm workspace with `packages/api` and `packages/web`. Configure the path alias for cross-package types.
2. Add SQLite client, migrations applier, `schema_migrations` table, and `0001_init.sql` with the full schema from the plan.
3. Implement startup recovery (mark interrupted runs as error) before the queue starts.
4. Add session creation from CSV upload:
   - header row required; required columns `url_a`, `url_b`; optional `label`
   - validate rows with zod, preserve extras in `raw_row_json`
   - reject the upload if any row is invalid
5. Add the in-process job queue and `jobs` lifecycle.
6. Add the content-addressed artifact store and the `/images` static route. Store hash + byte size only.
7. Add one capture-run path:
   - one persistent browser, bounded page/context concurrency
   - run-wide settings and viewport definitions in `capture_runs.options_json`
   - use the default readiness sequence (no `networkidle`)
   - per-capture row stores `viewport_name` and the resulting `screenshot_sha256` / `screenshot_byte_size`
8. Add one comparison-run path (no LM yet):
   - find matching complete A/B captures by pair + viewport
   - run AE compare → `changed_pixel_percentage`
   - run SSIM compare → `comparisons.ssim`
   - store diff image through artifact store as `im_diff_sha256`
   - extract connected components (JSON output preferred), convert pixel boxes to percentages, insert into `differences`
   - decide equivalence from the configured threshold
9. Add minimal React UI behind the Vite proxy:
   - upload CSV → session
   - start one capture run, poll job status
   - start one comparison run, poll job status
   - one comparison detail view: A, B, diff, differences list (rendered using the percentage bounding boxes)

LM Studio integration, retry endpoints, the dashboard, run history, and storage-state upload (v1.5) all come **after** this slice is green.

## Tests Required Alongside Implementation

The plan's Verification section is binding. At minimum, ship these with the first slice:

- Unit tests for AE→percentage math, IM pixel→percentage box conversion, CSV zod validation.
- Snapshot tests for the connected-components parser, against captured `magick` output fixtures.
- A small image-fixture set (identical / 1-pixel diff / antialiasing-only / large layout diff) asserting expected metrics and equivalence per level.
- API integration tests against an in-memory SQLite covering CSV upload, capture-run lifecycle (stubbed Playwright), comparison-run lifecycle, and the startup recovery path.

LM Studio tests are gated behind `LM_STUDIO=1` and skipped in CI by default.

## Verification Before Stopping

- Install dependencies.
- Typecheck and run unit/integration tests.
- Start the API on `3001` and Vite on `5173`. Confirm the Vite proxy routes `/api` and `/images`.
- Run a manual smoke: upload a tiny CSV, start a capture run against two simple URLs at one viewport, start a comparison run, open the detail page.

If ImageMagick, Playwright browser binaries, or network access are missing, report the exact blocker and the command needed to continue. Do not silently skip steps.
