import { z } from 'zod';
import type { Db } from '../db/client.js';
import { listUrlPairs } from './sessions.js';

export const invalidateCapturesInputSchema = z
  .object({
    pair_ids: z.array(z.string().min(1)).optional(),
    side: z.enum(['a', 'b']).optional(),
  })
  .strict();

export type InvalidateCapturesInput = z.infer<typeof invalidateCapturesInputSchema>;

export interface InvalidateCapturesResult {
  deleted_count: number;
  /** URLs whose capture_cache rows were targeted (post-existence check). */
  invalidated_urls: string[];
  /** pair_ids requested in the input that did not belong to the session. */
  unknown_pair_ids: string[];
}

/**
 * Drop `capture_cache` rows for a session under the rules in the design doc:
 *
 *   {}                          → invalidate everything for the session
 *   { side: 'b' }               → all B-side captures (bulk)
 *   { pair_ids: [...] }         → those pairs, both sides
 *   { pair_ids: [...], side:'a'}→ those pairs, A side only
 *
 * Pixel and LM cache rows are intentionally left in place. They reference
 * sha256s that are no longer pointed to by any capture_cache row, so they
 * become orphaned but inert — subsequent evaluations get fresh shas after
 * recapture and miss the cache as expected.
 */
export function invalidateSessionCaptures(
  db: Db,
  sessionId: string,
  input: InvalidateCapturesInput,
): InvalidateCapturesResult {
  const allPairs = listUrlPairs(db, sessionId);
  const knownIds = new Set(allPairs.map((p) => p.id));

  let targetPairs = allPairs;
  let unknown_pair_ids: string[] = [];
  if (input.pair_ids !== undefined) {
    const requested = input.pair_ids;
    unknown_pair_ids = requested.filter((id) => !knownIds.has(id));
    const requestedSet = new Set(requested);
    targetPairs = allPairs.filter((p) => requestedSet.has(p.id));
  }

  const urls = new Set<string>();
  for (const pair of targetPairs) {
    if (input.side === undefined || input.side === 'a') urls.add(pair.url_a);
    if (input.side === undefined || input.side === 'b') urls.add(pair.url_b);
  }

  if (urls.size === 0) {
    return { deleted_count: 0, invalidated_urls: [], unknown_pair_ids };
  }

  // SQLite has a default parameter limit (~32k); the Altinn worst case is
  // ~5k pairs × 2 sides = 10k URLs, well under the cap. If we ever exceed
  // it we'd batch.
  const placeholders = Array.from(urls).map(() => '?').join(',');
  const stmt = db.prepare(
    `DELETE FROM capture_cache WHERE url IN (${placeholders})`,
  );
  const info = stmt.run(...Array.from(urls));

  return {
    deleted_count: info.changes,
    invalidated_urls: Array.from(urls).sort(),
    unknown_pair_ids,
  };
}
