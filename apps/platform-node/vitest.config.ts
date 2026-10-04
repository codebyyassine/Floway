import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    maxWorkers: 2,
    environment: 'node',
    include: ['__tests__/**/*_test.ts'],
    testTimeout: 10_000,
  },
});
