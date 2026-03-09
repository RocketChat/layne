import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles:  ['./src/__tests__/setup.js'],
    coverage: {
      provider: 'v8',
      reporter:  ['text', 'lcov'],
      include:   ['src/**/*.js'],
      exclude:   ['src/__tests__/**'],
    },
  },
});
