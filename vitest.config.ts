import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/acceptance/**'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    fileParallelism: false,
    // Tests never read or write the real composer history (trial polish, 2026-10-31).
    env: { SALAAM_HISTORY: 'off' },
  },
});
