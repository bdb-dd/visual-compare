/**
 * v3 prompt live smoke test.
 *
 * Pulls a real comparison's A/B/diff images from the artifact store and
 * sends them to LM Studio with the v3 system prompt (the one with the
 * cluster-signature taxonomy). Prints the parsed response with focus on
 * the v1 fields (changeType, regionRole, elementLabel) so you can eyeball
 * whether the live LM is emitting sensible tags from real images.
 *
 * Usage:
 *   mise exec -- pnpm --filter @visual-compare/api exec tsx scripts/v3-smoke-test.ts
 *     [--comparison <comparison_id>] [--random] [--db <path>] [--images <dir>]
 *
 * If no comparison is specified, picks a random comparison that has at least
 * one LM-sourced difference (i.e. one where the LM ran during evaluation).
 *
 * Env:
 *   DB_PATH      default ../../../plan-improved-visual-compare/data/visual-compare.sqlite
 *   IMAGES_DIR   default ../../../plan-improved-visual-compare/data/images
 *   LM_STUDIO_*  forwarded to the LM client (see readLmConfigFromEnv)
 */

import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { existsSync } from 'node:fs';
import {
  createLmClient,
  readLmConfigFromEnv,
  SYSTEM_PROMPT_V3,
  isAnalyzeError,
} from '../src/services/lm.js';
import { createArtifactStore } from '../src/services/artifact-store.js';

const __filename = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = resolve(dirname(__filename), '..');
const DEFAULT_DB = resolve(
  PACKAGE_ROOT, '..', '..', '..',
  'plan-improved-visual-compare', 'data', 'visual-compare.sqlite',
);
const DEFAULT_IMAGES = resolve(
  PACKAGE_ROOT, '..', '..', '..',
  'plan-improved-visual-compare', 'data', 'images',
);

function parseArgs(argv: string[]): {
  comparisonId: string | null;
  random: boolean;
  dbPath: string;
  imagesDir: string;
} {
  let comparisonId: string | null = null;
  let random = false;
  let dbPath = process.env.DB_PATH ?? DEFAULT_DB;
  let imagesDir = process.env.IMAGES_DIR ?? DEFAULT_IMAGES;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--comparison' && argv[i + 1]) { comparisonId = argv[++i]!; }
    else if (a === '--random') { random = true; }
    else if (a === '--db' && argv[i + 1]) { dbPath = argv[++i]!; }
    else if (a === '--images' && argv[i + 1]) { imagesDir = argv[++i]!; }
  }
  return { comparisonId, random, dbPath, imagesDir };
}

interface ComparisonImages {
  comparisonId: string;
  pairLabel: string | null;
  urlA: string;
  urlB: string;
  viewport: string;
  changedPct: number | null;
  ssim: number | null;
  v2DiffSummary: string | null;
  v2DiffDescriptions: string[];
  captureASha: string;
  captureBSha: string;
  diffSha: string;
}

function pickComparison(db: Database.Database, comparisonId: string | null): ComparisonImages {
  const where = comparisonId
    ? 'c.id = ?'
    : `c.im_diff_sha256 IS NOT NULL
       AND c.id IN (SELECT comparison_id FROM differences WHERE source = 'lm')
       ORDER BY RANDOM() LIMIT 1`;
  const params = comparisonId ? [comparisonId] : [];
  const row = db.prepare(
    `SELECT c.id              AS comparison_id,
            c.viewport_name   AS viewport,
            c.changed_pixel_percentage AS changed_pct,
            c.ssim            AS ssim,
            c.lm_diff_summary AS v2_summary,
            c.im_diff_sha256  AS diff_sha,
            ca.screenshot_sha256 AS a_sha,
            cb.screenshot_sha256 AS b_sha,
            ca.url            AS url_a,
            cb.url            AS url_b,
            p.label           AS pair_label
       FROM comparisons c
       JOIN captures ca ON ca.id = c.capture_a_id
       JOIN captures cb ON cb.id = c.capture_b_id
       JOIN url_pairs p ON p.id = c.url_pair_id
      WHERE ${where}`,
  ).get(...params) as Record<string, unknown> | undefined;

  if (!row) {
    throw new Error(comparisonId
      ? `No comparison with id ${comparisonId}`
      : 'No comparison with LM diffs found in DB');
  }

  const diffDescs = db.prepare(
    `SELECT description FROM differences
      WHERE comparison_id = ? AND source = 'lm'`,
  ).all(row.comparison_id as string) as Array<{ description: string }>;

  return {
    comparisonId: row.comparison_id as string,
    pairLabel: (row.pair_label as string | null) ?? null,
    urlA: row.url_a as string,
    urlB: row.url_b as string,
    viewport: row.viewport as string,
    changedPct: (row.changed_pct as number | null) ?? null,
    ssim: (row.ssim as number | null) ?? null,
    v2DiffSummary: (row.v2_summary as string | null) ?? null,
    v2DiffDescriptions: diffDescs.map((d) => d.description),
    captureASha: row.a_sha as string,
    captureBSha: row.b_sha as string,
    diffSha: row.diff_sha as string,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.dbPath)) {
    console.error(`DB not found at ${args.dbPath}`);
    process.exit(1);
  }
  if (!existsSync(args.imagesDir)) {
    console.error(`Images dir not found at ${args.imagesDir}`);
    process.exit(1);
  }

  const db = new Database(args.dbPath, { readonly: true });
  const artifactStore = createArtifactStore(args.imagesDir);
  const picked = pickComparison(db, args.comparisonId);

  const aPath = artifactStore.absolutePathFor(picked.captureASha);
  const bPath = artifactStore.absolutePathFor(picked.captureBSha);
  const diffPath = artifactStore.absolutePathFor(picked.diffSha);

  for (const [name, p] of [['A', aPath], ['B', bPath], ['diff', diffPath]] as const) {
    if (!existsSync(p)) {
      console.error(`${name} image missing on disk: ${p}`);
      process.exit(1);
    }
  }

  console.log('─── Test fixture ─────────────────────────────────────────');
  console.log(`  comparison_id: ${picked.comparisonId}`);
  console.log(`  viewport:      ${picked.viewport}`);
  console.log(`  URL A:         ${picked.urlA}`);
  console.log(`  URL B:         ${picked.urlB}`);
  console.log(`  changed_pct:   ${picked.changedPct?.toFixed(3) ?? '—'}`);
  console.log(`  ssim:          ${picked.ssim?.toFixed(4) ?? '—'}`);
  console.log();
  console.log('  v2 LM verdict (already in DB):');
  console.log(`    summary: ${picked.v2DiffSummary ?? '—'}`);
  console.log(`    diffs:   ${picked.v2DiffDescriptions.length}`);
  for (const d of picked.v2DiffDescriptions.slice(0, 4)) {
    console.log(`      ◦ ${d.slice(0, 100)}`);
  }
  console.log();

  const config = readLmConfigFromEnv();
  console.log('─── LM config ────────────────────────────────────────────');
  console.log(`  baseURL:  ${config.baseURL}`);
  console.log(`  model:    ${config.model}`);
  console.log();

  const client = createLmClient(config);
  const preflight = await client.preflight();
  if (!preflight.ok) {
    console.error(`Preflight failed: ${preflight.message}`);
    process.exit(1);
  }
  console.log(`  preflight ok (${preflight.durationMs}ms)`);
  console.log();

  console.log('─── Running v3 prompt ────────────────────────────────────');
  const startedAt = Date.now();
  const result = await client.analyze({
    aPath,
    bPath,
    diffPath,
    level: 'tolerant',
    invocationReason: 'target_level_failure',
    changedPixelPercentage: picked.changedPct,
    ssim: picked.ssim,
    prompt: { id: 'v3-smoke', text: SYSTEM_PROMPT_V3 },
  });
  const elapsedMs = Date.now() - startedAt;
  console.log(`  elapsed: ${elapsedMs}ms`);
  console.log();

  if (isAnalyzeError(result)) {
    console.error('─── v3 call FAILED ──────────────────────────────────────');
    console.error(`  ${result.message}`);
    if (result.rawText) {
      console.error('  raw text (first 500 chars):');
      console.error(`    ${result.rawText.slice(0, 500)}`);
    }
    process.exit(2);
  }

  console.log('─── v3 response ──────────────────────────────────────────');
  console.log(`  path:        ${result.path}`);
  console.log(`  equivalent:  ${result.parsed.equivalent}`);
  console.log(`  confidence:  ${result.parsed.confidence.toFixed(3)}`);
  console.log(`  summary:     ${result.parsed.summary}`);
  console.log(`  differences: ${result.parsed.differences.length}`);
  console.log();

  for (const [i, d] of result.parsed.differences.entries()) {
    const ct = d.changeType ?? '(missing)';
    const rr = d.regionRole ?? '(missing)';
    const el = d.elementLabel ?? '(missing)';
    const tagsOk = d.changeType && d.regionRole && d.elementLabel;
    const tagMark = tagsOk ? '✓' : '✗';
    console.log(`  #${i + 1} ${tagMark} severity=${d.severity}`);
    console.log(`     changeType:   ${ct}`);
    console.log(`     regionRole:   ${rr}`);
    console.log(`     elementLabel: ${el}`);
    console.log(`     description:  ${d.description.slice(0, 120)}`);
    console.log(`     bbox:         x=${d.boundingBox.x.toFixed(1)} y=${d.boundingBox.y.toFixed(1)} w=${d.boundingBox.width.toFixed(1)} h=${d.boundingBox.height.toFixed(1)}`);
    console.log();
  }

  const allTagged = result.parsed.differences.every(
    (d) => d.changeType && d.regionRole && d.elementLabel,
  );
  if (result.parsed.differences.length === 0) {
    console.log('NOTE: zero differences returned — taxonomy compliance is vacuously true.');
  } else if (allTagged) {
    console.log('✓ All differences include v1 taxonomy tags.');
  } else {
    console.log('✗ Some differences are missing v1 tags — investigate prompt or schema enforcement.');
    process.exit(3);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
