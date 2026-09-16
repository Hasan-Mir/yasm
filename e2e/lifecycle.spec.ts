import { expect, test } from '@playwright/test';

import {
    clearStorage,
    readParsedSnapshot,
    waitForReady
} from './helpers/storage';

// Real page-teardown and multi-tab behaviour. jsdom cannot model either.
test.describe('page lifecycle and multi-tab behaviour', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/');
        await waitForReady(page);
        await clearStorage(page);
        await page.reload();
        await waitForReady(page);
    });

    test('a visibilitychange to hidden flushes the debounced autosave', async ({
        page
    }) => {
        await page.getByTestId('note-text').fill('flushed-on-hide');

        await page.evaluate(() => {
            Object.defineProperty(document, 'visibilityState', {
                configurable: true,
                get: () => 'hidden'
            });
            document.dispatchEvent(new Event('visibilitychange'));
        });

        await expect
            .poll(async () => {
                const snapshot = await readParsedSnapshot(page);
                return snapshot?.state?.Note?.['/note']?.text ?? null;
            })
            .toBe('$$STR$$_flushed-on-hide');
    });

    test('a second tab hydrates the state the first tab persisted', async ({
        browser
    }) => {
        const context = await browser.newContext();
        const first = await context.newPage();
        await first.goto('/');
        await waitForReady(first);
        await clearStorage(first);

        await first.getByTestId('note-text').fill('from-first-tab');
        await first.evaluate(() => window.__yasmE2E.save());

        const second = await context.newPage();
        await second.goto('/');
        await waitForReady(second);
        await expect(second.getByTestId('note-text')).toHaveValue(
            'from-first-tab'
        );

        await context.close();
    });

    test('CHARACTERIZATION: two tabs writing concurrently are last-writer-wins', async ({
        browser
    }) => {
        // This documents CURRENT behaviour. YASM holds one in-memory store per
        // tab and persists the whole snapshot, so there is no cross-tab merge.
        // If cross-tab reconciliation is ever introduced, this test must be
        // rewritten rather than deleted.
        const context = await browser.newContext();
        const first = await context.newPage();
        await first.goto('/');
        await waitForReady(first);
        await clearStorage(first);

        const second = await context.newPage();
        await second.goto('/');
        await waitForReady(second);

        await first.getByTestId('note-text').fill('written-by-first');
        await first.evaluate(() => window.__yasmE2E.save());

        await second.getByTestId('note-text').fill('written-by-second');
        await second.evaluate(() => window.__yasmE2E.save());

        const snapshot = await readParsedSnapshot(second);
        expect(snapshot?.state?.Note?.['/note']?.text).toBe(
            '$$STR$$_written-by-second'
        );

        await context.close();
    });
});
