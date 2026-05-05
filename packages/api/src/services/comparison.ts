import { randomUUID } from 'node:crypto';
import { mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import type { ArtifactStore } from './artifact-store.js';
import {
  compareAe,
  compareSsim,
  extractConnectedComponents,
} from './imagick.js';
import { parseConnectedComponents } from './connected-components.js';
import { decideEquivalence } from './equivalence.js';
import type { JobQueue } from './queue.js';
import type {
  CaptureRow,
  ComparisonRow,
  ComparisonRunRow,
  EquivalenceLevelId,
} from '../types.js';

export const comparisonRunOptionsSchema = z.object({
  equivalenceLevel: z.enum([
    'pixel-perfect',
    'strict',
    'tolerant',
    'loose',
    'semantic',
  ]),
  urlPairIds: z.array(z.string()).optional(),
  viewports: z.array(z.string()).optional(),
});

export type ComparisonRunOptionsParsed = z.output<typeof comparisonRunOptionsSchema>;

export interface ComparisonImagick {
  compareAe: typeof compareAe;
  compareSsim: typeof compareSsim;
  extractConnectedComponents: typeof extractConnectedComponents;
}

const realImagick: ComparisonImagick = {
  compareAe,
  compareSsim,
  extractConnectedComponents,
};

export interface ComparisonRunDeps {
  db: Db;
  queue: JobQueue;
  artifactStore: ArtifactStore;
  imagick?: ComparisonImagick;
}

export interface StartComparisonRunInput {
  sessionId: string;
  captureRunId: string;
  options: ComparisonRunOptionsParsed;
}

export interface StartComparisonRunResult {
  comparison_run_id: string;
  job_id: string;
  comparison_count: number;
}

interface PairKey {
  url_pair_id: string;
  viewport_name: string;
  capture_a: CaptureRow;
  capture_b: CaptureRow;
}

function pickMatchingCaptures(db: Db, captureRunId: string, opts: ComparisonRunOptionsParsed): PairKey[] {
  const captures = db
    .prepare<[string], CaptureRow>(
      `SELECT * FROM captures WHERE capture_run_id = ? AND status = 'complete'`,
    )
    .all(captureRunId);

  const byKey = new Map<string, { a?: CaptureRow; b?: CaptureRow }>();
  for (const c of captures) {
    const key = `${c.url_pair_id}::${c.viewport_name}`;
    const slot = byKey.get(key) ?? {};
    if (c.side === 'a') slot.a = c;
    else slot.b = c;
    byKey.set(key, slot);
  }

  const pickedPairs = opts.urlPairIds && opts.urlPairIds.length > 0
    ? new Set(opts.urlPairIds)
    : null;
  const pickedViewports = opts.viewports && opts.viewports.length > 0
    ? new Set(opts.viewports)
    : null;

  const out: PairKey[] = [];
  for (const [key, slot] of byKey) {
    if (!slot.a || !slot.b) continue;
    if (pickedPairs && !pickedPairs.has(slot.a.url_pair_id)) continue;
    if (pickedViewports && !pickedViewports.has(slot.a.viewport_name)) continue;
    void key;
    out.push({
      url_pair_id: slot.a.url_pair_id,
      viewport_name: slot.a.viewport_name,
      capture_a: slot.a,
      capture_b: slot.b,
    });
  }
  return out;
}

export function startComparisonRun(
  deps: ComparisonRunDeps,
  input: StartComparisonRunInput,
): StartComparisonRunResult {
  const { db, queue } = deps;
  const { sessionId, captureRunId, options } = input;
  const imagick = deps.imagick ?? realImagick;

  // Confirm the capture run belongs to the session.
  const captureRun = db
    .prepare<[string, string], { id: string }>(
      'SELECT id FROM capture_runs WHERE id = ? AND session_id = ?',
    )
    .get(captureRunId, sessionId);
  if (!captureRun) {
    throw new Error(
      `capture_run ${captureRunId} not found in session ${sessionId}`,
    );
  }

  const pairs = pickMatchingCaptures(db, captureRunId, options);
  if (pairs.length === 0) {
    throw new Error('No matching A/B captures with status=complete were found.');
  }

  const jobId = queue.createJob({ type: 'comparison', progress_total: pairs.length });
  const comparisonRunId = randomUUID();
  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO comparison_runs
         (id, session_id, capture_run_id, job_id, equivalence_level, options_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      comparisonRunId,
      sessionId,
      captureRunId,
      jobId,
      options.equivalenceLevel,
      JSON.stringify(options),
      now,
    );
    const insertComparison = db.prepare(
      `INSERT INTO comparisons
         (id, comparison_run_id, url_pair_id, capture_a_id, capture_b_id,
          viewport_name, equivalence_level, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    );
    for (const p of pairs) {
      insertComparison.run(
        randomUUID(),
        comparisonRunId,
        p.url_pair_id,
        p.capture_a.id,
        p.capture_b.id,
        p.viewport_name,
        options.equivalenceLevel,
        now,
      );
    }
  });
  tx();

  queue.enqueue(jobId, async (ctx) => {
    const comparisons = db
      .prepare<[string], ComparisonRow>(
        `SELECT * FROM comparisons WHERE comparison_run_id = ? ORDER BY created_at`,
      )
      .all(comparisonRunId);
    for (const c of comparisons) {
      await runOneComparison(deps, imagick, c, options.equivalenceLevel);
      ctx.incrementProgress();
    }
  });

  return {
    comparison_run_id: comparisonRunId,
    job_id: jobId,
    comparison_count: pairs.length,
  };
}

async function runOneComparison(
  deps: ComparisonRunDeps,
  imagick: ComparisonImagick,
  comparison: ComparisonRow,
  level: EquivalenceLevelId,
): Promise<void> {
  const { db, artifactStore } = deps;
  db.prepare(`UPDATE comparisons SET status = 'processing' WHERE id = ?`).run(comparison.id);

  const startedAt = Date.now();
  let diffTempPath: string | null = null;
  try {
    const captureA = db
      .prepare<[string], CaptureRow>('SELECT * FROM captures WHERE id = ?')
      .get(comparison.capture_a_id);
    const captureB = db
      .prepare<[string], CaptureRow>('SELECT * FROM captures WHERE id = ?')
      .get(comparison.capture_b_id);
    if (!captureA?.screenshot_sha256 || !captureB?.screenshot_sha256) {
      throw new Error('Capture rows are missing screenshot hashes.');
    }
    const aPath = artifactStore.absolutePathFor(captureA.screenshot_sha256);
    const bPath = artifactStore.absolutePathFor(captureB.screenshot_sha256);

    const tempDir = join(tmpdir(), 'visual-compare-diffs');
    await mkdir(tempDir, { recursive: true });
    diffTempPath = join(tempDir, `${randomUUID()}.png`);

    const ae = await imagick.compareAe(aPath, bPath, diffTempPath);
    const ssim = await imagick.compareSsim(aPath, bPath);

    // Write the diff into the content-addressed store.
    const { sha256: diffHash, byteSize: diffBytes } =
      await artifactStore.writeImage(diffTempPath);
    diffTempPath = null;

    // Connected components.
    const cc = await imagick.extractConnectedComponents(
      artifactStore.absolutePathFor(diffHash),
    );
    const regions = parseConnectedComponents(cc.raw, {
      imageWidth: ae.width,
      imageHeight: ae.height,
      format: cc.format,
    });

    const componentCount = regions.length;
    const totalArea = ae.width * ae.height;
    const bboxAreaPct = regions.reduce((sum, r) => sum + r.area, 0) / Math.max(1, totalArea) * 100;

    const decision = decideEquivalence({
      level,
      changedPixelPercentage: ae.changedPixelPercentage,
      ssim,
    });

    const isEquivalent = decision.imDeterminedEquivalent;
    const completedAt = new Date().toISOString();

    db.transaction(() => {
      db.prepare(
        `UPDATE comparisons SET
           status = 'complete',
           changed_pixel_percentage = ?,
           ssim = ?,
           bounding_box_area_percentage = ?,
           connected_component_count = ?,
           im_diff_sha256 = ?,
           im_diff_byte_size = ?,
           im_determined_equivalent = ?,
           lm_invocation_reason = ?,
           is_equivalent = ?,
           duration_ms = ?,
           completed_at = ?
         WHERE id = ?`,
      ).run(
        ae.changedPixelPercentage,
        ssim,
        bboxAreaPct,
        componentCount,
        diffHash,
        diffBytes,
        decision.imDeterminedEquivalent === null
          ? null
          : decision.imDeterminedEquivalent ? 1 : 0,
        decision.lmInvocationReason,
        isEquivalent === null ? null : isEquivalent ? 1 : 0,
        Date.now() - startedAt,
        completedAt,
        comparison.id,
      );

      const insertDiff = db.prepare(
        `INSERT INTO differences
           (id, comparison_id, source, description, severity, bounding_box_json, created_at)
         VALUES (?, ?, 'imagick', ?, NULL, ?, ?)`,
      );
      for (const r of regions) {
        insertDiff.run(
          randomUUID(),
          comparison.id,
          `Region of ${r.area}px${r.color ? ` (${r.color})` : ''}`,
          JSON.stringify(r.bbox_percent),
          completedAt,
        );
      }
    })();

    // Service-layer invariant: status='complete' means is_equivalent is non-null
    // unless an LM tiebreaker is pending (lm_invocation_reason is set).
    if (isEquivalent === null && decision.lmInvocationReason === null) {
      throw new Error(
        `Internal: equivalence decision missing for comparison ${comparison.id}`,
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db.prepare(
      `UPDATE comparisons
         SET status = 'error', error_message = ?, completed_at = ?, duration_ms = ?
       WHERE id = ?`,
    ).run(message, new Date().toISOString(), Date.now() - startedAt, comparison.id);
  } finally {
    if (diffTempPath) await unlink(diffTempPath).catch(() => {});
  }
}

export function getComparisonRun(db: Db, id: string): ComparisonRunRow | null {
  const row = db
    .prepare<[string], ComparisonRunRow>('SELECT * FROM comparison_runs WHERE id = ?')
    .get(id);
  return row ?? null;
}

export function listComparisonRuns(db: Db, sessionId?: string): ComparisonRunRow[] {
  if (sessionId) {
    return db
      .prepare<[string], ComparisonRunRow>(
        `SELECT * FROM comparison_runs WHERE session_id = ? ORDER BY created_at DESC`,
      )
      .all(sessionId);
  }
  return db
    .prepare<unknown[], ComparisonRunRow>(
      'SELECT * FROM comparison_runs ORDER BY created_at DESC',
    )
    .all();
}

export interface ComparisonsQuery {
  comparison_run_id?: string;
  session_id?: string;
  status?: string;
}

export function listComparisons(db: Db, q: ComparisonsQuery): ComparisonRow[] {
  const where: string[] = [];
  const params: string[] = [];
  if (q.comparison_run_id) {
    where.push('cr.comparison_run_id = ?');
    params.push(q.comparison_run_id);
  }
  if (q.session_id) {
    where.push(
      'cr.comparison_run_id IN (SELECT id FROM comparison_runs WHERE session_id = ?)',
    );
    params.push(q.session_id);
  }
  if (q.status) {
    where.push('cr.status = ?');
    params.push(q.status);
  }
  const sql = `SELECT cr.* FROM comparisons cr${
    where.length ? ' WHERE ' + where.join(' AND ') : ''
  } ORDER BY cr.created_at`;
  return db.prepare<string[], ComparisonRow>(sql).all(...params);
}

export function getComparison(db: Db, id: string): ComparisonRow | null {
  const row = db
    .prepare<[string], ComparisonRow>('SELECT * FROM comparisons WHERE id = ?')
    .get(id);
  return row ?? null;
}
