#!/bin/sh
# Copy the `captures` + `capture_cache` rows from one worktree's DB into
# another's, so the destination's planner can skip Playwright captures for
# every URL the source has already screenshotted. Useful when standing up
# a fresh worktree to test against an already-captured URL slice.
#
# Why both tables, not just capture_cache? capture_cache stores only the
# (url, viewport, opts) → sha mapping. runOneComparison still reads
# captures.is_missing by capture_id, so a capture_cache hit with a
# dangling capture_id would crash the comparison job. We import both;
# foreign keys are turned off for the duration so dangling references to
# capture_runs / url_pairs in the destination are tolerated. The planner
# and comparison code only use captures.id, .screenshot_sha256, and
# .is_missing — none of which involve the dangling columns.
#
# What this does NOT copy: sessions, url_pairs, comparisons, acceptances,
# pixel_compare_cache, lm_verdict_cache. Those are session-bound or
# verdict-bound, and the destination worktree is expected to produce its
# own. The shared images dir (see share-images-dir.sh) handles the
# physical PNG files; this script handles the lookup index.
#
# Usage:
#   scripts/import-capture-cache.sh --src <path> --dst <path>
#
# Defaults: source = this worktree's DB; dest = sibling worktree (prompts).
set -eu

usage() {
  echo "usage: $0 --src <source.sqlite> --dst <dest.sqlite>" >&2
  exit 1
}

SRC=""
DST=""
while [ $# -gt 0 ]; do
  case "$1" in
    --src) SRC="$2"; shift 2 ;;
    --dst) DST="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "unknown arg: $1" >&2; usage ;;
  esac
done

[ -z "$SRC" ] && usage
[ -z "$DST" ] && usage
[ ! -f "$SRC" ] && { echo "source DB not found: $SRC" >&2; exit 2; }

WORKTREE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCHEMA="$WORKTREE_ROOT/packages/api/src/db/schema.sql"
[ ! -f "$SCHEMA" ] && { echo "schema.sql not found: $SCHEMA" >&2; exit 2; }

# Bootstrap the destination DB if it doesn't exist yet: applySchema is
# idempotent (the runtime check is "any user table present"), so running
# the schema once gives us the same starting point the API would.
if [ ! -f "$DST" ]; then
  echo "[import-capture-cache] dest DB doesn't exist, applying schema → $DST"
  mkdir -p "$(dirname "$DST")"
  sqlite3 "$DST" < "$SCHEMA"
fi

echo "[import-capture-cache] importing captures + capture_cache"
echo "  src: $SRC"
echo "  dst: $DST"

sqlite3 "$DST" <<SQL
ATTACH DATABASE '$SRC' AS src;
PRAGMA foreign_keys = OFF;
BEGIN;

INSERT OR IGNORE INTO captures
  SELECT * FROM src.captures
   WHERE id IN (SELECT capture_id FROM src.capture_cache);

INSERT OR IGNORE INTO capture_cache
  SELECT * FROM src.capture_cache;

SELECT 'captures_imported'      AS metric, (SELECT COUNT(*) FROM captures)      AS dst_total UNION ALL
SELECT 'capture_cache_imported' AS metric, (SELECT COUNT(*) FROM capture_cache) AS dst_total;

COMMIT;
PRAGMA foreign_keys = ON;
DETACH DATABASE src;
SQL

echo "[import-capture-cache] done"
