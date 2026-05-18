# v1 cluster-signature taxonomy

Concrete spec for the v1 cluster signature. Consumed by:
- the post-hoc validation experiment (next step in this branch)
- the LM prompt + zod schema changes (deferred until taxonomy validates)
- the proposal's §4 revision

## Signature

```
sig_v1 = sha1(viewport | region_role | change_type | normalize(element_label))
```

When `element_label` is empty or the LM emits `"other"`:
```
sig_v1_fallback = sha1(viewport | region_role | change_type | "__none__")
```

Three load-bearing categorical fields on each `differences` row. All three
must be present on LM-sourced rows (the prompt enforces it via the response
schema). Imagick-sourced rows do not get v1 tags — they're not part of the
cluster review unit (Finding 1 of Experiment A).

## change_type — what kind of change

10 values. The LM must pick exactly one per `differences` entry.

| value              | meaning | discriminator |
|---|---|---|
| `element_added`    | A visible element/section is present in B but not in A. | Element wasn't there before. |
| `element_removed`  | An element present in A is absent in B. | Element was there before. |
| `element_replaced` | A and B both have an element in the same slot, but they're different element types or different elements entirely (e.g. "single heading" → "list of items"). | Same slot, different element kind. |
| `text_changed`     | Same element, different text content (headline wording, breadcrumb path, paragraph copy). | Same element type, content differs. |
| `text_translated`  | Text on one side is in a different language than the other side. | Same content meaning, different language. |
| `image_changed`    | An image's content differs (different photo, different icon, different logo). Includes icon swaps. | Same image slot, different bitmap content. |
| `style_changed`    | Visual styling differs (color, typography, size, weight) but the content is unchanged. | Same content, different presentation. |
| `count_changed`    | A repeating structure (list, accordion, grid) has a different number of items, where the items are otherwise of the same kind. | Same component, more/fewer items. |
| `state_changed`    | The page is in a semantically different state on one side (error/404, empty state, login required, loading). | Page-level state change, not content edit. |
| `other`            | None of the above. Use sparingly; if many diffs fall here the taxonomy needs revision. | Last resort. |

Rule of thumb when categories overlap: pick the one that survives a
*description* test. If a reviewer is asked "what changed?" and would say
"the headline text changed", that's `text_changed`, not `element_replaced`,
even though strictly the element is the same. The LM should think
descriptively, not structurally.

### Special rule — single-element content edits

For these element types, ANY change to their content (rewording, path
expansion, level reordering, additional clauses) is `text_changed`, not
`element_added` / `element_replaced`. The element itself is one entity;
its content is what's changing.

- breadcrumbs
- main heading / secondary heading
- paragraph

`element_added` / `element_removed` apply only when the entire breadcrumb
strip / heading / paragraph is absent on one side. Surfaced during the v1
post-hoc validation experiment (otherwise the breadcrumb diffs split
across 4 clusters by change_type).

## region_role — where on the page

10 values. The LM must pick exactly one per `differences` entry. Inferred
from the bbox position + the surrounding visual context (the LM sees the
full screenshots, so context disambiguates).

| value           | meaning |
|---|---|
| `header`        | Top-of-page global bar with logo + top-level chrome. |
| `nav_primary`   | Primary navigation — top bar nav links, OR a sidebar nav that's the page's main wayfinding. |
| `nav_secondary` | Breadcrumbs, sub-nav, tab strips, in-page section nav. |
| `hero`          | Top-of-content banner/title area, above the main body. |
| `main_content`  | The primary article/page body. |
| `aside`         | A sidebar that is NOT primary navigation — related links, info panels, ads. |
| `footer`        | Bottom global bar. |
| `overlay`       | Modals, popovers, toast, cookie consent. |
| `alert_banner`  | Top-of-page announcement strip, sitewide alert. |
| `other`         | None of the above. |

**Boundary case to call out in the prompt:** the Altinn site has a left
sidebar that is *the* navigation for many pages. That's `nav_primary`, not
`aside`. The discriminator: if a user would click links here to navigate
the site, it's `nav_primary`; if it's supplemental context (related links,
metadata), it's `aside`.

### Element-implied region_role

For elements with a strong structural home, `region_role` is determined
by the element, not by bbox position. Surfaced during validation: the
simulator was tagging accordion items as `footer` because their bbox
centroid was low. Force the role from the label:

| element_label              | region_role     |
|---|---|
| sidebar navigation         | nav_primary     |
| top navigation             | nav_primary     |
| breadcrumbs                | nav_secondary   |
| main heading               | main_content    |
| secondary heading          | main_content    |
| accordion item             | main_content    |
| paragraph                  | main_content    |
| primary CTA                | main_content    |
| search input               | main_content    |
| form field                 | main_content    |
| list item                  | main_content    |
| page state                 | main_content    |
| language                   | main_content    |
| hero image                 | hero            |
| announcement               | alert_banner    |
| cookie banner              | overlay         |
| logo                       | header          |
| header                     | header          |
| footer                     | footer          |

For non-canonical (freeform) labels, region_role is set by the LM from
visual context.

## element_label — what specifically changed

A short noun phrase (≤ 64 chars) naming the element. The prompt instructs
the LM to **prefer canonical forms** from the list below when applicable;
otherwise emit a short noun phrase. Runtime normalization is intentionally
minimal — the LM does the canonicalisation work.

### Canonical-form list (in prompt)

| canonical form          | covers (examples) |
|---|---|
| `main heading`          | page title, h1, primary heading, main headline |
| `secondary heading`     | h2, section title, sub-heading |
| `breadcrumbs`           | breadcrumb path, navigation trail |
| `sidebar navigation`    | left/right sidebar nav, side menu, sidebar nav menu |
| `top navigation`        | top bar, header nav, global nav |
| `footer`                | page footer, site footer, footer area |
| `header`                | page header, site header, header area |
| `announcement`          | service announcement, site announcement, banner alert |
| `cookie banner`         | cookie consent, gdpr banner |
| `accordion item`        | expandable section, collapsible panel, accordion entry |
| `list item`             | item in a list/grid (use with `count_changed`) |
| `paragraph`             | body paragraph, explanatory text block |
| `primary CTA`           | call-to-action button, start-service button, primary action button |
| `search input`          | search bar, search field, search box |
| `form field`            | input, dropdown, checkbox, radio (specify type in description) |
| `hero image`            | top banner image, hero photo |
| `logo`                  | brand logo, site logo |
| `icon`                  | icon, glyph, decorative mark |
| `page state`            | use with `state_changed` (404, empty state, login wall) |
| `language`              | use with `text_translated` |

Any element that doesn't fit a canonical form gets a short freeform label
(e.g. `"contact information block"`, `"municipality search section"`).

### Runtime normalisation

```python
def normalize_label(s: str) -> str:
    s = s.strip().lower()
    s = re.sub(r"[^a-z0-9\s\-']+", "", s)  # keep alphanumerics, hyphens, apostrophes
    s = re.sub(r"\s+", " ", s)
    return s
```

Deliberately *not* applying synonym substitution at runtime. If the LM
emits `"left sidebar menu"` instead of canonical `"sidebar navigation"`,
that becomes its own cluster — visible to the reviewer, mergeable manually
via the "split/merge cluster" UI affordance. Better to surface the
inconsistency than hide it behind a fragile synonym map.

If a session shows persistent canonical-form drift, the fix is to update
the prompt's canonical list, not the runtime normaliser.

## How this fixes Experiment A's failures

**Under-clustering — 3 sidebar clusters become 1:**

Cluster #1 (cell 5,1), #2 (cell 6,1), #8 (cell 7,1) — all "sidebar
navigation menu added on left side". Under v1:
- `change_type = element_added` for all 3
- `region_role = nav_primary` for all 3
- `element_label = sidebar navigation` (canonical) for all 3
- Same viewport — `desktop`

→ Single v1 cluster. 446 pairs reviewed as one decision.

Same logic merges clusters #3+#5 ("main heading changed" → all
`text_changed / main_content / main heading`) and clusters #6+#9
("municipality search section added" → all `element_added / main_content /
municipality search section` or similar).

**Over-clustering — cluster #7 splits into 4 distinct clusters:**

| original diff | v1 tags |
|---|---|
| "First announcement removed" | `element_removed / alert_banner / announcement` |
| "List of multiple items vs single entry" | `element_replaced / main_content / services list` (or `count_changed`) |
| "Accordion item removed" | `element_removed / main_content / accordion item` |
| "New paragraph added explaining RR-0002" | `element_added / main_content / paragraph` |

→ 4 distinct clusters where v0 had 1. Reviewer makes 4 decisions instead
of 1, but each is actually safe to apply.

## Validation plan for the next step

1. Hand-tag the top 20 LM clusters from the sitemap session using the v1
   taxonomy. Each cluster's representative diff gets `(change_type,
   region_role, element_label)`. Also tag the *cluster members* that
   appeared to differ from the cluster's representative (for cluster #7,
   that's all 4 sample diffs).
2. Recompute clusters using v1 signature on the hand-tagged data.
3. Measure:
   - **Coverage**: does the same top-K coverage curve hold or improve?
   - **Under-clustering fix**: did the 3 sidebar clusters merge into 1?
   - **Over-clustering fix**: did cluster #7 split into ≥ 3 distinct
     clusters whose members are semantically coherent?
4. If both pass, lock the taxonomy and move to the prompt/schema change.

## Stop conditions

- If v1 doesn't fix either failure mode, the taxonomy is wrong — iterate
  before touching the prompt.
- If v1 fixes one but not the other (e.g. under-clustering merged but #7
  still lumps things), add a discriminating field (e.g. require
  element_label specificity per change_type) rather than ship.
- If v1 fixes both but creates *new* failures (some other top cluster
  becomes incoherent under hand-tagging), surface them in the findings doc
  and decide whether to expand the taxonomy or ship-with-known-limits.

## Why this is testable without changing the LM prompt today

The validation experiment uses the existing LM `description` and
`lm_diff_summary` text — already in the DB — and asks "*if* the LM
emitted v1 tags from the same evidence, which tags would it emit?". I
hand-label that mapping. The resulting v1 signatures over existing data
give a fair (slight pessimistic) estimate of how v1 will cluster once the
prompt actually emits the fields, because the LM seeing images directly
has more context than I do reading its summaries.
