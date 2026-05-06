# Improved Visual Compare Plan

## Goal

Build a local-first monorepo web tool that imports paired URLs from CSV, captures screenshots across selected viewports, compares them with ImageMagick, and uses a local LM Studio vision model either as an explicit semantic mode or as a fallback when pixel-level equivalence lands in an ambiguous band. Store repeatable runs and content-addressed artifacts in SQLite, and expose results through a React UI with side-by-side images, diff overlays, and structured differences.

## Key Architecture Decisions

### Model Captures And Comparisons As Runs

Screenshots and visual comparisons are temporal artifacts. A URL pair is stable input, but every capture depends on time, browser settings, viewport, network state, cookies, and page behavior.

Add explicit run tables:

- `capture_runs`: one requested capture batch for a session.
- `comparison_runs`: one requested comparison batch.
- `jobs`: async execution records for progress, retries, and errors.

The first version can use an in-process queue, but the API should already be job-oriented so request handlers do not block while Playwright, ImageMagick, or LM Studio run.

### Use High-Level API Inputs

The user-facing comparison API should accept session, URL pairs, viewports, and equivalence level. It should not require callers to manually pick capture IDs.

Example:

```json
{
  "session_id": "session_123",
  "url_pair_ids": ["pair_1", "pair_2"],
  "viewports": ["mobile", "desktop"],
  "equivalence_level": "tolerant"
}
```

The backend resolves matching A/B captures for the requested run, pair, and viewport.

### Normalize Screenshots Before Pixel Comparison

Pixel comparison needs controlled capture conditions. Capture options should include:

- viewport dimensions and orientation
- device scale factor
- user agent
- locale and timezone
- reduced motion
- animation disabling
- viewport-only screenshots for v1
- wait strategy: `domcontentloaded` + `load` + `document.fonts.ready` (default), optional selector wait, optional `networkidle` opt-in
- optional selectors to hide before capture
- optional cookie/banner handling hooks

Defaults should favor repeatability over speed, but avoid `networkidle` as the default. Modern Playwright treats `networkidle` as flaky and discouraged: pages with persistent connections (analytics, sockets, polling) never reach idle, producing slow timeouts and false retries. Make `networkidle` opt-in for sites known to need it.

For v1, use viewport-only screenshots to avoid full-page height mismatches between URL A and URL B. Full-page screenshots can be added later with an explicit dimension policy: pad both images to the maximum width/height, crop both to the minimum width/height, or compare named regions.

The standard readiness sequence should be:

1. Navigate and wait for `domcontentloaded` and `load`.
2. Wait for `document.fonts.ready`.
3. If a wait selector is configured for the URL pair, wait for it.
4. Scroll to the bottom and back to trigger lazy-loaded assets.
5. Inject CSS to disable animations/transitions and hide common cookie banners or configured selectors.
6. Wait a short settle delay before capturing.
7. If `networkidle` is opted into, wait for it last with a short timeout.

Capture-run-wide settings (user agent, locale, timezone, reduced motion, default wait strategy) are stored once in `capture_runs.options_json`, not denormalized onto every `captures` row. Per-viewport dimensions live alongside the viewport name in the same options blob and are looked up by `viewport_name`.

### Bound Playwright Concurrency

Capture work must use one persistent browser instance and a bounded number of concurrent pages or contexts. Do not launch a browser per URL and do not run `N * viewports * sides` captures in an unbounded `Promise.all`.

Use a queue or `p-limit` with a configurable default concurrency around `3` to `5`.

### Store Multiple Comparison Metrics

Do not reduce ImageMagick output to one percentage too early. Store:

- changed pixel percentage (AE-based, primary threshold metric)
- RMSE or normalized distortion (diagnostic only)
- SSIM (perceptual similarity, used as a secondary signal for `tolerant`/`loose` levels)
- bounding box area percentage
- connected component count
- diff image content hash (path is derived from the hash, not stored)

Equivalence levels can still use simple thresholds initially, but storing richer metrics makes the system debuggable and easier to improve.

The user-facing pixel thresholds must be based on changed pixel percentage, not RMSE. Use ImageMagick absolute error count with a small fuzz factor, then divide by the total pixel count:

```text
magick compare -metric AE -fuzz 5% a.png b.png diff.png
```

RMSE can still be stored as a secondary diagnostic metric, but it should not drive "5% different" style decisions.

SSIM is added because AE + fuzz misclassifies text-heavy pages: antialiasing differences produce many single-pixel changes that AE counts even with `-fuzz 5%`. SSIM is computed via a separate `magick compare -metric SSIM` call and stored alongside the other metrics. For `tolerant` and `loose` levels, low changed-pixel-percentage combined with high SSIM should weight toward equivalent; the combined rule lives in the equivalence-decision module so it can be tuned with real data.

### Treat LM Output As Versioned Data

Semantic analysis should persist normalized and raw fields:

- `lm_model`
- `lm_prompt_version`
- `lm_summary`
- `lm_confidence`
- `lm_response_json`
- `lm_determined_equivalent`

This makes semantic results auditable when models, prompts, or LM Studio settings change.

### Use LM Studio As Fallback And Mode

LM Studio has two invocation paths:

- Semantic mode: always invoke LM Studio and let it make the final equivalence decision.
- Pixel ambiguity fallback: for threshold-based levels, invoke LM Studio only when the ImageMagick changed-pixel percentage lands inside a configured ambiguity band around the selected threshold.

Store why the LM was invoked with `lm_invocation_reason`, for example `semantic_mode`, `ambiguous_pixel_result`, or `manual_retry`.

Ambiguity bands should start as static configuration, then be revisited after real comparison data exists. A later self-improvement loop can inspect false positives/false negatives and recommend threshold or band changes, but the first implementation should log enough data to make that possible rather than trying to tune automatically.

## Equivalence Levels

Initial levels:

| ID | Name | Primary Decision |
| --- | --- | --- |
| `pixel-perfect` | Pixel Perfect | zero changed pixels |
| `strict` | Strict | very small pixel difference |
| `tolerant` | Tolerant | moderate pixel/layout variance accepted |
| `loose` | Loose | broad visual similarity accepted |
| `semantic` | Semantic | LM Studio decides content/purpose equivalence |

For `pixel-perfect` through `loose`, ImageMagick normally determines the final result. If the changed pixel percentage falls inside the configured ambiguity band for that level, LM Studio acts as a tiebreaker.

For `semantic`, ImageMagick still runs to produce metrics and a diff image, but LM Studio makes the final equivalence call and produces human-readable differences.

## Proposed Monorepo Structure

No dedicated `shared` package for v1. Cross-package types and constants live in `packages/api/src/types.ts` and `packages/api/src/constants/`, and are consumed from the web package via a TypeScript path alias (configured in `tsconfig.base.json`). If web ends up importing enough api code to feel awkward, promote a shared package later — until then the alias is enough and avoids a publishable third package with its own build.

```text
visual-compare/
  package.json
  tsconfig.base.json
  plans/
    in-progress/
  packages/
    api/
      src/
        index.ts
        types.ts
        db/
          client.ts
          schema.ts
          migrations.ts
        routes/
          sessions.ts
          capture-runs.ts
          comparison-runs.ts
          images.ts
          meta.ts
        services/
          queue.ts
          capture.ts
          imagick.ts
          lm.ts
          comparison.ts
          artifact-store.ts
        constants/
          viewports.ts
          equivalence.ts
      package.json
    web/
      src/
        main.tsx
        App.tsx
        api/
        components/
        pages/
      package.json
      vite.config.ts
```

## Revised SQLite Schema

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  csv_filename TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE url_pairs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  url_a TEXT NOT NULL,
  url_b TEXT NOT NULL,
  label TEXT,
  row_index INTEGER NOT NULL,
  raw_row_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(session_id, row_index)
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('capture', 'comparison')),
  status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'complete', 'error')),
  progress_current INTEGER NOT NULL DEFAULT 0,
  progress_total INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);

CREATE TABLE capture_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  options_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE captures (
  id TEXT PRIMARY KEY,
  capture_run_id TEXT NOT NULL REFERENCES capture_runs(id) ON DELETE CASCADE,
  url_pair_id TEXT NOT NULL REFERENCES url_pairs(id) ON DELETE CASCADE,
  side TEXT NOT NULL CHECK(side IN ('a', 'b')),
  url TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'complete', 'error')),
  screenshot_sha256 TEXT,
  screenshot_byte_size INTEGER,
  viewport_name TEXT NOT NULL,
  metadata_json TEXT,
  error_message TEXT,
  duration_ms INTEGER,
  captured_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(capture_run_id, url_pair_id, side, viewport_name)
);

CREATE TABLE comparison_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  capture_run_id TEXT NOT NULL REFERENCES capture_runs(id),
  job_id TEXT NOT NULL REFERENCES jobs(id),
  equivalence_level TEXT NOT NULL,
  options_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE comparisons (
  id TEXT PRIMARY KEY,
  comparison_run_id TEXT NOT NULL REFERENCES comparison_runs(id) ON DELETE CASCADE,
  url_pair_id TEXT NOT NULL REFERENCES url_pairs(id) ON DELETE CASCADE,
  capture_a_id TEXT NOT NULL REFERENCES captures(id),
  capture_b_id TEXT NOT NULL REFERENCES captures(id),
  viewport_name TEXT NOT NULL,
  equivalence_level TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'complete', 'error')),
  changed_pixel_percentage REAL,
  rmse REAL,
  ssim REAL,
  bounding_box_area_percentage REAL,
  connected_component_count INTEGER,
  im_diff_sha256 TEXT,
  im_diff_byte_size INTEGER,
  im_determined_equivalent INTEGER,
  lm_invocation_reason TEXT CHECK(lm_invocation_reason IN ('semantic_mode', 'ambiguous_pixel_result', 'manual_retry')),
  lm_model TEXT,
  lm_prompt_version TEXT,
  lm_summary TEXT,
  lm_confidence REAL,
  lm_response_json TEXT,
  lm_determined_equivalent INTEGER,
  is_equivalent INTEGER,
  error_message TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(comparison_run_id, url_pair_id, viewport_name)
);

CREATE TABLE differences (
  id TEXT PRIMARY KEY,
  comparison_id TEXT NOT NULL REFERENCES comparisons(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK(source IN ('imagick', 'lm')),
  description TEXT NOT NULL,
  severity TEXT CHECK(severity IN ('low', 'medium', 'high')),
  bounding_box_json TEXT,
  created_at TEXT NOT NULL
);
```

### Schema Notes

- `comparisons.is_equivalent` is logically NOT NULL when `status = 'complete'`. SQLite cannot express that conditional constraint cleanly without a trigger, so the invariant is enforced in the service layer instead of via a CHECK constraint.
- `differences.bounding_box_json` always stores bounding boxes as percentages of the source image (`{ x, y, width, height }` with each value `0`-`100`). LM responses already use percentages; ImageMagick connected-components output uses pixels and must be converted on insert using the diff image's pixel dimensions. This way the rendering layer never needs to know the source.
- Image content paths are derived from `*_sha256` columns at read time (`sha256/<first-2-hex>/<full-hash>.png`). They are not stored in the database.

### Migrations

Migrations are hand-rolled, sequential `.sql` files in `packages/api/src/db/migrations/` (e.g. `0001_init.sql`, `0002_add_ssim.sql`). A small applier in `migrations.ts` reads files in order, tracks applied versions in a `schema_migrations` table, and runs each pending file inside a transaction at startup. No external migration library for v1.

### Server Restart Recovery

The job queue is in-process, so a restart leaves any `running` jobs and their child `captures`/`comparisons` rows stranded. On boot, before the queue accepts new work, the API must:

1. Mark every `jobs` row with `status = 'running'` as `status = 'error'` with `error_message = 'interrupted_by_restart'` and set `completed_at`.
2. Mark every `captures` and `comparisons` row with `status = 'processing'` as `status = 'error'` with the same `error_message`.
3. Leave `pending` rows alone — they can be retried explicitly via the retry endpoints.

Resume-from-where-it-stopped is deferred; explicit retry is the v1 recovery story.

## Artifact Layout

Store image bytes by content hash so repeated identical screenshots and diff images do not duplicate files. Captures and comparisons remain distinct database records, but they can point to the same stored image.

```text
data/
  images/
    sha256/
      ab/
        abc123...def.png
```

The artifact store should expose a small service boundary:

```text
artifactStore.writeImage(tempPath) -> { sha256, byteSize }
artifactStore.pathFor(sha256) -> relativePath  // sha256/<first-2-hex>/<full-hash>.png
```

Implementation rules:

- Write browser and ImageMagick output to a temp path first.
- Hash the final normalized image bytes.
- Move the file into the content-addressed path if it does not already exist.
- Delete the temp file after the DB row records the hash.
- Keep capture/comparison identity separate from image identity.
- Do not eagerly delete content-addressed files. Add reference-counting or garbage collection later if needed.

Serve stored images with a static route:

```text
app.use('/images', express.static(DATA_IMAGES_DIR))
```

Database rows store only the content hash. API responses derive image URLs from the hash via `artifactStore.pathFor` and prepend the `/images/` route. There is one source of truth for path layout, so changing the layout is a one-line change.

## API Endpoints

```text
POST   /api/sessions                     Upload and validate CSV
GET    /api/sessions
GET    /api/sessions/:id
DELETE /api/sessions/:id

POST   /api/capture-runs                 Returns 202 + job_id
GET    /api/capture-runs?session_id=
GET    /api/capture-runs/:id
GET    /api/captures?session_id=&capture_run_id=&url_pair_id=
GET    /api/captures/:id
POST   /api/captures/:id/retry           Retry a single failed capture; 202 + job_id

POST   /api/comparison-runs              Returns 202 + job_id
GET    /api/comparison-runs?session_id=
GET    /api/comparison-runs/:id
GET    /api/comparisons?session_id=&comparison_run_id=&status=
GET    /api/comparisons/:id
POST   /api/comparisons/:id/retry        Retry a single comparison; 202 + job_id.
                                         Body may set lm_invocation_reason='manual_retry'
                                         to force LM Studio to re-decide.

GET    /api/jobs/:id

GET    /images/*

GET    /api/meta/viewports
GET    /api/meta/equivalence-levels
```

Retry endpoints reuse the same job model as full runs: each retry creates a new `jobs` row, transitions the targeted `captures` or `comparisons` row back through `processing` -> terminal status, and records the LM invocation reason so the audit trail shows it was a manual retry rather than a fresh run.

### Frontend transport

The web package talks to the API via Vite's dev-server proxy, configured in `packages/web/vite.config.ts`:

```ts
server: {
  proxy: {
    '/api':    'http://localhost:3001',
    '/images': 'http://localhost:3001',
  },
},
```

The frontend always uses relative paths (`/api/...`, `/images/...`). No CORS configuration is needed for local dev, no environment-variable base URL, and production builds can be served from any origin that proxies `/api` and `/images` to the API process.

CSV upload contract:

- Header row is required.
- Required columns: `url_a`, `url_b`.
- Optional column: `label`.
- Extra columns are preserved in `raw_row_json`.
- Each row is validated with zod.
- Upload responses include row-level errors and should not create a session unless all rows are valid.
- Per-row viewport overrides (e.g. a `viewports` column) are deferred. v1 applies the same viewport selection to every row in a capture run.

## Capture Pipeline

1. Accept the request, create a `jobs` row with type `capture`, and return `202 Accepted` with the job ID.
2. Create a `capture_runs` row whose `options_json` holds the selected URL pairs, the full viewport definitions (name, width, height, orientation, deviceScaleFactor), and capture-wide settings (user agent, locale, timezone, reduced motion, default wait strategy).
3. Insert pending `captures` rows for every URL pair, side, and viewport, storing only `viewport_name` per row.
4. Worker marks job and capture rows as running.
5. A bounded Playwright worker captures each screenshot with normalized settings, looking up viewport dimensions and run-wide settings from `capture_runs.options_json`.
6. Write each screenshot to a temp path, pass it through `artifactStore.writeImage`, and store the returned `screenshot_sha256` and `screenshot_byte_size` on the captures row.
7. Mark each capture `complete` or `error` independently.
8. Mark job `complete` when all captures have terminal status.

Partial failures should be visible in the UI and should not invalidate successful captures from the same run. Failed captures can be retried individually via `POST /api/captures/:id/retry`.

## Comparison Pipeline

1. Accept the request, create a `jobs` row with type `comparison`, and return `202 Accepted` with the job ID.
2. Create a `comparison_runs` row linked to a completed capture run.
3. Insert pending `comparisons` rows for each selected pair and viewport with complete A/B captures.
4. Run ImageMagick absolute error for every comparison:

   ```text
   magick compare -metric AE -fuzz 5% a.png b.png diff.png
   ```

5. Divide the absolute error count by the total pixel count to calculate `changed_pixel_percentage`.
6. Run a second compare for SSIM as a perceptual signal:

   ```text
   magick compare -metric SSIM a.png b.png null:
   ```

   Store the value in `comparisons.ssim`. RMSE may also be captured as a diagnostic but does not drive thresholds.
7. Store the generated diff image through `artifactStore.writeImage` and persist `im_diff_sha256` and `im_diff_byte_size`.
8. Extract connected components from the diff image. Prefer the JSON output mode if the pinned ImageMagick version supports it:

   ```text
   magick diff.png -threshold 1% -define connected-components:format=json \
     -connected-components 8 null:
   ```

   Fall back to the verbose text format only if JSON is unavailable. The text format is version-sensitive — pin the ImageMagick version in documentation, write a tolerant parser, and back it with fixture-based snapshot tests checked in **before** the parser is wired into the comparison pipeline. This is the highest-risk parsing surface in the system.

9. Convert each connected-component bounding box from pixels to percentages using the diff image's dimensions, then store metrics, diff image hash, and ImageMagick differences. ImageMagick differences may have null severity.
10. For threshold-based levels, decide equivalence directly when the changed pixel percentage is clearly below or above the configured threshold. For `tolerant` and `loose` levels, the decision module may also consider SSIM (high SSIM with low changed-pixel-percentage strengthens the equivalent verdict).
11. For threshold-based levels inside the ambiguity band, call LM Studio with `lm_invocation_reason = 'ambiguous_pixel_result'` and use the LM result as the tiebreaker.
12. For semantic level, call LM Studio with `lm_invocation_reason = 'semantic_mode'`.
13. Parse structured JSON, store normalized LM fields, store LM differences, and set final equivalence.

For v1, screenshots should already have equal dimensions because capture is viewport-only. If full-page capture is later enabled, the comparison pipeline must normalize dimensions before ImageMagick compare by padding, cropping, or comparing configured regions.

Failed comparisons can be retried individually via `POST /api/comparisons/:id/retry`. Passing `lm_invocation_reason='manual_retry'` in the body forces the LM step to re-run regardless of the equivalence level.

## LM Studio Contract

Use the OpenAI SDK pointed at local LM Studio:

```text
baseURL: http://localhost:1234/v1
```

Local models do not reliably produce strict JSON from prompt instructions alone. Use LM Studio's OpenAI-compatible structured-output mode and pass an explicit JSON schema:

```ts
const response = await client.chat.completions.create({
  model,
  messages,
  response_format: {
    type: 'json_schema',
    json_schema: {
      name: 'visual_compare_result',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['equivalent', 'confidence', 'summary', 'differences'],
        properties: {
          equivalent: { type: 'boolean' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          summary:    { type: 'string' },
          differences: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['description', 'severity', 'boundingBox'],
              properties: {
                description: { type: 'string' },
                severity:    { type: 'string', enum: ['low', 'medium', 'high'] },
                boundingBox: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['x', 'y', 'width', 'height'],
                  properties: {
                    x:      { type: 'number', minimum: 0, maximum: 100 },
                    y:      { type: 'number', minimum: 0, maximum: 100 },
                    width:  { type: 'number', minimum: 0, maximum: 100 },
                    height: { type: 'number', minimum: 0, maximum: 100 },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
});
```

Validate the parsed payload with zod before persisting. If the loaded model rejects `response_format` or returns a malformed payload, fall back to a tolerant JSON extractor (find the first `{`, find the matching `}`, parse, validate). Record the path taken in `lm_response_json` along with the raw text so failures are diagnosable later.

Expected payload shape:

```json
{
  "equivalent": true,
  "confidence": 0.87,
  "summary": "The pages communicate the same content and purpose.",
  "differences": [
    {
      "description": "Hero button text differs.",
      "severity": "medium",
      "boundingBox": { "x": 12, "y": 34, "width": 20, "height": 8 }
    }
  ]
}
```

Bounding boxes are percentages of the image (0-100), matching how ImageMagick boxes are normalized on insert. The rendering layer can treat both sources identically.

## Frontend Flow

1. Dashboard: sessions with latest capture/comparison status.
2. New Session: CSV upload, validation, preview, and session creation.
3. Session Detail: URL pairs, run history, and capture status.
4. Capture Setup: select viewports and capture options.
5. Comparison Setup: select capture run, URL pairs, viewports, and equivalence level.
6. Comparison Runs: batch progress and filters.
7. Comparison Detail: side-by-side screenshots, diff toggle, bounding boxes, differences list, and LM analysis when available.

The UI should poll `GET /api/jobs/:id` while jobs are active. Server-sent events can be added later if polling becomes noisy.

## Build Order

Build a vertical slice before expanding breadth:

1. Root workspace, TypeScript config, and local shared types through path aliases rather than a dedicated shared package.
2. SQLite client, migrations, and core schema.
3. Strict CSV import for one session with one or more URL pairs.
4. Job model and in-process queue.
5. Content-addressed artifact store and static `/images` route.
6. One-viewpoint capture run for a single URL pair using bounded Playwright concurrency.
7. One ImageMagick comparison run using AE percentage and connected-components extraction.
8. Minimal comparison detail page rendering screenshot A, screenshot B, diff image, and differences.
9. Expand to multiple URL pairs and all configured viewports.
10. Add ambiguity-band LM fallback.
11. Add semantic mode.
12. Add dashboard, run history, filters, retry affordances, and failure states.

## Verification Plan

### Automated tests

The tool's value is correctness of comparisons, so the verification surface cannot be only manual. Required test layers:

- **Unit tests** for pure logic: AE-count → changed-pixel-percentage math, ambiguity-band decision (level + metrics → equivalent/invoke-LM), CSV row validation (zod schema), LM JSON parsing including the tolerant fallback path, IM pixel-bounding-box → percentage conversion.
- **Parser snapshot tests** for connected-components output. Capture real `magick`-emitted JSON (and the verbose text fallback) for a small set of fixture diffs into `__fixtures__/connected-components/` and lock them down with snapshots. These run before the parser is allowed near real comparisons.
- **Image fixture tests** for the comparison pipeline. Maintain a small set of known A/B image pairs in `__fixtures__/comparisons/` covering: identical pairs, single-pixel difference, text-antialiasing-only difference, large layout difference, color-shifted-but-perceptually-similar pair. Each fixture asserts expected `changed_pixel_percentage`, `ssim`, and equivalence outcomes per level. These catch regressions in the metric pipeline.
- **API integration tests** against an in-memory SQLite database, covering: CSV upload happy path and row-level errors, capture-run lifecycle with a stubbed Playwright capturer, comparison-run lifecycle with stubbed LM Studio, retry endpoints, and server-restart recovery (insert `running` rows, restart, assert they flip to `error`).
- **LM Studio tests** are gated behind an env flag (`LM_STUDIO=1`) and skipped in CI by default. They hit a real local model and verify the structured-output path produces a schema-valid payload.

### Manual end-to-end

Backend:

- Start API on port `3001`.
- Import a CSV with two URL pairs.
- Create a capture run for mobile, tablet, and desktop.
- Confirm successful screenshots exist in the content-addressed store.
- Confirm failed URLs produce failed capture rows without failing the entire run, and that retrying a failed capture clears the error.
- Create a non-semantic comparison run and verify metrics (changed-pixel-percentage, SSIM, RMSE), diff image, final equivalence, and differences rows.
- Create a semantic comparison run with LM Studio running locally and verify normalized LM fields and raw response storage.
- Restart the API mid-run and confirm previously-running rows are marked `error` with `error_message = 'interrupted_by_restart'`.

Frontend:

- Start Vite on port `5173`. Verify the proxy routes `/api` and `/images` to the API.
- Create a session from CSV.
- Start a capture run and watch progress update.
- Start a comparison run and watch progress update.
- Open a comparison detail page and verify images, diff overlay, bounding boxes, and differences list.
- Verify semantic comparisons show LM summary and raw response details.
- Trigger a retry from the UI and confirm the row transitions through `processing` to a fresh terminal status.

## v1.5 Priorities

The following items are out of scope for v1 but should be the first features added once v1 is stable, because they unblock real-world use rather than polish it.

### Per-Session Cookies and Storage State

Most real URL pairs sit behind some combination of basic auth, cookie walls, login walls, or A/B-test cookies. v1's "optional cookie/banner handling hooks" only covers pages that show a banner. Auth-gated pages will block capture entirely.

Sketch of the v1.5 model:

- Add `sessions.storage_state_json` (nullable TEXT). Stores a Playwright `storageState`-shaped JSON blob: `{ cookies: [...], origins: [{ origin, localStorage: [...] }] }`.
- New endpoint `PUT /api/sessions/:id/storage-state` accepts the JSON and validates with zod.
- The capture worker passes `storageState` to `browser.newContext({ storageState })` when present.
- UI affordance: a "Paste storage state" textarea on the session detail page, plus a short doc explaining how to capture it from a logged-in browser using `npx playwright codegen` or DevTools.
- Treat the JSON as sensitive. Do not log it; redact in error messages; mark the column for exclusion from any future export feature.

### Other v1.5 candidates

- Selector-based visual masking UI (currently configurable in `options_json` but not editable in the UI).
- Retry-from-UI affordances on the comparison detail page.

## Deferred Work

- Per-row viewport overrides in the CSV (e.g. a `viewports` column controlling which viewports apply to each row).
- Persistent background worker process.
- Server-sent events or WebSocket progress updates.
- Resume-from-where-it-stopped on server restart (v1 marks interrupted work as error and requires explicit retry).
- Authentication for the tool itself.
- Browser profile management.
- Per-page stabilization scripts.
- Baseline history and trend reporting.
- Self-tuning ambiguity bands based on observed false-positive/false-negative rates.
