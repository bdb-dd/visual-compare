import { defineConfig } from 'vitest/config';
import { SERIAL_TEST_FILES } from './vitest.serial-tests.js';

// Serial test phase: a small set of timing-sensitive tests that flake under
// vitest's default file-parallel mode (event-loop starvation between worker
// files). Run separately with fileParallelism=false so they own the loop.
// Kept narrow on purpose — only files that have been proven flaky belong
// here; everything else stays in the parallel phase.
export default defineConfig({
  test: {
    include: SERIAL_TEST_FILES,
    environment: 'node',
    globals: false,
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
