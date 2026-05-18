/**
 * Backfill cluster signatures on existing `differences` rows.
 *
 * For each LM- and imagick-sourced difference row in the target sessions:
 *   - Compute the signature via services/cluster-signature.ts
 *     (v1 when LM tags are present, else v0).
 *   - Write back the (signature, signature_version) columns.
 * Then call recomputeClusters() per session to materialise the cluster index.
 *
 * Idempotent: re-running on the same DB produces the same end state.
 * Existing signatures are overwritten only when --force is passed (default:
 * skip rows whose signature is already set, which makes incremental runs
 * cheap).
 *
 * Usage:
 *   mise exec -- pnpm --filter @visual-compare/api exec tsx \
 *     scripts/backfill-cluster-signatures.ts
 *     [--session <session_id>] [--force] [--db <path>]
 *
 * Env:
 *   DB_PATH    sqlite db path
 *              (default ../../data/visual-compare.sqlite, relative to package)
 */

import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeSignature } from '../src/services/cluster-signature.js';
import { recomputeClusters } from '../src/services/clusters.js';
import { applySessionRules } from '../src/services/acceptance-rules.js';
import { runColumnMigrations } from '../src/db/migrations.js';
import type { BoundingBoxPercent, DifferenceSource } from '../src/types.js';

const __filename = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = resolve(dirname(__filename), '..');
const REPO_ROOT = resolve(PACKAGE_ROOT, '..', '..');
const DEFAULT_DB = resolve(REPO_ROOT, 'data', 'visual-compare.sqlite');

interface CliArgs {
  sessionId: string | null;
  force: boolean;
  dbPath: string;
}

function parseArgs(argv: string[]): CliArgs {
  let sessionId: string | null = null;
  let force = false;
  let dbPath = process.env.DB_PATH ?? DEFAULT_DB;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--session' && argv[i + 1]) sessionId = argv[++i]!;
    else if (a === '--force') force = true;
    else if (a === '--db' && argv[i + 1]) dbPath = argv[++i]!;
  }
  return { sessionId, force, dbPath };
}

interface DiffRow {
  id: string;
  source: DifferenceSource;
  bbox_json: string | null;
  viewport_name: string;
  change_type: string | null;
  region_role: string | null;
  element_label: string | null;
  signature: string | null;
}

function listSessions(db: Database.Database, only: string | null): Array<{ id: string; name: string }> {
  if (only) {
    const row = db.prepare<[string], { id: string; name: string }>(
      `SELECT id, name FROM sessions WHERE id = ?`,
    ).get(only);
    return row ? [row] : [];
  }
  return db.prepare<unknown[], { id: string; name: string }>(
    `SELECT id, name FROM sessions WHERE archived_at IS NULL ORDER BY created_at`,
  ).all();
}

function parseBbox(json: string | null): BoundingBoxPercent | null {
  if (!json) return null;
  try {
    const obj = JSON.parse(json) as Partial<BoundingBoxPercent>;
    if (
      typeof obj.x === 'number' && typeof obj.y === 'number' &&
      typeof obj.width === 'number' && typeof obj.height === 'number'
    ) {
      return { x: obj.x, y: obj.y, width: obj.width, height: obj.height };
    }
  } catch { /* fall through */ }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.dbPath)) {
    console.error(`DB not found at ${args.dbPath}`);
    process.exit(1);
  }
  const db = new Database(args.dbPath);

  // Run column migrations first so signature_version / change_type / etc.
  // exist on legacy DBs. Idempotent on fresh DBs (no-op when columns are
  // already there).
  const mig = runColumnMigrations(db);
  if (mig.columns_added + mig.tables_created + mig.indices_created > 0) {
    console.log(`migrations: +${mig.columns_added} cols, +${mig.tables_created} tables, +${mig.indices_created} indices`);
  }

  const sessions = listSessions(db, args.sessionId);
  if (sessions.length === 0) {
    console.error('No sessions to process');
    process.exit(1);
  }

  const updateSig = db.prepare(
    `UPDATE differences SET signature = ?, signature_version = ? WHERE id = ?`,
  );

  for (const session of sessions) {
    console.log(`\nSession ${session.name} (${session.id.slice(0, 8)}…)`);

    const rows = db.prepare<[string], DiffRow>(
      `SELECT d.id              AS id,
              d.source          AS source,
              d.bounding_box_json AS bbox_json,
              c.viewport_name   AS viewport_name,
              d.change_type     AS change_type,
              d.region_role     AS region_role,
              d.element_label   AS element_label,
              d.signature       AS signature
         FROM differences d
         JOIN comparisons c ON c.id = d.comparison_id
         JOIN url_pairs   p ON p.id = c.url_pair_id
        WHERE p.session_id = ?`,
    ).all(session.id);

    let assigned = 0;
    let skipped = 0;
    let unsignable = 0;
    const v0 = { count: 0 };
    const v1 = { count: 0 };

    const tx = db.transaction(() => {
      for (const r of rows) {
        if (r.signature && !args.force) {
          skipped += 1;
          continue;
        }
        const sig = computeSignature({
          source: r.source,
          viewport_name: r.viewport_name,
          bbox: parseBbox(r.bbox_json),
          change_type: r.change_type,
          region_role: r.region_role,
          element_label: r.element_label,
        });
        if (!sig) {
          unsignable += 1;
          continue;
        }
        updateSig.run(sig.signature, sig.signature_version, r.id);
        assigned += 1;
        if (sig.signature_version === 'v0') v0.count += 1; else v1.count += 1;
      }
    });
    tx();

    console.log(`  rows considered: ${rows.length}`);
    console.log(`  assigned:        ${assigned}  (v0=${v0.count}, v1=${v1.count})`);
    if (skipped) console.log(`  skipped (already signed): ${skipped} — pass --force to overwrite`);
    if (unsignable) console.log(`  unsignable (no bbox, no tags): ${unsignable}`);

    const result = recomputeClusters(db, session.id);
    console.log(`  clusters: +${result.clusters_upserted} upserted, -${result.clusters_removed} removed`);
    const ruleResult = applySessionRules(db, session.id);
    if (ruleResult.rules_processed > 0) {
      console.log(`  rules:    ${ruleResult.rules_processed} processed → ${ruleResult.acceptances_created} acceptances created, ${ruleResult.clusters_accepted} clusters newly accepted`);
    }
  }

  db.close();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
