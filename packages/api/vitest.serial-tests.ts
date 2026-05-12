// Single source of truth for the timing-sensitive test files that must run
// with fileParallelism=false. Imported by both vitest configs so the exclude
// list and the serial include list stay in sync.
export const SERIAL_TEST_FILES = [
  'test/comparison-concurrency.test.ts',
  'test/imagick-runtime.test.ts',
];
