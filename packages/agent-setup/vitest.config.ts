import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    maxWorkers: 2,
    include: ['__tests__/**/*_test.ts'],
    exclude: ['__tests__/installers/integration/**'],
    environment: 'node',
  },
});
