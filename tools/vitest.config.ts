import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    maxWorkers: 2,
    name: 'tools',
    include: ['__tests__/**/*_test.ts'],
  },
});
