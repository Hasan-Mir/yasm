import { defineConfig } from 'vitest/config';

/**
 * Component-level test runner (React layer).
 *
 * The core engine tests stay on `node:test` (`npm test`); this config only
 * picks up `tests/react/**`, where hooks need a real DOM so mount/unmount,
 * re-render and subscription lifecycles can be observed.
 */
export default defineConfig({
    test: {
        environment: 'jsdom',
        globals: true,
        setupFiles: ['./tests/react/setup.ts'],
        include: ['tests/react/**/*.test.{ts,tsx}']
    }
});