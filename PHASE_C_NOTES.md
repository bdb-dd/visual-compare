# Phase C — v3 prompt cutover

Status: committed. Next time the API boots, the `lm_prompt_defaults` table
auto-upgrades any `source = 'seed'` row to the new v1-taxonomy prompt body;
admin-overridden rows (`source = 'override'`) are preserved.

## What changed

- `constants/lm-prompts.ts` — the `SHARED_BODY` now includes the cluster
  taxonomy instructions (changeType / regionRole / elementLabel, with the
  canonical-label list, the breadcrumb special rule, and three worked
  examples). The two mode-specific suffixes (`TARGET_LEVEL_FAILURE_PROMPT`,
  `AMBIGUOUS_PIXEL_RESULT_PROMPT`) compose around it.
- `services/lm.ts` — `DEFAULT_PROMPT_VERSION` bumped to `'v3'`. The
  duplicated `SYSTEM_PROMPT_V3` constant was removed; the constants file is
  now the single source of truth.
- Schema selection is **content-based** (`usesV1Taxonomy` /
  `jsonSchemaForPrompt`). Any prompt text containing both `changeType` and
  `regionRole` gets the strict v3 JSON schema sent in `response_format`.
  Session-scoped prompts identified by sha256 hash no longer route to the
  wrong schema.
- `seedLmPromptDefaults` upserts seed-sourced rows when the constants
  diverge from the DB. Idempotent — re-running on an already-current DB is
  a no-op.

## Per-session upgrade procedure

Existing sessions retain their v2 prompts after Phase C lands. To upgrade
one:

**Via the web UI**: open the session, go to the LM prompt editor, click
"Reset to defaults" for each invocation reason (`target_level_failure` and
`ambiguous_pixel_result`).

**Via the API**:
```
POST /api/sessions/<session_id>/lm-prompts/target_level_failure/reset
POST /api/sessions/<session_id>/lm-prompts/ambiguous_pixel_result/reset
```

Either path overwrites the session's `lm_prompts` row with the current
defaults (now v3). The next evaluation against that session will:

1. Send the v3 system prompt + the strict v3 JSON schema to LM Studio.
2. Get back differences with `changeType` / `regionRole` / `elementLabel`
   populated.
3. Persist those into the new `differences` columns.
4. Compute v1 signatures inline (the dispatcher in `cluster-signature.ts`
   picks v1 over v0 when all three tags are present).

## Cache invalidation note

`lm_verdict_cache` uses `prompt_id` (sha256 of the prompt text) as part of
its primary key. Changing a session's prompt → new prompt_id → cache miss
for every previously-cached LM verdict in that session. **First evaluation
after the cutover re-runs the LM for every comparison that needs a verdict
under the new prompt** — expect it to be slow.

This is correct behavior — old v2 verdicts shouldn't bleed into v1
clusters. If you want to preview without re-evaluating, the smoke-test
script can run a single comparison under the v3 prompt and show what comes
back.

## Verification done

1. `pnpm vitest run` — 269/269 non-flake tests pass, including two new
   ones covering the seed-upgrade behavior.
2. Defaults table auto-upgraded on a copy of the dev DB: prompt lengths
   went 1975 → 5636 / 1771 → 5432, both flag as `v3` via the
   `changeType`/`regionRole` content check. Source preserved as `seed`.
3. Per-session reset confirmed: `altinn-prod-vs-at22.csv` upgraded both
   prompts to v3 in one round-trip; other sessions left untouched.
4. Live smoke test against `9d87ba0a-…` (sidebar-added comparison) under
   the constants-derived prompt: 5 differences emitted, 10/10 v1 tags
   present, strict json_schema path.

## What's next

- **Phase D — mass-accept on v1.** Wire up the disabled cluster
  Accept/Reject/Split buttons; create `acceptance_rules` rows on accept;
  fan-out into per-row `acceptances`. Now safe because v1 cluster
  precision is high enough on the live LM (per the five spot-checks).
- **One-time data refresh** if you want the existing sitemap session to
  show v1 clusters in the UI: reset its prompts (above), then click
  "Recapture all" → re-evaluate → watch the cluster index repopulate
  under v1. Could also be done targeted (single URL pair) to keep LM
  cost down.
