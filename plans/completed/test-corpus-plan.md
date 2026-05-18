# Visual Compare Test Corpus Plan

## Goal

Build a fixed set of locally-served HTML pairs that exercises every behavior
our pipeline claims to handle, then run them at every equivalence level and
score the system on:

- **Sensitivity (true positives)** — pairs that *do* differ in user-visible
  ways must be flagged at the levels we expect.
- **Specificity (no false positives)** — pairs that are visually equivalent
  (or whose differences our pipeline explicitly suppresses — animations,
  banners we hide, lazy content below the fold) must NOT be flagged.

The output is a per-level scorecard plus a small set of recommendations (e.g.
"adjust `tolerant` band", "tighten anti-aliasing fuzz") grounded in real data
rather than guesses.

This is testing infrastructure — the test pages themselves are checked in
with the source so the corpus is reproducible. The runner is small and
imperative, not a new abstraction.

## Methodology

1. Each pair lives in `packages/web/public/fixtures/<pair-id>/{a,b}.html`
   with a sibling `expected.json` describing what we expect at each level.
   Vite already serves `/public` at the dev server, so pairs are reachable at
   `http://localhost:5173/fixtures/<pair-id>/a.html`.
2. A new script `packages/api/scripts/run-test-corpus.ts` (or a new CLI
   command) creates a session from the fixture URLs, kicks off a capture run
   at `desktop` viewport (and optionally `tablet`), then runs all five
   equivalence levels against that capture run and writes a markdown report
   to `tmp/test-corpus-report.md`.
3. The report compares each pair's actual verdict at each level against
   `expected.json` and flags mismatches.
4. The corpus is intentionally small (~14 pairs) so a full run on
   `gemma-4-e2b` finishes in under five minutes.

## Test corpus

The naming convention is `<category>-<phenomenon>`. Categories:
- `tp` — true positive (should flag)
- `fp` — false positive (should NOT flag)
- `cp` — capture-pipeline stress (verifies our readiness sequence works)
- `sm` — semantic-mode probe (pixel and meaning disagree)

### True-positive pairs

| ID | A → B | What it probes |
|---|---|---|
| `tp-typo` | "Welcome to our store" → "Welcome to our stores" | Tiny text edit; tests that strict catches it but tolerant *might* not |
| `tp-headline` | Hero headline replaced with different copy | Big localized text swap; should fail at strict and tolerant |
| `tp-cta-color` | Buy Now button green → red, same text | Brand-colour change; small area, large color delta |
| `tp-image-swap` | Hero image swapped (same dims) | Big localized pixel diff; semantic should still call non-equivalent |
| `tp-section-removed` | Features section gone in B | Layout shift everywhere below; should fail at all non-loose levels |
| `tp-banner-added` | B has a sale banner pushed in at top | Whole-page downward shift; pixel diff is huge across viewport |
| `tp-rearranged-cards` | Three product cards in a different order | Pixel diff is large but content is identical; LM should call equivalent |

### False-positive pairs (should pass)

| ID | A vs B | What it probes |
|---|---|---|
| `fp-identical` | Byte-identical HTML | Baseline; pixel-perfect must pass |
| `fp-killed-animation` | Page with a 2 s fade-in animation, captured at slightly different times | Verifies the animation-kill CSS injection holds |
| `fp-cookie-banner-hidden` | Banner present in both, hidden via `hideSelectors` | Verifies pre-capture selector hiding |
| `fp-lazy-below-fold` | Lazy image far below viewport differs in B but is never rendered above the fold | Verifies viewport-only screenshots stay stable |
| `fp-anti-aliasing` | Same page captured twice; relies on natural rendering jitter | Verifies SSIM + AE fuzz tolerate sub-pixel noise |

### Capture-pipeline stress

| ID | What | Why |
|---|---|---|
| `cp-web-fonts` | Page uses a Google Font with `font-display: swap` | Verifies `document.fonts.ready` waits eliminate FOUT |
| `cp-lazy-above-fold` | Image above the fold loads only after scroll | Verifies our scroll-bottom-and-back triggers it |

### Semantic-mode probes

These two pairs are designed so the pixel verdict and the semantic verdict
disagree. They're how we tell whether LM Studio is adding signal beyond what
the pixels already say.

| ID | What | Pixel verdict | Expected LM verdict |
|---|---|---|---|
| `sm-rearranged` | Same content, cards in different order | very different | equivalent |
| `sm-lorem-vs-real` | Same layout, A has Lorem ipsum body, B has real product copy | nearly identical | not equivalent |

## Infrastructure

- **Fixture server**: piggyback on `packages/web` Vite dev server. Files in
  `packages/web/public/fixtures/<pair-id>/{a,b}.html` are served at
  `http://localhost:5173/fixtures/<pair-id>/{a,b}.html`. No new server,
  no new package.
- **Shared assets** (logos, hero images, fonts) live under
  `packages/web/public/fixtures/_assets/` so multiple pairs reuse them.
- **`expected.json`** schema, one per pair:
  ```json
  {
    "description": "Hero headline replaced",
    "expected": {
      "pixel-perfect": false,
      "strict": false,
      "tolerant": false,
      "loose": null,
      "semantic": false
    },
    "notes": "Loose may pass depending on threshold tuning; that's the open question."
  }
  ```
  `null` means "either verdict is acceptable" — used when the pair sits near
  the boundary of a level.
- **`hideSelectors` per pair**: `expected.json` may include
  `capture_options.hideSelectors` if the pair needs the cookie-banner-style
  hide hook (today only `fp-cookie-banner-hidden` does).
- **`equivalence_overrides` per pair** (optional): if a pair needs a custom
  fuzz percent or threshold for the test to be meaningful, declare it here
  and have the runner apply it. Default: leave system defaults alone.

## Runner

`packages/api/scripts/run-test-corpus.ts` (invoked via `pnpm --filter
@visual-compare/api exec tsx scripts/run-test-corpus.ts`):

1. Discover pairs by globbing `packages/web/public/fixtures/*/expected.json`.
2. Build a CSV in memory and POST it to `/api/sessions` so we go through the
   real upload path.
3. Start one capture run for `desktop` (default) — opt into `tablet` via
   `--viewports desktop,tablet`.
4. Wait for capture to complete; if any capture errors, print and abort.
5. For each equivalence level, start a comparison run, poll until done, fetch
   results.
6. Cross-reference each row against the pair's `expected.json` and produce a
   markdown report:
   - per-level summary (pass/fail counts)
   - per-pair table showing actual verdict at each level vs expected
   - flagged mismatches with the AE %, SSIM, and (for semantic) the LM's
     summary text
7. Exit non-zero if any mismatches were "must" rather than `null`.

The report is written to `tmp/test-corpus-report.md` (gitignored). For CI
later we can also emit JSON.

## Run sequencing

Phase 1 — author the pairs and capture once. Eyeball each pair's screenshots
to confirm A and B truly differ (or don't) the way I designed. This is the
quickest way to find rendering surprises (e.g. a font I assumed works isn't
loaded, an animation isn't actually moving).

Phase 2 — run the full level matrix against the existing capture run. Look
at the report. Mismatches fall into:
- "system is wrong" → file a follow-up to tune
- "expected.json was wrong" → update the expectation, document why
- "level is genuinely ambiguous" → set the expectation to `null`

Phase 3 — once the matrix is clean on `desktop`, repeat at `tablet` to catch
viewport-specific regressions (e.g. a section that renders fine at 1440px
but collapses at 820px).

Phase 4 — try a stronger LM model on the `sm-*` and tougher `tp-*` pairs to
gauge whether `gemma-4-e2b` is the bottleneck on semantic verdicts. Same
pairs, different `LM_STUDIO_MODEL` env var; no code changes.

## Open questions for review

1. **Scope of corpus**: 14 pairs feels right to me — broad enough to
   exercise each phenomenon once, small enough to iterate quickly. Want
   more? Fewer?
2. **Page complexity**: I'm leaning towards keeping fixture pages simple
   (one or two visible sections, hand-written HTML, minimal CSS) so it's
   obvious where the differences are. Alternative: build them on a
   shared "realistic e-commerce" template so they look like production
   pages. The first is cheaper to author and easier to debug; the second
   is closer to real-world signal.
3. **Reporting**: markdown report only, or also a generated HTML page that
   embeds the diff images for visual review?
4. **CI integration**: out of scope for v1, but worth deciding whether the
   runner should be designed for headless CI from the start (no LM Studio
   dependency by default; semantic-mode pairs only run when LM is up).
5. **Adversarial pair**: should we include a deliberately *near*-pixel-band
   pair to probe LM tiebreaker quality? E.g. a 4.7% changed-pixel pair
   inside the `tolerant` band of [3, 7]. I think yes — call it
   `sm-band-tiebreak` — but flagging here for explicit confirmation.
