/**
 * Cluster-signature taxonomy enums. Lives in `constants/` (no Node deps,
 * matching `types.ts` discipline) so the web package can import the
 * canonical enum values for the unified filter strip without dragging in
 * Node-typed modules.
 *
 * Re-exported from `services/lm.ts` for back-compat with existing
 * imports; that module remains the LM-side source of truth for the
 * derived types (ChangeType, RegionRole) and zod / JSON schemas.
 *
 * If the enums change, update `experiments/v1-taxonomy.md` in the
 * cluster-review design and the v3 prompt in `constants/lm-prompts.ts`.
 */

export const CHANGE_TYPES = [
  'element_added',
  'element_removed',
  'element_replaced',
  'text_changed',
  'text_translated',
  'image_changed',
  'style_changed',
  'count_changed',
  'state_changed',
  'other',
] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];

export const REGION_ROLES = [
  'header',
  'nav_primary',
  'nav_secondary',
  'hero',
  'main_content',
  'aside',
  'footer',
  'overlay',
  'alert_banner',
  'other',
] as const;
export type RegionRole = (typeof REGION_ROLES)[number];
