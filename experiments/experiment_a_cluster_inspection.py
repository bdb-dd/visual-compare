"""
Follow-up to experiment_a_v0_leverage.py — inspect the actual contents of the
top LM clusters to see whether the v0 geometric signature is producing
semantically coherent groups or collapsing distinct changes.

For each top-N LM cluster in a session:
  - Print the cluster key (grid cell, size band)
  - Sample LM `differences.description` text from cluster members
  - Sample URL pairs the cluster spans
  - Show the comparison's lm_diff_summary for those samples

This is the precision check Experiment A skipped. v0's headline leverage
is only meaningful if the top clusters are actually about the same change.

Usage:
  python3 experiment_a_cluster_inspection.py <db> [session_name_substring] [top_n=10]
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import sys
from collections import defaultdict


GRID = 10
SIZE_BANDS = [("xs", 0.1), ("s", 1.0), ("m", 5.0), ("l", 20.0), ("xl", float("inf"))]


def size_band(area_pct: float) -> str:
    for name, ceiling in SIZE_BANDS:
        if area_pct < ceiling:
            return name
    return "xl"


def grid_cell(x: float, y: float, w: float, h: float) -> tuple[int, int]:
    cx = max(0.0, min(99.999, x + w / 2.0))
    cy = max(0.0, min(99.999, y + h / 2.0))
    col = int(cx / (100.0 / GRID))
    row = int(cy / (100.0 / GRID))
    return row, col


def sig_v0(viewport: str, bbox: dict, source: str) -> tuple[str, tuple[int, int], str]:
    cell = grid_cell(bbox["x"], bbox["y"], bbox["width"], bbox["height"])
    band = size_band(bbox["width"] * bbox["height"])
    return (viewport, cell, band)


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 1
    db_path = argv[1]
    name_substr = argv[2] if len(argv) >= 3 else ""
    top_n = int(argv[3]) if len(argv) >= 4 else 10

    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row

    session = conn.execute(
        "SELECT id, name FROM sessions WHERE name LIKE ? AND archived_at IS NULL ORDER BY created_at DESC LIMIT 1",
        (f"%{name_substr}%",),
    ).fetchone()
    if not session:
        print(f"No session matching '{name_substr}'")
        return 1
    print(f"Session: {session['name']}  ({session['id']})")

    # Group LM differences by v0 signature.
    rows = conn.execute(
        """
        SELECT
            d.description       AS desc,
            d.severity          AS severity,
            d.bounding_box_json AS bbox,
            c.url_pair_id       AS pair_id,
            c.viewport_name     AS vp,
            c.lm_diff_summary   AS comp_summary,
            p.url_a             AS url_a,
            p.label             AS label
        FROM differences d
        JOIN comparisons c ON c.id = d.comparison_id
        JOIN url_pairs   p ON p.id = c.url_pair_id
        WHERE p.session_id = ? AND d.source = 'lm' AND d.bounding_box_json IS NOT NULL
        """,
        (session["id"],),
    ).fetchall()

    clusters: dict[tuple, list[sqlite3.Row]] = defaultdict(list)
    for row in rows:
        try:
            bbox = json.loads(row["bbox"])
        except (json.JSONDecodeError, TypeError):
            continue
        key = sig_v0(row["vp"], bbox, "lm")
        clusters[key].append(row)

    # Order by pair count desc (matches the leverage script).
    by_pair_count = sorted(
        clusters.items(),
        key=lambda kv: -len({r["pair_id"] for r in kv[1]}),
    )

    print(f"\nTop {top_n} LM clusters by pair-count (out of {len(clusters)} total):\n")
    for rank, (key, members) in enumerate(by_pair_count[:top_n], start=1):
        viewport, (row_idx, col_idx), band = key
        n_pairs = len({m["pair_id"] for m in members})
        sev_counts = defaultdict(int)
        for m in members:
            sev_counts[m["severity"] or "—"] += 1
        sev_summary = ", ".join(f"{k}:{v}" for k, v in sorted(sev_counts.items()))

        print(f"─── Cluster #{rank}  cell=({row_idx},{col_idx}) band={band} ─── {n_pairs} pairs, {len(members)} diffs ───")
        print(f"    severities: {sev_summary}")
        # Up to 4 sample descriptions from distinct pairs
        seen_pairs = set()
        samples = []
        for m in members:
            if m["pair_id"] in seen_pairs:
                continue
            seen_pairs.add(m["pair_id"])
            samples.append(m)
            if len(samples) >= 4:
                break
        for s in samples:
            desc = (s["desc"] or "").strip().replace("\n", " ")
            comp_summary = (s["comp_summary"] or "").strip().replace("\n", " ")
            url = s["url_a"][:64]
            print(f"      diff: {desc[:90]}")
            if comp_summary:
                print(f"        comp: {comp_summary[:90]}")
            print(f"        url:  {url}")
        print()

    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
