import { z } from 'zod';

/**
 * Structured guidance overlay applied on top of a base system prompt.
 *
 * Rules are evaluated in two stages by the LM:
 *   - Step 1 — Scope: regions/aspects to exclude before judging equivalence.
 *   - Step 2 — Triggers: conditions that flip the verdict to non-equivalent
 *     within the regions that remain after Step 1.
 *
 * Toggles are pre-defined; their step is fixed in {@link TOGGLE_KIND}.
 * `house_rules.scope` and `house_rules.trigger` are the freeform escape
 * hatches for each step.
 *
 * The full assembled text is what goes to the model and what gets
 * SHA-hashed into the prompt_id cache key.
 */
export interface PromptGuidance {
  toggles: PromptGuidanceToggles;
  house_rules: HouseRules;
}

export interface PromptGuidanceToggles {
  /** Trigger: A→B text-language change → non-equivalent. */
  language_must_match?: boolean;
  /** Scope: ignore top banner / header buttons / footer chrome. */
  ignore_chrome_only_diffs?: boolean;
  /** Trigger: added/removed list items / announcements / links → non-equivalent. */
  flag_added_removed_content?: boolean;
}

export interface HouseRules {
  scope: string[];
  trigger: string[];
}

/** Each toggle is permanently classified as a scope or trigger rule. */
export const TOGGLE_KIND: Record<keyof PromptGuidanceToggles, 'scope' | 'trigger'> = {
  language_must_match: 'trigger',
  ignore_chrome_only_diffs: 'scope',
  flag_added_removed_content: 'trigger',
};

const houseRulesSchema = z.union([
  // Current shape.
  z
    .object({
      scope: z.array(z.string().max(500)).max(10).default([]),
      trigger: z.array(z.string().max(500)).max(10).default([]),
    })
    .strict(),
  // Legacy shape (pre-two-stage). Empty array is shape-ambiguous but
  // reduces to {scope:[], trigger:[]} either way; non-empty legacy strings
  // were authored as triggers, so route them there.
  z
    .array(z.string().max(500))
    .max(20)
    .transform((arr) => ({ scope: [] as string[], trigger: arr })),
]);

export const promptGuidanceSchema = z
  .object({
    toggles: z
      .object({
        language_must_match: z.boolean().optional(),
        ignore_chrome_only_diffs: z.boolean().optional(),
        flag_added_removed_content: z.boolean().optional(),
      })
      .strict()
      .default({}),
    house_rules: houseRulesSchema.default({ scope: [], trigger: [] }),
  })
  .strict();

export const EMPTY_GUIDANCE: PromptGuidance = {
  toggles: {},
  house_rules: { scope: [], trigger: [] },
};

const TOGGLE_BULLETS: Record<keyof PromptGuidanceToggles, string> = {
  language_must_match:
    'If A is in one human language and B is in another (e.g. English vs Norwegian, or any other natural-language change), set equivalent=false. A language change is a content change, not a localization that can be ignored.',
  ignore_chrome_only_diffs:
    'The top banner / announcement strip, header buttons (Log in, Menu), and footer chrome are EXCLUDED from this evaluation. Treat differences inside these regions as if they did not exist.',
  flag_added_removed_content:
    'If a list item, announcement, content row, or link has been added or removed between A and B (in regions not excluded by Step 1), set equivalent=false.',
};

export function isGuidanceEmpty(guidance: PromptGuidance): boolean {
  const anyToggleOn = Object.values(guidance.toggles).some((v) => v === true);
  const anyScopeRule = guidance.house_rules.scope.some((r) => r.trim().length > 0);
  const anyTriggerRule = guidance.house_rules.trigger.some((r) => r.trim().length > 0);
  return !anyToggleOn && !anyScopeRule && !anyTriggerRule;
}

interface StageBullets {
  scope: string[];
  trigger: string[];
}

function collectBullets(guidance: PromptGuidance): StageBullets {
  const out: StageBullets = { scope: [], trigger: [] };
  for (const key of Object.keys(TOGGLE_BULLETS) as (keyof PromptGuidanceToggles)[]) {
    if (guidance.toggles[key]) out[TOGGLE_KIND[key]].push(TOGGLE_BULLETS[key]);
  }
  for (const rule of guidance.house_rules.scope) {
    const t = rule.trim();
    if (t) out.scope.push(t);
  }
  for (const rule of guidance.house_rules.trigger) {
    const t = rule.trim();
    if (t) out.trigger.push(t);
  }
  return out;
}

/**
 * Compose the final system prompt sent to the LM. Returns `base` unchanged
 * when guidance is empty so the assembled SHA matches the base SHA. When
 * guidance is present, emits a two-stage block:
 *   - Step 1 — scope rules (regions to exclude)
 *   - Step 2 — trigger rules (conditions that flip to non-equivalent)
 * Either step is omitted when it has no rules; if only triggers exist the
 * preamble drops the "regions remaining after Step 1" framing so the LM
 * doesn't reason about a non-existent first stage.
 */
export function assemblePromptText(base: string, guidance: PromptGuidance): string {
  if (isGuidanceEmpty(guidance)) return base;
  const { scope, trigger } = collectBullets(guidance);

  const sections: string[] = [];
  sections.push('## Project rules — apply in order');
  sections.push(
    'These rules govern your verdict. Apply them in two steps. Step 1 narrows what you look at; Step 2 decides equivalence on what remains. Step 1 takes precedence — a difference inside an excluded region cannot itself trigger equivalent=false.',
  );

  if (scope.length > 0) {
    sections.push('### Step 1 — Regions to exclude from evaluation');
    sections.push(
      'Treat these regions as invisible for the rest of this evaluation. Differences confined entirely to excluded regions must NOT be cited as reasons for equivalent=false.',
    );
    sections.push(scope.map((b) => `- ${b}`).join('\n'));
  }

  if (trigger.length > 0) {
    sections.push(
      scope.length > 0
        ? '### Step 2 — Equivalence triggers (apply only to regions NOT excluded in Step 1)'
        : '### Equivalence triggers',
    );
    sections.push(
      scope.length > 0
        ? 'Within the regions that remain after Step 1, set equivalent=false if ANY of the following is true. Do not invoke these triggers based on differences inside Step 1\'s excluded regions.'
        : 'Set equivalent=false if ANY of the following is true.',
    );
    sections.push(trigger.map((b) => `- ${b}`).join('\n'));
  }

  return `${base}\n\n${sections.join('\n\n')}`;
}

export function parseGuidanceJson(raw: string | null): PromptGuidance | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    return promptGuidanceSchema.parse(parsed);
  } catch {
    return null;
  }
}

export function serialiseGuidance(guidance: PromptGuidance): string {
  return JSON.stringify(guidance);
}
