import type { Db } from '../db/client.js';
import {
  DEFAULT_EQUIVALENCE_LEVEL,
  DEFAULT_REGION_MATCH_CONFIG,
} from '../constants/equivalence.js';
import type {
  EquivalenceLevelId,
  RegionMatchConfig,
  SessionConfig,
  UrlPairConfigOverrideRow,
} from '../types.js';

/**
 * Effective config for a (url_pair, session) tuple. Resolution order is
 *   pair_override ?? session ?? system_default
 * for each knob. `region_match_config` from a pair override is a *partial*
 * object merged over the session value, so users can tune one knob without
 * restating the others.
 */
export interface ResolvedPairConfig {
  equivalence_level: EquivalenceLevelId;
  region_match_config: RegionMatchConfig;
}

export function resolvePairConfig(
  session: SessionConfig | null,
  pairOverride: UrlPairConfigOverrideRow | null,
): ResolvedPairConfig {
  const sessionLevel = session?.default_equivalence_level ?? DEFAULT_EQUIVALENCE_LEVEL;
  const sessionRegion = session?.region_match_config ?? { ...DEFAULT_REGION_MATCH_CONFIG };

  const pairLevel = pairOverride?.equivalence_level ?? null;
  const pairRegionPartial = parsePartialRegionConfig(pairOverride?.region_match_config_json);

  return {
    equivalence_level: pairLevel ?? sessionLevel,
    region_match_config: { ...sessionRegion, ...pairRegionPartial },
  };
}

/**
 * Read the override row for a single url_pair, or null if none exists.
 * Returning the row directly (rather than a parsed override) lets callers
 * reuse `resolvePairConfig` regardless of how they fetched the row.
 */
export function getUrlPairConfigOverride(
  db: Db,
  urlPairId: string,
): UrlPairConfigOverrideRow | null {
  const row = db
    .prepare<[string], UrlPairConfigOverrideRow>(
      `SELECT url_pair_id, equivalence_level, region_match_config_json, updated_at
         FROM url_pair_config_overrides
        WHERE url_pair_id = ?`,
    )
    .get(urlPairId);
  return row ?? null;
}

function parsePartialRegionConfig(
  json: string | null | undefined,
): Partial<RegionMatchConfig> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as Partial<RegionMatchConfig>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}
