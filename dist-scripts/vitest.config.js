import { defineConfig } from 'vitest/config';
export default defineConfig({
    test: {
        environment: 'node',
        setupFiles: ['./src/__tests__/setup.ts'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'lcov'],
            include: ['src/**/*.ts'],
            exclude: ['src/__tests__/**'],
        },
    },
});
//# sourceMappingURL=vitest.config.js.map