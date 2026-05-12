import { configDefaults, defineConfig } from 'vitest/config';
import { SERIAL_TEST_FILES } from './vitest.serial-tests.js';

// Default test phase: everything except the two timing-sensitive files that
// need fileParallelism=false. Those run in a second phase via
// `vitest.config.serial.ts`; see package.json `test` script.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: [...configDefaults.exclude, ...SERIAL_TEST_FILES],
    environment: 'node',
    globals: false,
    pool: 'forks',
    testTimeout: 20_000,
  },
});
