import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/db/client.js';
import type { Db } from '../src/db/client.js';
import { applySchema } from '../src/db/schema.js';
import { computeCaptureEta } from '../src/services/capture-eta.js';

/**
 * Unit tests for the capture-eta service. Each test seeds a minimal
 * sessions → url_pairs → jobs → capture_runs → captures slice and
 * inspects the computed ETAs.
 */

interface SeedResult {
  sessionId: string;
  pairs: { id: string; url_a: string; url_b: string }[];
  jobId: string;
  captureRunId: string;
}

function isoMinutesAgo(n: number): string {
  return new Date(Date.now() - n * 60_000).toISOString();
}

function seedSession(db: Db, pairCount: number): SeedResult {
  const now = new Date().toISOString();
  const sessionId = randomUUID();
  db.prepare(
    `INSERT INTO sessions (id, name, csv_filename, created_at) VALUES (?, 'eta', 'eta.csv', ?)`,
  ).run(sessionId, now);
  const pairs: SeedResult['pairs'] = [];
  for (let i = 0; i < pairCount; i += 1) {
    const id = randomUUID();
    const url_a = `https://a.test/${i}`;
    const url_b = `https://b.test/${i}`;
    db.prepare(
      `INSERT INTO url_pairs (id, session_id, url_a, url_b, row_index, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, sessionId, url_a, url_b, i, now);
    pairs.push({ id, url_a, url_b });
  }
  const jobId = randomUUID();
  db.prepare(
    `INSERT INTO jobs (id, type, status, created_at) VALUES (?, 'capture', 'running', ?)`,
  ).run(jobId, now);
  const captureRunId = randomUUID();
  db.prepare(
    `INSERT INTO capture_runs (id, session_id, job_id, options_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
  ).run(
    captureRunId,
    sessionId,
    jobId,
    JSON.stringify({ concurrency: 2 }),
    now,
  );
  return { sessionId, pairs, jobId, captureRunId };
}

function insertCapture(
  db: Db,
  args: {
    runId: string;
    pairId: string;
    side: 'a' | 'b';
    url: string;
    viewport_name?: string;
    status: 'pending' | 'processing' | 'complete' | 'error';
    duration_ms?: number;
    created_at?: string;
    captured_at?: string | null;
  },
): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO captures
       (id, capture_run_id, url_pair_id, side, url, status, viewport_name,
        duration_ms, captured_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    args.runId,
    args.pairId,
    args.side,
    args.url,
    args.status,
    args.viewport_name ?? 'desktop',
    args.duration_ms ?? null,
    args.captured_at ?? null,
    args.created_at ?? new Date().toISOString(),
  );
  return id;
}

describe('computeCaptureEta', () => {
  let db: Db;
  beforeEach(() => {
    db = openDatabase({ path: ':memory:' });
    applySchema(db);
  });
  afterEach(() => {
    db.close();
  });

  it('returns empty result when no capture run is in flight', () => {
    const sessionId = randomUUID();
    db.prepare(
      `INSERT INTO sessions (id, name, csv_filename, created_at) VALUES (?, 'x', 'x.csv', ?)`,
    ).run(sessionId, new Date().toISOString());

    const result = computeCaptureEta(db, sessionId);
    expect(result.run_id).toBeNull();
    expect(result.concurrency).toBeNull();
    expect(result.total_in_flight).toBe(0);
    expect(result.members).toEqual({});
  });

  it('ranks pending captures FIFO within their side and reports concurrency from options_json', () => {
    const seed = seedSession(db, 3);
    const t = (n: number) => isoMinutesAgo(10 - n); // earlier index = earlier created_at
    for (let i = 0; i < seed.pairs.length; i += 1) {
      const p = seed.pairs[i]!;
      insertCapture(db, {
        runId: seed.captureRunId,
        pairId: p.id,
        side: 'a',
        url: p.url_a,
        status: 'pending',
        created_at: t(i),
      });
      insertCapture(db, {
        runId: seed.captureRunId,
        pairId: p.id,
        side: 'b',
        url: p.url_b,
        status: 'pending',
        created_at: t(i),
      });
    }
    // Seed a completed capture so the in-run average has data.
    insertCapture(db, {
      runId: seed.captureRunId,
      pairId: seed.pairs[0]!.id,
      side: 'a',
      url: 'https://a.test/done',
      viewport_name: 'mobile',
      status: 'complete',
      duration_ms: 4_000,
      captured_at: isoMinutesAgo(1),
      created_at: isoMinutesAgo(1),
    });

    const result = computeCaptureEta(db, seed.sessionId);
    expect(result.run_id).toBe(seed.captureRunId);
    expect(result.concurrency).toBe(2);
    expect(result.avg_duration_ms).toBe(4_000);
    expect(result.avg_source).toBe('in_run');
    expect(result.total_in_flight).toBe(6);

    // concurrency=2, avg=4000ms.
    //   pair[0]: rank 1 on each side → ceil(1/2) * 4000 = 4000ms.
    //   pair[1]: rank 2 → ceil(2/2) * 4000 = 4000ms.
    //   pair[2]: rank 3 → ceil(3/2) * 4000 = 8000ms.
    const p0 = result.members[`${seed.pairs[0]!.id}::desktop`]!;
    const p1 = result.members[`${seed.pairs[1]!.id}::desktop`]!;
    const p2 = result.members[`${seed.pairs[2]!.id}::desktop`]!;
    expect(p0.eta_ms).toBe(4_000);
    expect(p0.sides.sort()).toEqual(['a', 'b']);
    expect(p1.eta_ms).toBe(4_000);
    expect(p2.eta_ms).toBe(8_000);
    expect(p2.rank).toBe(3);
  });

  it("pair ETA is the max across sides when they're at different ranks", () => {
    const seed = seedSession(db, 1);
    const p = seed.pairs[0]!;
    // A is rank 1 (earlier created_at), B is rank 1 too (separate partition).
    // To exercise the max behaviour, add a third pair to the run that pushes
    // B's queue position behind another B.
    const extra = seedExtraPair(db, seed.sessionId);
    insertCapture(db, {
      runId: seed.captureRunId,
      pairId: extra.id,
      side: 'b',
      url: extra.url_b,
      status: 'processing',
      created_at: isoMinutesAgo(20),
    });
    insertCapture(db, {
      runId: seed.captureRunId,
      pairId: p.id,
      side: 'a',
      url: p.url_a,
      status: 'pending',
      created_at: isoMinutesAgo(10),
    });
    insertCapture(db, {
      runId: seed.captureRunId,
      pairId: p.id,
      side: 'b',
      url: p.url_b,
      status: 'pending',
      created_at: isoMinutesAgo(5),
    });
    // In-run avg.
    insertCapture(db, {
      runId: seed.captureRunId,
      pairId: p.id,
      side: 'a',
      url: 'https://a.test/done',
      viewport_name: 'mobile',
      status: 'complete',
      duration_ms: 2_000,
      captured_at: isoMinutesAgo(1),
      created_at: isoMinutesAgo(1),
    });

    const result = computeCaptureEta(db, seed.sessionId);
    expect(result.concurrency).toBe(2);
    // A: rank 1 → 2000ms. B: rank 2 (behind the extra pair's B) → 2000ms.
    // With concurrency=2, both rank values land in the same batch, so eta
    // is still 2000ms. The "worst side wins" is exercised by the rank
    // tracking — verify rank is 2 (B's), not 1 (A's).
    const pairEta = result.members[`${p.id}::desktop`]!;
    expect(pairEta.rank).toBe(2);
    expect(pairEta.eta_ms).toBe(2_000);
  });

  it('falls back to a session-wide rolling average when the current run has no completed captures yet', () => {
    const seed = seedSession(db, 1);
    // Old completed capture in a prior run.
    const oldJob = randomUUID();
    db.prepare(
      `INSERT INTO jobs (id, type, status, created_at) VALUES (?, 'capture', 'complete', ?)`,
    ).run(oldJob, isoMinutesAgo(60));
    const oldRun = randomUUID();
    db.prepare(
      `INSERT INTO capture_runs (id, session_id, job_id, options_json, created_at)
         VALUES (?, ?, ?, '{}', ?)`,
    ).run(oldRun, seed.sessionId, oldJob, isoMinutesAgo(60));
    insertCapture(db, {
      runId: oldRun,
      pairId: seed.pairs[0]!.id,
      side: 'a',
      url: seed.pairs[0]!.url_a,
      status: 'complete',
      duration_ms: 6_000,
      captured_at: isoMinutesAgo(50),
      created_at: isoMinutesAgo(50),
    });
    // Pending capture in the current run with no in-run completed peer.
    insertCapture(db, {
      runId: seed.captureRunId,
      pairId: seed.pairs[0]!.id,
      side: 'a',
      url: seed.pairs[0]!.url_a,
      status: 'pending',
      created_at: isoMinutesAgo(1),
    });

    const result = computeCaptureEta(db, seed.sessionId);
    expect(result.avg_source).toBe('session');
    expect(result.avg_duration_ms).toBe(6_000);
    expect(result.members[`${seed.pairs[0]!.id}::desktop`]!.eta_ms).toBe(6_000);
  });

  it('omits ETA when neither the run nor the session has a completed-capture average', () => {
    const seed = seedSession(db, 1);
    insertCapture(db, {
      runId: seed.captureRunId,
      pairId: seed.pairs[0]!.id,
      side: 'a',
      url: seed.pairs[0]!.url_a,
      status: 'pending',
      created_at: isoMinutesAgo(1),
    });

    const result = computeCaptureEta(db, seed.sessionId);
    expect(result.avg_source).toBeNull();
    expect(result.avg_duration_ms).toBeNull();
    // Member is present so the UI can still mark it as stale; eta_ms is 0
    // and consumers omit the chip when eta_ms <= 0.
    const member = result.members[`${seed.pairs[0]!.id}::desktop`]!;
    expect(member.eta_ms).toBe(0);
    expect(member.rank).toBe(1);
  });

  it('ignores runs whose backing job is already complete', () => {
    const seed = seedSession(db, 1);
    db.prepare(`UPDATE jobs SET status = 'complete' WHERE id = ?`).run(seed.jobId);
    insertCapture(db, {
      runId: seed.captureRunId,
      pairId: seed.pairs[0]!.id,
      side: 'a',
      url: seed.pairs[0]!.url_a,
      status: 'pending',
      created_at: isoMinutesAgo(1),
    });
    const result = computeCaptureEta(db, seed.sessionId);
    expect(result.run_id).toBeNull();
    expect(result.members).toEqual({});
  });
});

function seedExtraPair(
  db: Db,
  sessionId: string,
): { id: string; url_a: string; url_b: string } {
  const id = randomUUID();
  const url_a = 'https://a.test/extra';
  const url_b = 'https://b.test/extra';
  db.prepare(
    `INSERT INTO url_pairs (id, session_id, url_a, url_b, row_index, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, sessionId, url_a, url_b, 99, new Date().toISOString());
  return { id, url_a, url_b };
}
