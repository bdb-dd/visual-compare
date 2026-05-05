import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createLmClient,
  isAnalyzeError,
  readLmConfigFromEnv,
} from '../src/services/lm.js';
import { compareAe } from '../src/services/imagick.js';

const __filename = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = dirname(dirname(__filename));

const LIVE = process.env.LM_STUDIO === '1';

describe.skipIf(!LIVE)('LM Studio live integration (set LM_STUDIO=1)', () => {
  it('analyzes two real captures and returns a schema-valid response', async () => {
    const config = readLmConfigFromEnv();
    const client = createLmClient(config);

    // Use the captured screenshots from the manual smoke if present; else
    // synthesize tiny PNGs from raw bytes as a fallback.
    const dataDir = join(PACKAGE_ROOT, '..', '..', 'data', 'images');
    const aRel = process.env.LM_TEST_A;
    const bRel = process.env.LM_TEST_B;
    if (!aRel || !bRel) {
      throw new Error(
        'LM_STUDIO=1 requires LM_TEST_A and LM_TEST_B env vars pointing at two captured PNGs in data/images.',
      );
    }

    const aPath = join(dataDir, aRel);
    const bPath = join(dataDir, bRel);

    // Generate the diff using the real magick CLI. This also exercises the
    // red-on-white render path used by the parser.
    const tmp = await mkdtemp(join(tmpdir(), 'vc-lm-live-'));
    try {
      const diffPath = join(tmp, 'diff.png');
      const ae = await compareAe(aPath, bPath, diffPath);

      const outcome = await client.analyze({
        aPath,
        bPath,
        diffPath,
        level: 'semantic',
        invocationReason: 'semantic_mode',
        changedPixelPercentage: ae.changedPixelPercentage,
        ssim: null,
      });

      if (isAnalyzeError(outcome)) {
        throw new Error(
          `LM analyze returned error: ${outcome.message}\nraw: ${outcome.rawText ?? '(none)'}`,
        );
      }
      expect(outcome.path === 'json_schema' || outcome.path === 'tolerant_extract').toBe(true);
      expect(typeof outcome.parsed.equivalent).toBe('boolean');
      expect(outcome.parsed.confidence).toBeGreaterThanOrEqual(0);
      expect(outcome.parsed.confidence).toBeLessThanOrEqual(1);
      expect(outcome.parsed.summary.length).toBeGreaterThan(0);
      expect(Array.isArray(outcome.parsed.differences)).toBe(true);
      // eslint-disable-next-line no-console
      console.log(`[lm-live] path=${outcome.path} model=${outcome.model} eq=${outcome.parsed.equivalent} conf=${outcome.parsed.confidence}`);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 240_000);
});

// Avoid the "no test in file" warning when the suite is skipped.
if (!LIVE) {
  describe('LM Studio live integration', () => {
    it.skip('skipped — set LM_STUDIO=1 to enable', () => undefined);
  });
}
