"""
Experiment B (simulation) — test the v1 cluster signature against the same
existing LM differences that v0 was measured on, by deriving v1 tags from
the LM `description` text via rule-based pattern matching.

This is a proxy for what the real LM would emit under the v1 prompt. The
rules below are intentionally simple keyword/verb patterns — if rules
*this* crude can cleanly separate v0's failure modes (sidebar
under-clustering, cluster #7 over-clustering), the actual LM emitting tags
directly from images will at least match.

What this can't tell us:
  - Whether the LM will reliably emit canonical element_label forms when
    instructed by the prompt. That needs a live test.
  - Whether the LM's region_role assignment matches our intent on
    boundary cases (sidebar-as-primary-nav vs sidebar-as-aside).

What this CAN tell us:
  - Whether the v1 taxonomy has enough discriminating power, in principle,
    to fix the v0 failure modes.

Usage:
  python3 experiment_b_v1_simulation.py <db> [session_name_substring]
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass
from typing import Optional


# ---------------------------------------------------------------------------
# v1 simulator — derive (change_type, region_role, element_label) from text
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class V1Tags:
    change_type: str
    region_role: str
    element_label: str  # already normalised (lowercased, whitespace-collapsed)


# Verb signal → change_type
ADDED_PATTERNS = re.compile(
    r"\b(added|appears?|introduced|new (?:section|paragraph|item|sidebar|menu|button|block|search|content|element|banner)|now (?:shows?|contains?|displays?|includes?)|has been added)\b",
    re.IGNORECASE,
)
REMOVED_PATTERNS = re.compile(
    r"\b(removed|no longer (?:present|visible|shown)|absent|missing|has been removed|disappeared|deleted)\b",
    re.IGNORECASE,
)
REPLACED_PATTERNS = re.compile(
    r"\b(replaced|instead of|swapped|changed from .{1,40} to|became|now shows? .{0,40} instead)\b",
    re.IGNORECASE,
)
EXPANDED_LIST_PATTERNS = re.compile(
    r"\b(list of (?:multiple|several|\d+)|multiple items? instead|single (?:item|entry) (?:became|replaced|changed)|expanded with|more (?:items?|entries))\b",
    re.IGNORECASE,
)


# region_role signal — keyword anchors that the LM description tends to use.
REGION_PATTERNS = [
    ("nav_primary", re.compile(r"\b(sidebar (?:nav|navigation|menu)|side (?:nav|navigation|menu)|left (?:sidebar|side bar|side panel))\b", re.IGNORECASE)),
    ("nav_secondary", re.compile(r"\bbreadcrumb", re.IGNORECASE)),
    ("alert_banner", re.compile(r"\b(announcement|banner alert|alert banner|service announcement|site announcement)\b", re.IGNORECASE)),
    ("header", re.compile(r"\b(top bar|page header|site header|global header)\b", re.IGNORECASE)),
    ("footer", re.compile(r"\b(footer|page footer|site footer)\b", re.IGNORECASE)),
    ("hero", re.compile(r"\b(hero (?:image|banner|section)|top banner|main banner)\b", re.IGNORECASE)),
    ("overlay", re.compile(r"\b(modal|popup|pop-up|cookie banner|cookie consent|overlay)\b", re.IGNORECASE)),
    ("aside", re.compile(r"\b(right (?:sidebar|panel|rail)|related links|info panel)\b", re.IGNORECASE)),
]


# element_label signal — canonical forms keyed by description keyword.
LABEL_PATTERNS = [
    ("sidebar navigation", re.compile(r"\b(sidebar (?:nav|navigation|menu)|side (?:nav|navigation|menu)|left side menu)\b", re.IGNORECASE)),
    ("breadcrumbs", re.compile(r"\bbreadcrumb", re.IGNORECASE)),
    ("main heading", re.compile(r"\b(main (?:heading|headline)|primary heading|primary headline|page title|main content headline|main title)\b", re.IGNORECASE)),
    ("secondary heading", re.compile(r"\b(section (?:heading|title)|sub-heading|secondary heading|h2)\b", re.IGNORECASE)),
    ("announcement", re.compile(r"\bannouncement\b", re.IGNORECASE)),
    ("accordion item", re.compile(r"\baccordion\b", re.IGNORECASE)),
    ("paragraph", re.compile(r"\b(paragraph|text block|body text)\b", re.IGNORECASE)),
    ("primary CTA", re.compile(r"\b((?:start service|start|call.to.action|cta|primary action) button)\b", re.IGNORECASE)),
    ("search input", re.compile(r"\b(search (?:bar|input|field|box))\b", re.IGNORECASE)),
    ("page state", re.compile(r"\b(page not found|404|error (?:page|screen|message)|login (?:required|wall)|empty state)\b", re.IGNORECASE)),
    ("language", re.compile(r"\b(in (?:norwegian|english|spanish|french|german)|different language|language)\b", re.IGNORECASE)),
    ("footer", re.compile(r"\bfooter\b", re.IGNORECASE)),
    ("header", re.compile(r"\bheader\b", re.IGNORECASE)),
    ("cookie banner", re.compile(r"\b(cookie (?:banner|consent))\b", re.IGNORECASE)),
    ("logo", re.compile(r"\blogo\b", re.IGNORECASE)),
    ("icon", re.compile(r"\bicon\b", re.IGNORECASE)),
    ("hero image", re.compile(r"\bhero (?:image|photo|banner)\b", re.IGNORECASE)),
    ("form field", re.compile(r"\b(form field|input field|dropdown|checkbox|radio button|form input)\b", re.IGNORECASE)),
    ("contact information", re.compile(r"\b(contact information|contact info|contact details)\b", re.IGNORECASE)),
]


def derive_change_type(desc: str) -> str:
    # Order matters: more-specific patterns first.
    if EXPANDED_LIST_PATTERNS.search(desc):
        return "count_changed"
    if re.search(r"\b(in (?:norwegian|english|spanish|french|german)|different language|translated)\b", desc, re.IGNORECASE):
        return "text_translated"
    if re.search(r"\b(page not found|404|error (?:page|screen|message)|empty state|login (?:required|wall))\b", desc, re.IGNORECASE):
        return "state_changed"
    # Special rule for breadcrumb / headline / paragraph: any "change" to
    # these is `text_changed`, regardless of whether the LM's description
    # uses verbs like "added" or "changed from X to Y". The element itself
    # isn't being added/removed; only its text content is.
    if re.search(r"\b(breadcrumb|headline|heading|title|paragraph)\b", desc, re.IGNORECASE):
        # But: if the element is *entirely* added/removed (i.e. there's no
        # such thing in the other side), respect that.
        if re.search(r"\b(no (?:headline|heading|title|breadcrumb|paragraph)|missing (?:headline|heading|title|breadcrumb|paragraph))\b", desc, re.IGNORECASE):
            return "element_removed" if REMOVED_PATTERNS.search(desc) else "element_added"
        return "text_changed"
    if REMOVED_PATTERNS.search(desc):
        return "element_removed"
    if ADDED_PATTERNS.search(desc):
        return "element_added"
    if REPLACED_PATTERNS.search(desc):
        return "element_replaced"
    if re.search(r"\b(changed|differs?|different|updated|modified)\b", desc, re.IGNORECASE):
        if re.search(r"\b(text|heading|headline|title|breadcrumb|paragraph|copy|wording)\b", desc, re.IGNORECASE):
            return "text_changed"
        if re.search(r"\b(image|photo|icon|logo)\b", desc, re.IGNORECASE):
            return "image_changed"
        if re.search(r"\b(color|colour|font|style|size|typography)\b", desc, re.IGNORECASE):
            return "style_changed"
        return "text_changed"  # most "X changed" diffs are text
    return "other"


# element_label → region_role mapping. When the LM identifies an element
# by its canonical label, the region role is largely implied — accordion
# items live in main_content, breadcrumbs in nav_secondary, etc. This
# overrides any bbox-based heuristic for ambiguous cases.
LABEL_TO_REGION = {
    "sidebar navigation": "nav_primary",
    "top navigation": "nav_primary",
    "breadcrumbs": "nav_secondary",
    "main heading": "main_content",
    "secondary heading": "main_content",
    "accordion item": "main_content",
    "paragraph": "main_content",
    "primary CTA": "main_content",
    "primary cta": "main_content",
    "search input": "main_content",
    "page state": "main_content",
    "contact information": "main_content",
    "language": "main_content",
    "list item": "main_content",
    "form field": "main_content",
    "hero image": "hero",
    "announcement": "alert_banner",
    "cookie banner": "overlay",
    "logo": "header",
    "header": "header",
    "footer": "footer",
    "icon": "main_content",
}


def derive_region_role(desc: str, bbox: dict, label: str) -> str:
    # Prefer the canonical-element-implied region role.
    if label in LABEL_TO_REGION:
        return LABEL_TO_REGION[label]
    for role, pattern in REGION_PATTERNS:
        if pattern.search(desc):
            return role
    # Fallback to bbox-based heuristic.
    cx = bbox.get("x", 0) + bbox.get("width", 0) / 2.0
    cy = bbox.get("y", 0) + bbox.get("height", 0) / 2.0
    # Left-column → nav_primary (Altinn convention) only if bbox is tall.
    if cx < 25 and bbox.get("height", 0) > 30:
        return "nav_primary"
    if cy < 10:
        return "header"
    if cy > 90:
        return "footer"
    return "main_content"


def derive_element_label(desc: str) -> str:
    for canonical, pattern in LABEL_PATTERNS:
        if pattern.search(desc):
            return canonical
    # No canonical match: extract a short noun phrase as a fallback.
    # Crude: take the first noun-ish chunk of up to 5 words.
    cleaned = re.sub(r"[^a-zA-Z\s\-]+", " ", desc.lower())
    words = cleaned.split()
    # Drop common verbs/qualifiers at the start.
    skip = {"a", "an", "the", "new", "added", "removed", "changed", "replaced", "is", "was", "has", "have", "been"}
    while words and words[0] in skip:
        words.pop(0)
    return " ".join(words[:4]) if words else "other"


def normalize_label(s: str) -> str:
    s = s.strip().lower()
    s = re.sub(r"[^a-z0-9\s\-']+", "", s)
    s = re.sub(r"\s+", " ", s)
    return s


def derive_v1_tags(desc: str, bbox: dict) -> V1Tags:
    label = normalize_label(derive_element_label(desc))
    return V1Tags(
        change_type=derive_change_type(desc),
        region_role=derive_region_role(desc, bbox, label),
        element_label=label,
    )


def signature_v1(viewport: str, tags: V1Tags) -> str:
    label = tags.element_label if tags.element_label and tags.element_label != "other" else "__none__"
    raw = f"{viewport}|{tags.region_role}|{tags.change_type}|{label}"
    return hashlib.sha1(raw.encode()).hexdigest()[:12]


# ---------------------------------------------------------------------------
# Analysis
# ---------------------------------------------------------------------------

def topk_coverage(clusters_by_sig, pair_to_sigs, ks):
    ordered = sorted(clusters_by_sig.items(), key=lambda kv: (-len(kv[1]), kv[0]))
    total = len(pair_to_sigs)
    out = []
    if total == 0:
        return [(k, 0, 0.0) for k in ks]
    for k in ks:
        top = {s for s, _ in ordered[:k]}
        covered = sum(1 for sigs in pair_to_sigs.values() if sigs and sigs.issubset(top))
        out.append((k, covered, covered / total))
    return out


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 1
    db_path = argv[1]
    name_substr = argv[2] if len(argv) >= 3 else "sitemap"

    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    session = conn.execute(
        "SELECT id, name FROM sessions WHERE name LIKE ? AND archived_at IS NULL ORDER BY created_at DESC LIMIT 1",
        (f"%{name_substr}%",),
    ).fetchone()
    if not session:
        print(f"No session matching '{name_substr}'")
        return 1

    print(f"Session: {session['name']}  ({session['id'][:8]}…)\n")

    rows = list(conn.execute(
        """
        SELECT d.description AS desc, d.bounding_box_json AS bbox,
               c.url_pair_id AS pair_id, c.viewport_name AS vp,
               c.lm_diff_summary AS comp_summary,
               p.url_a AS url_a
        FROM differences d
        JOIN comparisons c ON c.id = d.comparison_id
        JOIN url_pairs p ON p.id = c.url_pair_id
        WHERE p.session_id = ? AND d.source = 'lm' AND d.bounding_box_json IS NOT NULL
        """,
        (session["id"],),
    ))

    clusters: dict[str, set] = defaultdict(set)
    pair_to_sigs: dict[tuple, set] = defaultdict(set)
    sig_to_tags: dict[str, V1Tags] = {}
    sig_to_samples: dict[str, list[dict]] = defaultdict(list)

    tag_counts: dict[str, Counter] = {
        "change_type": Counter(),
        "region_role": Counter(),
        "element_label": Counter(),
    }

    for row in rows:
        try:
            bbox = json.loads(row["bbox"])
        except (json.JSONDecodeError, TypeError):
            continue
        desc = row["desc"] or ""
        tags = derive_v1_tags(desc, bbox)
        sig = signature_v1(row["vp"], tags)
        pair_key = (row["pair_id"], row["vp"])
        clusters[sig].add(pair_key)
        pair_to_sigs[pair_key].add(sig)
        sig_to_tags[sig] = tags
        if len(sig_to_samples[sig]) < 5:
            sig_to_samples[sig].append({
                "desc": desc[:120],
                "comp_summary": (row["comp_summary"] or "")[:120],
                "url": (row["url_a"] or "")[:80],
            })
        tag_counts["change_type"][tags.change_type] += 1
        tag_counts["region_role"][tags.region_role] += 1
        tag_counts["element_label"][tags.element_label] += 1

    n_diffs = sum(tag_counts["change_type"].values())
    n_clusters = len(clusters)
    n_pairs = len(pair_to_sigs)

    print(f"v1 simulation results:")
    print(f"  LM differences:     {n_diffs:>7,}")
    print(f"  v1 clusters:        {n_clusters:>7,}")
    print(f"  raw leverage:       {1 - n_clusters/n_diffs if n_diffs else 0:>7.4f}")
    print(f"  pairs-with-diffs:   {n_pairs:>7,}")
    print()

    print("change_type distribution:")
    for ct, n in tag_counts["change_type"].most_common():
        print(f"  {ct:<20} {n:>6,}")
    print("\nregion_role distribution:")
    for rr, n in tag_counts["region_role"].most_common():
        print(f"  {rr:<20} {n:>6,}")
    print("\nelement_label distribution (top 20):")
    for el, n in tag_counts["element_label"].most_common(20):
        print(f"  {el:<35} {n:>6,}")
    print()

    ks = [1, 3, 5, 10, 25, 50, 100]
    ks = [k for k in ks if k <= n_clusters]
    coverage = topk_coverage(clusters, pair_to_sigs, ks)
    print("Top-K pair coverage (v1):")
    for k, covered, frac in coverage:
        bar = "█" * int(frac * 40)
        print(f"  K={k:>3}  {covered:>6,} / {n_pairs:<6,}  {frac*100:5.1f}%  {bar}")
    print()

    print("Top 15 v1 clusters by pair-count:")
    print()
    ordered = sorted(clusters.items(), key=lambda kv: -len(kv[1]))[:15]
    for rank, (sig, pair_set) in enumerate(ordered, start=1):
        tags = sig_to_tags[sig]
        n_p = len(pair_set)
        samples = sig_to_samples[sig]
        print(f"  #{rank:>2}  {n_p:>4} pairs  | {tags.change_type:<18} {tags.region_role:<15} | {tags.element_label}")
        for s in samples[:3]:
            print(f"          ◦ {s['desc']}")
        print()

    # Targeted failure-mode checks.
    print("=" * 78)
    print("Failure-mode checks vs v0:")
    print("=" * 78)

    # Sidebar merge check: how many pairs are now in a single "sidebar
    # navigation added" cluster vs split across multiple in v0?
    sidebar_sigs = [
        sig for sig, tags in sig_to_tags.items()
        if tags.element_label == "sidebar navigation" and tags.change_type == "element_added"
    ]
    sidebar_pairs = set()
    for sig in sidebar_sigs:
        sidebar_pairs.update(clusters[sig])
    print(f"\n  Sidebar-added cluster: {len(sidebar_sigs)} v1 cluster(s), {len(sidebar_pairs)} unique pairs")
    print(f"  (v0 had 3+ separate clusters for the same change.)")
    if len(sidebar_sigs) == 1:
        print(f"  ✓ Under-clustering FIXED.")
    elif len(sidebar_sigs) == 0:
        print(f"  ✗ No 'sidebar navigation added' cluster detected — classifier rules may be too strict.")
    else:
        print(f"  ~ Partial: still {len(sidebar_sigs)} clusters. Investigate why they didn't merge.")

    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
