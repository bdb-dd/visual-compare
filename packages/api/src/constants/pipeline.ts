import type { EquivalenceLevelId } from '../types.js';

/**
 * Base pipeline version. Bump on engine bug fixes that change verdict outputs.
 *
 * The actual cache key is the per-target string returned by
 * `pipelineVersionFor(targetLevel)` — pixel/LM measurements depend on the
 * level's tolerance (see `EquivalenceLevelDef.tolerance`), so the same
 * captures at different targets must cache as separate rows.
 */
export const PIPELINE_BASE_VERSION = 'v3';

export function pipelineVersionFor(targetLevel: EquivalenceLevelId): string {
  return `${PIPELINE_BASE_VERSION}-${targetLevel}`;
}
