# How to update the user guide

The user-facing walkthrough lives at [`docs/getting-started.md`](getting-started.md).
Its screenshots are driven by a Playwright script that walks the real
dev UI — there's no Figma source, no manual capture step. When the UI
shifts, the script re-shoots; when the wording shifts, you edit the
markdown.

## Layout

```
docs/
├── getting-started.md                  ← the guide
├── getting-started/screenshots/
│   ├── 01-sessions-page.png
│   ├── 02-url-pairs-tab.png
│   └── … (10 files, numbered so the markdown order = filesystem order)
└── HOW_TO_UPDATE_THE_USER_GUIDE.md     ← this file

scripts/
└── screenshot-getting-started.mjs      ← Playwright capture script
```

## Regenerating the screenshots

```sh
mise exec -- pnpm dev                       # API on :3011, Vite on :5173
mise exec -- node scripts/screenshot-getting-started.mjs
```

The script reuses the Playwright + Chromium install under
`packages/api/node_modules/playwright` (kept warm by
`pnpm install:playwright`), so there's no separate dependency to
install. It writes 10 PNGs at 2x DPI into
`docs/getting-started/screenshots/`, overwriting whatever was there.

Each capture step opens a clean page, navigates by URL, waits for
network-idle plus a short settle delay, and screenshots. Steps that
need a specific UI state (a tab clicked, a `<details>` opened, the
shortcuts overlay shown) drive the UI with normal Playwright
locators / `keyboard` / `evaluate` before shooting.

## The session-ID dependency

The script targets two sessions that already exist in the dev SQLite
DB. They're the only "external" inputs:

```js
const SMALL_SESSION = '1e643e71-...';  // altinn-en-about, 6 pairs       — steps 1–4 (Config / URL pairs)
const RICH_SESSION  = '33d3ad43-...';  // altinn-prod-vs-at22, 5127 pairs — steps 5–10 (Clusters / Anomalies)
```

The constants live at the top of `scripts/screenshot-getting-started.mjs`.
If a session is deleted, renamed, or replaced — or you check out a
fresh worktree with a different DB — update those two IDs before
running. To find replacement candidates:

```sh
sqlite3 data/visual-compare.sqlite "
  SELECT s.id, s.name,
         (SELECT COUNT(*) FROM url_pairs WHERE session_id = s.id) AS pairs,
         (SELECT COUNT(*) FROM difference_clusters
            WHERE session_id = s.id AND signature_version = 'v1') AS v1_clusters
  FROM sessions s
  ORDER BY v1_clusters DESC, pairs DESC
  LIMIT 10;
"
```

Pick:

- `SMALL_SESSION` — small pair count (≤ ~10) so the URL pairs table
  fits on screen.
- `RICH_SESSION` — many v1-signature clusters so the Clusters and
  Anomalies screens are populated. The Anomalies screenshot needs at
  least a handful of singleton clusters; the Cluster Detail screenshot
  expects multiple members on a single signature.

The cluster-detail screenshot also targets a specific cluster by ID
(`focusedClusterId`), which lives a few lines below the session
constants. Pick any cluster row with `pair_count >= 5` and an
`element_label` set:

```sh
sqlite3 data/visual-compare.sqlite "
  SELECT id, change_type, region_role, element_label, pair_count
  FROM difference_clusters
  WHERE session_id = '<RICH_SESSION>' AND signature_version = 'v1'
  ORDER BY pair_count DESC
  LIMIT 5;
"
```

## Editing the guide itself

The markdown references screenshots by relative path:

```md
![…](getting-started/screenshots/04-lm-prompts.png)
```

Keep that scheme — the doc-and-asset-folder share a name so a single
`mv` would relocate both together later.

When you add a new section that needs a screenshot:

1. Add a numbered step to `main()` in
   `scripts/screenshot-getting-started.mjs` — keep the filename
   numeric prefix in step order (`NN-name.png`) so the screenshots
   directory sorts the same way the doc reads.
2. Drive the UI with Playwright locators that key off **stable**
   selectors (in order of preference): `aria-label`,
   `role` + accessible name, `<details>`/`<summary>` text. Avoid
   class names — they're refactor fodder.
3. Re-run the script; eyeball the new PNG; reference it from the
   markdown.

## Selector pitfalls learned the hard way

A few sharp edges the script has already had to work around — preserve
the workarounds when you copy patterns out of it:

- **"Config" appears twice** — once as a top-level review-mode tab and
  once as a Config sub-tab. Scope by tablist:
  `page.getByRole('tablist', { name: 'Config section' })` before
  `.getByRole('tab', { name: /^Config$/ })`.
- **Nested `<details>`** — the LM prompts panel contains an
  "Advanced: edit the raw system prompt" `<details>` inside the outer
  "LM prompts" `<details>`. Target the outer `<summary>` directly with
  `page.locator('summary').filter({ hasText: /^LM prompts/ })`.
- **Keyboard shortcut for `?`** — the SessionDetailPage listener keys
  on `event.key === '?'`. `page.keyboard.press('Shift+/')` does not
  reliably produce that key on macOS Chromium; the working incantation
  is `page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true })))`.
- **Empty default category tab** — `?mode=clusters` lands on the first
  non-empty cluster category, which varies by session. For a
  populated screenshot, explicitly click the **Main** tab:
  `page.getByRole('tablist', { name: 'Cluster category' }).getByRole('tab', { name: /^Main/ }).click()`.

## When to update vs. when to re-shoot

| Change                                                         | Action                                                                     |
| -------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Wording in the doc                                             | Edit the markdown. No re-shoot needed.                                     |
| UI label or layout shift (e.g. button rename, new config field) | Re-run the script. If a selector breaks, fix it; if the new control needs callouts, edit the markdown too. |
| New feature gets its own section                                | Add a step to the script + a section to the markdown.                      |
| Demo sessions wiped / regenerated                               | Pick new session IDs (see the SQL above) and update the constants at the top of the script. |
