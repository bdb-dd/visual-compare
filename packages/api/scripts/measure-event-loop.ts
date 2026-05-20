/**
 * Event-loop impact measurement for the ImageMagick comparison pipeline.
 *
 * Drives N concurrent compareAe + extractConnectedComponents calls against
 * synthetic PNGs while a perf_hooks histogram samples event-loop lag. Prints
 * a per-second snapshot and a final summary. Lets us answer questions like:
 *
 *   - Is the EL actually blocked, or just starved? (max-lag during run)
 *   - Does `MAGICK_NICE=10` reduce EL lag at a tolerable throughput cost?
 *   - At what concurrency does throughput plateau (CPU-bound) and EL lag
 *     spike (scheduler-bound)?
 *
 * Run as:
 *   mise exec -- pnpm tsx scripts/measure-event-loop.ts
 *   MAGICK_NICE=10 mise exec -- pnpm tsx scripts/measure-event-loop.ts
 *   CONCURRENCY=8 ITERATIONS=32 mise exec -- pnpm tsx scripts/measure-event-loop.ts
 *
 * Env:
 *   CONCURRENCY     max in-flight comparisons (default: availableParallelism - 1)
 *   ITERATIONS      total compareAe calls to run (default: CONCURRENCY * 4)
 *   WIDTH / HEIGHT  synthetic image dimensions (default: 1440x900, matches the
 *                   most common viewport)
 *   FUZZ_PERCENT    compareAe fuzz tolerance (default: 5)
 *   BLUR_SIGMA      compareAe blur sigma (default: 0 — skip blur preprocess)
 *   KEEP_TMP        if set, leave generated PNGs in tmp dir for inspection
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, availableParallelism } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  compareAe,
  extractConnectedComponents,
  runMagick,
} from '../src/services/imagick.js';
import { createLimit } from '../src/services/concurrency.js';
import {
  createEventLoopMonitor,
  formatSnapshot,
  type EventLoopSnapshot,
} from '../src/services/event-loop-monitor.js';

const CONCURRENCY = Math.max(
  1,
  Number(process.env.CONCURRENCY ?? availableParallelism() - 1),
);
const ITERATIONS = Math.max(1, Number(process.env.ITERATIONS ?? CONCURRENCY * 4));
const WIDTH = Number(process.env.WIDTH ?? 1440);
const HEIGHT = Number(process.env.HEIGHT ?? 900);
const FUZZ_PERCENT = Number(process.env.FUZZ_PERCENT ?? 5);
const BLUR_SIGMA = Number(process.env.BLUR_SIGMA ?? 0);
const KEEP_TMP = Boolean(process.env.KEEP_TMP);

async function generateFixtures(dir: string): Promise<{ a: string; b: string }> {
  const a = join(dir, 'a.png');
  const b = join(dir, 'b.png');
  // Noisy gradient + a handful of colored rectangles. Avoids -annotate so we
  // don't need a font installed; rectangles + gaussian noise still produce
  // enough real diff content for compareAe and connected-components to work
  // on. The noise is key — a flat background makes IM finish in tens of ms
  // and the bench loses signal.
  await runMagick([
    '-size',
    `${WIDTH}x${HEIGHT}`,
    'gradient:white-skyblue',
    '+noise',
    'Gaussian',
    '-fill',
    'crimson',
    '-draw',
    `rectangle 200,300 600,350`,
    '-draw',
    `rectangle 700,400 1100,450`,
    '-fill',
    'royalblue',
    '-draw',
    `rectangle 100,600 500,700`,
    a,
  ]);
  await runMagick([
    '-size',
    `${WIDTH}x${HEIGHT}`,
    'gradient:white-skyblue',
    '+noise',
    'Gaussian',
    '-fill',
    'crimson',
    '-draw',
    `rectangle 220,300 620,350`, // shifted +20px in x → real diff content
    '-draw',
    `rectangle 700,400 1100,450`,
    '-fill',
    'royalblue',
    '-draw',
    `rectangle 100,600 500,700`,
    '-fill',
    'forestgreen',
    '-draw',
    `rectangle 50,500 250,550`, // new element only in B
    b,
  ]);
  return { a, b };
}

interface Sample {
  tSeconds: number;
  snap: EventLoopSnapshot;
  inFlight: number;
  completed: number;
}

async function main() {
  const workDir = await mkdtemp(join(tmpdir(), 'vc-eventloop-bench-'));
  // eslint-disable-next-line no-console
  console.log(
    `[bench] concurrency=${CONCURRENCY} iterations=${ITERATIONS} size=${WIDTH}x${HEIGHT} ` +
      `fuzz=${FUZZ_PERCENT}% blur=${BLUR_SIGMA} ` +
      `MAGICK_NICE=${process.env.MAGICK_NICE ?? '0'} tmp=${workDir}`,
  );
  // eslint-disable-next-line no-console
  console.log(`[bench] cpus=${availableParallelism()}`);

  // eslint-disable-next-line no-console
  console.log(`[bench] generating fixtures …`);
  const { a, b } = await generateFixtures(workDir);

  const monitor = createEventLoopMonitor({ resolutionMs: 10 });
  monitor.start();

  // Warm-up snapshot (idle baseline). The monitor was running during fixture
  // generation, which is itself two magick calls — but only two, so this
  // reflects "process at rest" reasonably well.
  const idleSnap = monitor.snapshot();
  // eslint-disable-next-line no-console
  console.log(`[idle ] ${formatSnapshot(idleSnap)}`);

  const samples: Sample[] = [];
  const startedAt = performance.now();
  let inFlight = 0;
  let completed = 0;

  const sampler = setInterval(() => {
    const snap = monitor.snapshot();
    samples.push({
      tSeconds: (performance.now() - startedAt) / 1000,
      snap,
      inFlight,
      completed,
    });
    // eslint-disable-next-line no-console
    console.log(
      `[t+${samples[samples.length - 1].tSeconds.toFixed(1)}s inflight=${String(
        inFlight,
      ).padStart(2)} done=${String(completed).padStart(3)}] ${formatSnapshot(snap)}`,
    );
  }, 1000);
  sampler.unref();

  const limit = createLimit(CONCURRENCY);
  const runWall = performance.now();
  await Promise.all(
    Array.from({ length: ITERATIONS }, (_, i) =>
      limit(async () => {
        inFlight += 1;
        const diffPath = join(workDir, `diff-${i}.png`);
        const res = await compareAe(a, b, diffPath, {
          fuzzPercent: FUZZ_PERCENT,
          blurSigma: BLUR_SIGMA,
        });
        await extractConnectedComponents(res.diffImagePath);
        inFlight -= 1;
        completed += 1;
      }),
    ),
  );
  const wallSeconds = (performance.now() - runWall) / 1000;
  clearInterval(sampler);

  // Final snapshot to catch the tail.
  const finalSnap = monitor.snapshot();
  // eslint-disable-next-line no-console
  console.log(`[final] ${formatSnapshot(finalSnap)}`);
  monitor.stop();

  // Compute per-run aggregates.
  const peakP99 = Math.max(idleSnap.p99, ...samples.map((s) => s.snap.p99), finalSnap.p99);
  const peakMax = Math.max(idleSnap.max, ...samples.map((s) => s.snap.max), finalSnap.max);
  const meanP99 =
    samples.length > 0 ? samples.reduce((a, s) => a + s.snap.p99, 0) / samples.length : 0;

  // eslint-disable-next-line no-console
  console.log('');
  // eslint-disable-next-line no-console
  console.log('=== SUMMARY ===');
  // eslint-disable-next-line no-console
  console.log(
    `iterations=${ITERATIONS} concurrency=${CONCURRENCY} wall=${wallSeconds.toFixed(2)}s ` +
      `throughput=${(ITERATIONS / wallSeconds).toFixed(2)} cmp/s`,
  );
  // eslint-disable-next-line no-console
  console.log(`event_loop_p99_peak=${peakP99.toFixed(1)}ms`);
  // eslint-disable-next-line no-console
  console.log(`event_loop_max_peak=${peakMax.toFixed(1)}ms`);
  // eslint-disable-next-line no-console
  console.log(`event_loop_p99_mean_during_run=${meanP99.toFixed(1)}ms`);
  // eslint-disable-next-line no-console
  console.log(`event_loop_p99_idle_baseline=${idleSnap.p99.toFixed(1)}ms`);

  if (!KEEP_TMP) {
    await rm(workDir, { recursive: true, force: true });
  } else {
    // eslint-disable-next-line no-console
    console.log(`[bench] KEEP_TMP set, leaving artifacts at ${workDir}`);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
