"""
Experiment A — does the v0 signature cluster meaningfully?

Reads an existing visual-compare SQLite DB read-only and, for each session,
computes the v0 cluster signature on every `differences` row, then reports
three leverage metrics:

  1. Raw leverage:     1 - n_clusters / n_differences (per the proposal)
  2. Reviewer leverage:fraction of (pair, viewport) "comparisons-with-diffs"
                       fully explained by accepting the top-K clusters by
                       pair-count. This is the practical metric — reviewers
                       act on comparisons, not on individual diff rows.
  3. Coverage curve:   K vs fraction-of-pairs-fully-covered for the same
                       top-K ordering.

v0 signature: sha1(viewport | grid_cell | size_band | source) — no LM-schema
changes needed. See §4 of cluster-review-proposal.md.

Usage:
  python3 experiment_a_v0_leverage.py <path-to-sqlite-db>
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import sys
from collections import Counter, defaultdict
from typing import Iterable


# ---------------------------------------------------------------------------
# Signature
# ---------------------------------------------------------------------------

GRID = 10  # 10x10 page grid → 100 cells

SIZE_BANDS = [
    ("xs", 0.1),   # area < 0.1% of page
    ("s",  1.0),
    ("m",  5.0),
    ("l",  20.0),
    ("xl", float("inf")),
]


def size_band(area_pct: float) -> str:
    for name, ceiling in SIZE_BANDS:
        if area_pct < ceiling:
            return name
    return "xl"


def grid_cell(x: float, y: float, w: float, h: float) -> str:
    """Centroid of bbox quantised to a GRID×GRID cell."""
    cx = max(0.0, min(99.999, x + w / 2.0))
    cy = max(0.0, min(99.999, y + h / 2.0))
    col = int(cx / (100.0 / GRID))
    row = int(cy / (100.0 / GRID))
    return f"{row}-{col}"


def signature_v0(viewport: str, bbox: dict, source: str) -> str:
    cell = grid_cell(bbox["x"], bbox["y"], bbox["width"], bbox["height"])
    area = bbox["width"] * bbox["height"]
    band = size_band(area)
    raw = f"{viewport}|{cell}|{band}|{source}"
    return hashlib.sha1(raw.encode()).hexdigest()[:12]


# ---------------------------------------------------------------------------
# DB access
# ---------------------------------------------------------------------------

def connect_ro(path: str) -> sqlite3.Connection:
    uri = f"file:{path}?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def fetch_sessions(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return list(conn.execute(
        "SELECT id, name FROM sessions WHERE archived_at IS NULL"
    ))


def iter_session_diffs(conn: sqlite3.Connection, session_id: str) -> Iterable[sqlite3.Row]:
    """Yield (comparison_id, url_pair_id, viewport_name, source, bbox_json)."""
    return conn.execute(
        """
        SELECT
            d.id              AS diff_id,
            d.comparison_id   AS comparison_id,
            d.source          AS source,
            d.bounding_box_json AS bbox_json,
            c.url_pair_id     AS url_pair_id,
            c.viewport_name   AS viewport_name
        FROM differences d
        JOIN comparisons c ON c.id = d.comparison_id
        JOIN url_pairs   p ON p.id = c.url_pair_id
        WHERE p.session_id = ?
        """,
        (session_id,),
    )


# ---------------------------------------------------------------------------
# Analysis
# ---------------------------------------------------------------------------

def analyse_session(conn: sqlite3.Connection, session_id: str, session_name: str) -> dict:
    # Per-source: signature → set of (url_pair_id, viewport)
    clusters: dict[str, dict[str, set]] = {
        "imagick": defaultdict(set),
        "lm":      defaultdict(set),
    }
    # pair_key → source → set of signatures appearing in that pair
    pair_to_sigs: dict[tuple, dict[str, set]] = defaultdict(lambda: {"imagick": set(), "lm": set()})
    # Raw difference counts per source
    n_diffs = {"imagick": 0, "lm": 0}
    # Cluster row sizes (per-difference, not per-pair)
    cluster_member_counts: dict[str, Counter] = {"imagick": Counter(), "lm": Counter()}

    for row in iter_session_diffs(conn, session_id):
        bbox_json = row["bbox_json"]
        if not bbox_json:
            continue
        try:
            bbox = json.loads(bbox_json)
        except json.JSONDecodeError:
            continue
        if not all(k in bbox for k in ("x", "y", "width", "height")):
            continue
        source = row["source"]
        if source not in clusters:
            continue

        sig = signature_v0(row["viewport_name"], bbox, source)
        pair_key = (row["url_pair_id"], row["viewport_name"])
        clusters[source][sig].add(pair_key)
        pair_to_sigs[pair_key][source].add(sig)
        n_diffs[source] += 1
        cluster_member_counts[source][sig] += 1

    return {
        "session_id": session_id,
        "session_name": session_name,
        "clusters": clusters,
        "pair_to_sigs": pair_to_sigs,
        "n_diffs": n_diffs,
        "cluster_member_counts": cluster_member_counts,
    }


def topk_coverage(
    clusters_by_sig: dict[str, set],
    pair_to_sigs: dict[tuple, set],
    ks: list[int],
) -> list[tuple[int, int, float]]:
    """For each K in ks, return (K, pairs_fully_covered, fraction).

    A pair is "fully covered" iff every signature appearing in that pair
    belongs to the top-K-by-pair-count clusters."""
    # Order clusters by descending pair-count.
    ordered = sorted(
        clusters_by_sig.items(),
        key=lambda kv: (-len(kv[1]), kv[0]),
    )
    out = []
    total_pairs = len({p for sigs in pair_to_sigs.values() for _ in sigs for p in [None]})  # placeholder
    # Real total: number of pairs that have at least one signature in this source.
    total_pairs = len(pair_to_sigs)
    if total_pairs == 0:
        return [(k, 0, 0.0) for k in ks]

    for k in ks:
        top_sigs = {sig for sig, _ in ordered[:k]}
        covered = sum(1 for sigs in pair_to_sigs.values() if sigs and sigs.issubset(top_sigs))
        out.append((k, covered, covered / total_pairs))
    return out


def print_session_report(result: dict) -> None:
    sid = result["session_id"]
    name = result["session_name"]
    print()
    print("=" * 78)
    print(f"Session: {name}  ({sid[:8]}…)")
    print("=" * 78)

    for source in ("imagick", "lm"):
        n = result["n_diffs"][source]
        if n == 0:
            print(f"\n  [{source}] no differences")
            continue
        cluster_set = result["clusters"][source]
        n_clusters = len(cluster_set)
        raw_leverage = 1.0 - (n_clusters / n) if n else 0.0

        # Build pair_to_sigs restricted to this source.
        pair_to_sigs_src = {
            pk: sigs[source] for pk, sigs in result["pair_to_sigs"].items() if sigs[source]
        }
        n_pairs_with_diffs = len(pair_to_sigs_src)

        # Cluster size distribution (pairs per cluster).
        pair_counts = sorted((len(v) for v in cluster_set.values()), reverse=True)
        singletons = sum(1 for c in pair_counts if c == 1)
        top10 = pair_counts[:10]

        print(f"\n  [{source}]")
        print(f"    differences:           {n:>10,}")
        print(f"    clusters:              {n_clusters:>10,}")
        print(f"    raw leverage:          {raw_leverage:>10.4f}  (1 - clusters/diffs)")
        print(f"    pairs-with-diffs:      {n_pairs_with_diffs:>10,}")
        print(f"    singleton clusters:    {singletons:>10,}  ({100*singletons/n_clusters:.1f}%)")
        print(f"    top-10 cluster pairs:  {top10}")

        ks = [1, 3, 5, 10, 25, 50, 100]
        ks = [k for k in ks if k <= n_clusters]
        coverage = topk_coverage(cluster_set, pair_to_sigs_src, ks)
        print(f"    top-K coverage (pairs fully explained by top-K clusters):")
        for k, covered, frac in coverage:
            bar = "█" * int(frac * 40)
            print(f"      K={k:>3}  {covered:>7,} / {n_pairs_with_diffs:<7,}  {frac*100:5.1f}%  {bar}")

    # Combined view: union of imagick + lm signatures per pair.
    pair_to_all_sigs = {
        pk: sigs["imagick"] | sigs["lm"]
        for pk, sigs in result["pair_to_sigs"].items()
    }
    all_clusters: dict[str, set] = defaultdict(set)
    for pk, sigs in pair_to_all_sigs.items():
        for s in sigs:
            all_clusters[s].add(pk)

    print(f"\n  [combined: imagick + lm]")
    print(f"    distinct signatures:   {len(all_clusters):>10,}")
    print(f"    pairs-with-diffs:      {len(pair_to_all_sigs):>10,}")
    ks = [1, 3, 5, 10, 25, 50, 100]
    ks = [k for k in ks if k <= len(all_clusters)]
    coverage = topk_coverage(all_clusters, pair_to_all_sigs, ks)
    print(f"    top-K coverage:")
    for k, covered, frac in coverage:
        bar = "█" * int(frac * 40)
        print(f"      K={k:>3}  {covered:>7,} / {len(pair_to_all_sigs):<7,}  {frac*100:5.1f}%  {bar}")


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__)
        return 1
    db_path = argv[1]
    conn = connect_ro(db_path)
    sessions = fetch_sessions(conn)
    print(f"Found {len(sessions)} active session(s) in {db_path}")
    for s in sessions:
        result = analyse_session(conn, s["id"], s["name"])
        print_session_report(result)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
