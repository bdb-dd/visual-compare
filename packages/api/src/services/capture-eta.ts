import type { Db } from '../db/client.js';

/**
 * Per-(pair, viewport) ETA for the session's currently in-flight capture
 * run. The pair's ETA is `max(eta_a, eta_b)` — the comparison can't
 * dispatch until both sides have landed. Each side's wait is approximated
 * as `ceil(rank / concurrency) * avg_duration_ms`, where rank is the
 * FIFO position within (pending + processing) captures of that side in
 * the run.
 *
 * Modeling caveats (good-enough approximation, not a precise estimate):
 *   - In-flight captures get rank 1..concurrency and are charged a full
 *     avg_duration (slight overestimate; they're already partway).
 *   - We don't model concurrent runs on the same worker pool, so two
 *     active recaptures across sessions make ETAs optimistic.
 *   - Falls back to a session-wide rolling average when the current run
 *     hasn't completed enough captures to derive a meaningful in-run
 *     average; falls back to `null` when neither source has data, and
 *     the UI omits the ETA chip in that case.
 */

export interface MemberEta {
  /** ms until the pair's comparison can dispatch (max across both sides). */
  eta_ms: number;
  /** Worst-side rank in (pending + processing) of its side within the run. */
  rank: number;
  /** Sides still in flight; empty means the pair is no longer stale. */
  sides: ('a' | 'b')[];
}

export interface CaptureEta {
  /** Capture run that's currently in flight for the session, if any. */
  run_id: string | null;
  /** Worker concurrency for this run; null when no in-flight run. */
  concurrency: number | null;
  /** Average completed-capture duration used for the calculation; null when neither source has data. */
  avg_duration_ms: number | null;
  /** Source of the average: 'in_run' uses this run's completed captures; 'session' falls back to the session's rolling history. */
  avg_source: 'in_run' | 'session' | null;
  /** Total pending + processing captures across the run. */
  total_in_flight: number;
  /** ETA by `${url_pair_id}::${viewport_name}` key. Only contains in-flight pairs. */
  members: Record<string, MemberEta>;
}

/** Minimum reported ETA — keeps the badge from flickering at sub-second values. */
const MIN_ETA_MS = 1_000;
/** Session-wide rolling-average fallback window size. */
const SESSION_AVG_LIMIT = 50;

interface CaptureRunRowSlim {
  id: string;
  options_json: string;
}

interface InFlightRow {
  url_pair_id: string;
  viewport_name: string;
  side: 'a' | 'b';
  status: 'pending' | 'processing';
  rank: number;
}

export function computeCaptureEta(db: Db, sessionId: string): CaptureEta {
  const empty: CaptureEta = {
    run_id: null,
    concurrency: null,
    avg_duration_ms: null,
    avg_source: null,
    total_in_flight: 0,
    members: {},
  };

  // The "current" capture run is the most-recently-started one for this
  // session whose backing job hasn't finished. Jobs go through
  // pending/running before complete/error, so either of the first two
  // means captures may still flow through.
  const run = db
    .prepare<[string], CaptureRunRowSlim>(
      `SELECT cr.id, cr.options_json
         FROM capture_runs cr
         JOIN jobs j ON j.id = cr.job_id
        WHERE cr.session_id = ?
          AND j.status IN ('pending', 'running')
        ORDER BY cr.created_at DESC
        LIMIT 1`,
    )
    .get(sessionId);
  if (!run) return empty;

  const concurrency = parseConcurrency(run.options_json);

  // FIFO rank within (pending + processing) per side. Window function
  // gives O(N) for the run's captures; the run rarely tops a few thousand
  // rows so a single pass is fine.
  const ranked = db
    .prepare<[string], InFlightRow>(
      `SELECT url_pair_id, viewport_name, side, status, rank
         FROM (
           SELECT c.url_pair_id, c.viewport_name, c.side, c.status,
                  ROW_NUMBER() OVER (
                    PARTITION BY c.side
                    ORDER BY c.created_at
                  ) AS rank
             FROM captures c
            WHERE c.capture_run_id = ?
              AND c.status IN ('pending', 'processing')
         )`,
    )
    .all(run.id);

  if (ranked.length === 0) {
    return { ...empty, run_id: run.id, concurrency };
  }

  const avgInRun = avgDurationInRun(db, run.id);
  const avgSession = avgInRun === null ? avgDurationForSession(db, sessionId) : null;
  const avgMs = avgInRun ?? avgSession;

  const etaForRank = (rank: number): number =>
    avgMs === null ? 0 : Math.max(MIN_ETA_MS, Math.ceil(rank / concurrency) * avgMs);

  const members: Record<string, MemberEta> = {};
  for (const row of ranked) {
    const key = `${row.url_pair_id}::${row.viewport_name}`;
    const existing = members[key];
    if (!existing) {
      members[key] = {
        eta_ms: etaForRank(row.rank),
        rank: row.rank,
        sides: [row.side],
      };
      continue;
    }
    if (!existing.sides.includes(row.side)) existing.sides.push(row.side);
    // Pair ETA tracks the worst-rank side — that's the one gating the
    // comparison. Even when two sides land in the same concurrency batch
    // (same ETA), recording the higher rank surfaces a more honest queue
    // position to the user.
    if (row.rank > existing.rank) {
      existing.rank = row.rank;
      existing.eta_ms = etaForRank(row.rank);
    }
  }

  return {
    run_id: run.id,
    concurrency,
    avg_duration_ms: avgMs,
    avg_source: avgInRun !== null ? 'in_run' : avgSession !== null ? 'session' : null,
    total_in_flight: ranked.length,
    members,
  };
}

function parseConcurrency(optionsJson: string): number {
  try {
    const parsed = JSON.parse(optionsJson) as { concurrency?: unknown };
    if (typeof parsed.concurrency === 'number' && parsed.concurrency >= 1) {
      return Math.floor(parsed.concurrency);
    }
  } catch {
    // Fallthrough to default.
  }
  return 8; // Mirrors captureRunOptionsSchema default.
}

function avgDurationInRun(db: Db, runId: string): number | null {
  const row = db
    .prepare<[string], { avg_ms: number | null }>(
      `SELECT AVG(duration_ms) AS avg_ms
         FROM captures
        WHERE capture_run_id = ?
          AND status = 'complete'
          AND duration_ms IS NOT NULL`,
    )
    .get(runId);
  return row?.avg_ms ?? null;
}

function avgDurationForSession(db: Db, sessionId: string): number | null {
  const row = db
    .prepare<[string, number], { avg_ms: number | null }>(
      `SELECT AVG(duration_ms) AS avg_ms
         FROM (
           SELECT c.duration_ms
             FROM captures c
             JOIN capture_runs cr ON cr.id = c.capture_run_id
            WHERE cr.session_id = ?
              AND c.status = 'complete'
              AND c.duration_ms IS NOT NULL
            ORDER BY c.captured_at DESC
            LIMIT ?
         )`,
    )
    .get(sessionId, SESSION_AVG_LIMIT);
  return row?.avg_ms ?? null;
}
