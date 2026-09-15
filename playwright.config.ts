import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end persistence-lifecycle suite.
 *
 * SCOPE: this config drives ONLY the scenarios that a real browser is required
 * for — real IndexedDB through localforage, real page teardown (`pagehide`,
 * `visibilitychange`), real reloads mid-debounce, real multi-tab contention,
 * and real storage denial. Pure logic (selectors, routing, purge matching,
 * rollback) stays in `npm test` / `npm run test:react` and must NEVER be
 * duplicated here.
 */
export default defineConfig({
    testDir: './e2e',
    // Persistence assertions read and write ONE origin-scoped database, so the
    // specs must not race each other.
    fullyParallel: false,
    workers: 1,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    reporter: process.env.CI ? 'github' : 'list',
    timeout: 30_000,
    expect: { timeout: 10_000 },
    use: {
        baseURL: 'http://127.0.0.1:5199',
        trace: 'retain-on-failure',
        video: 'off',
    },
    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'], channel: 'chrome' },
        },
    ],
    webServer: {
        command: 'vite --config vite.config.ts --port 5199 --strictPort e2e/fixture',
        url: 'http://127.0.0.1:5199',
        reuseExistingServer: !process.env.CI,
        timeout: 60_000
    }
});
