# Worker VM pool

Decouple capture (Playwright) and comparison (ImageMagick) work from
the API process. Today both run in-process under `createLimit()` from
`services/concurrency.ts`; that forces the API VM to be sized for peak
CPU + memory + browser footprint, which is wasteful when no evaluation
is running. Target shape: API VM stays small and always-on; capture +
compare execute on an on-demand worker pool that can scale to zero.

This was Phase 6 of `plans/completed/refactoring-plan.md`. Extracted
into its own plan because it's a multi-week infra change that's
qualitatively different from the UI/data-model work in Phases 1–5,
and because it needs a design doc before implementation starts.

## Status

**Design**. Phases 1–5 of the parent refactor shipped on `main`
(commits 18bfecd → 1af747b). The in-process pieces this plan will
swap for remote calls are stable and tested.


## What's already in place

The refactor's earlier phases laid down seams that make the worker
extraction tractable:

- **`WorkerActivityTracker`** (`services/worker-activity.ts`, shipped
  in Phase 3.C). Mirrors the LM activity tracker's shape. Tracks
  in-flight count + observed capacity, exposed at
  `GET /api/meta/worker-activity`. The UI already polls this; the
  data source is the only thing that changes when the pool lands.
- **`createLimit()`** (`services/concurrency.ts`). Both capture
  (`services/capture.ts:388`) and comparison
  (`services/comparison.ts:301`) wrap their per-item work in
  `limit(async () => …)`. That callback boundary is the natural RPC
  seam — the body becomes "dispatch to a worker, await result"
  instead of "run in-process".
- **`workerActivity.trackCall()`** is already called at that
  boundary, so once the worker is remote the telemetry continues to
  reflect real load (in-flight calls = in-flight dispatches).
- **`EvaluatorDeps.workerActivity`**, **`CaptureRunDeps.workerActivity`**,
  **`ComparisonRunDeps.workerActivity`** are wired top-to-bottom — no
  prop drilling needed when we introduce a `workerClient`.
- **Shared image store**: `.shared/images` is a content-addressed
  store with worktree-scoped symlinks (`scripts/share-images-dir.sh`).
  Workers need read+write access; this plan decides how.


## Open design questions

These need resolution in a short design doc before §A implementation
starts. The doc can live alongside this file or as a section appended
below.

### Q1. Transport — HTTP RPC, queue, or both?

- **HTTP RPC**: API calls worker directly. Synchronous from the
  caller's perspective; result returns in the response. Simple, no
  intermediary, but requires the API to track worker liveness +
  retries itself.
- **Queue (Redis/SQS-style)**: API enqueues a job, worker pulls it,
  result lands via callback or polling. Decoupled lifecycle, natural
  retry, but adds an extra system to operate and complicates the
  "await this single capture" model the evaluator currently uses.
- **Hybrid**: queue for dispatch + status, RPC for the actual capture
  invocation once a worker is leased. Probably overkill at this
  scale.

Recommendation to evaluate: start with HTTP RPC and a small in-API
scheduler. If we hit reliability issues, swap to a queue.

### Q2. Shared image storage

Workers produce capture PNGs and (for comparison) read both sides plus
write the imagick diff. Options:

- **Shared volume mount** (e.g., Scaleway Block Storage attached to
  every worker). Same filesystem paths as today; least code change.
  Constrains workers to one region.
- **Object store** (S3-style). Workers upload outputs, API downloads
  on demand. More portable, more code, more latency.
- **Per-job sync**: API hands the worker the input shas to download
  before work, worker uploads outputs at the end. Bandwidth-heavy
  but isolates workers from any persistent storage.

Recommendation to evaluate: shared volume if all workers stay in the
same region as the API; object store otherwise.

### Q3. Scale-to-zero policy

When should workers spin down? Options:

- After N seconds of an empty queue.
- After a session's evaluation finishes (with grace period).
- Always-on N small workers, burst pool above that.

Trade-off: cold start adds latency to "click Evaluate". For 100-pair
sessions that take minutes the cold start is invisible; for small
ones it'd be noticeable.

### Q4. Cross-worker retry semantics

In-process today, `createLimit()` retries within the same process via
the planner re-running on the next tick. Across workers we need to
distinguish:

- Transient worker failure (crashed VM, network hiccup): re-queue the
  work item on a different worker.
- Permanent failure (the page itself returns 500): record the error
  on the capture/comparison row, don't retry.

The `error_message` column on `captures` and `comparisons` already
captures the permanent case. The transient case needs an explicit
re-queue path.

### Q5. Observability

What signals does the API need to keep the existing UI useful?

- Per-worker in-flight count (feeds the WorkerActivityHistogram).
- Queue depth (when applicable, for the evaluation metrics row).
- Per-job duration (already captured on the comparison row).
- Worker pool size + capacity ceiling.

The DTO at `/api/meta/worker-activity` already has `samples`,
`capacity`, `interval_ms`. Capacity becomes "sum of worker
concurrency caps"; samples become "summed in-flight count across all
workers."


## A. Worker pool implementation (XL)

Per the §Q resolutions. Rough shape:

1. **Define the worker RPC interface.** Two methods:
   - `captureOne(input)` — produces a capture row + uploaded screenshot.
     The existing `runOneCapture` in `services/capture.ts` is the
     in-process equivalent.
   - `compareOne(input)` — produces a comparison row + diff regions
     + optional diff PNG. The existing `runOneComparison` in
     `services/comparison.ts` is the in-process equivalent.

   Each method's input/output is a JSON-serialisable shape. The
   current functions take `Db` + table rows; the RPC versions take
   the bare data the worker needs (urls, viewport, capture opts) and
   return what the API writes back into the DB.

2. **Build the worker image.** Container with:
   - Playwright + Chromium bundled.
   - ImageMagick 7 (matches `Harden Scaleway deploy` commit ab49c5d's
     pin).
   - A tiny HTTP/queue listener exposing `captureOne` / `compareOne`.
   - Shared-image-store access per Q2's decision.

3. **API-side worker client.** New module (e.g.
   `services/worker-client.ts`) that hides the transport. Wraps an
   RPC call, exposes the same `captureOne` / `compareOne` interface
   the in-process implementation has today, plus a `dispatch()` that
   manages pool leasing.

4. **Cut the seam in `services/capture.ts` and `services/comparison.ts`.**
   Inside the `limit(async () => …)` callback, replace the direct
   `runOneCapture(…)` / `runOneComparison(…)` call with
   `workerClient.captureOne(…)` / `workerClient.compareOne(…)`. The
   `workerActivity` tracking + cancel-on-signal logic stays as-is —
   they're already at the right level.

5. **Scheduler.** Tracks the worker pool: ready, leased, draining,
   stopped. When a `dispatch()` call comes in, picks a ready worker
   or spins up a new one (within the pool cap). When all jobs drain,
   workers idle out per Q3's policy.

6. **Retry + failure handling per Q4.**

7. **Migrate the API VM down to management-only sizing.** Smaller
   instance, no Chromium / ImageMagick installation.


## B. Telemetry wire-up (S)

Should be trivial after §A:

- `WorkerActivityTracker` keeps its current interface
  (`trackCall()` + `observeCapacity(n)`).
- The capture/comparison services keep calling `trackCall()` around
  the `dispatch` call — which now blocks on a remote worker, but
  that's still the right "in-flight" semantic.
- `observeCapacity(n)` gets the pool's total concurrency cap instead
  of `options.concurrency` for a single in-process run.
- `/api/meta/worker-activity` returns the same DTO. The frontend
  (`WorkerActivityHistogram`) doesn't change.


## Exit criteria

- API VM is small and always-on; capture/compare scales on demand.
- An evaluation behaves identically to a user: click Evaluate, watch
  progress, get verdicts. The CPU indicator now reflects real pool
  load instead of in-process concurrency.
- All existing tests pass against either the in-process implementation
  (preserved as a fallback for tests + local dev) or a fake
  workerClient that drives the same code path through-mocks.


## Recommended sequence

1. Resolve Q1–Q5 in a short design pass; append decisions here.
2. Sketch the `workerClient` interface and refactor capture/comparison
   to use it (with the in-process implementation as the only backend
   initially). Lands no behaviour change; just introduces the seam.
3. Build the worker image + remote client. Land behind a feature
   flag so the in-process path stays default.
4. Run a side-by-side comparison: same session evaluated both ways,
   verify identical outputs.
5. Flip the flag in staging, then production.
6. Down-size the API VM.
7. Delete the in-process implementation (or keep for local dev — see
   exit criteria).
