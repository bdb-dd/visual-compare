/**
 * Identifies the pixel-compare and LM verdict pipeline.
 *
 * Cache keys for `pixel_compare_cache` and `lm_verdict_cache` include this
 * value, so bumping it invalidates everything cleanly without a destructive
 * migration. Bump on engine bug fixes that change verdict outputs.
 */
export const PIPELINE_VERSION = 'v1';
