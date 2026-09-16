import { expect, test } from '@playwright/test';

import {
    clearStorage,
    listStorageKeys,
    readParsedSnapshot,
    waitForReady,
    writeRawSnapshot
} from './helpers/storage';

// Corruption, quarantine, and denied storage against a real backend.
test.describe('resilience against corrupt and unavailable storage', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/');
        await waitForReady(page);
        await clearStorage(page);
    });

    test('invalid JSON is quarantined, backed up, and the session boots usable', async ({
        page
    }) => {
        await writeRawSnapshot(page, '{ this is not valid json');

        await page.reload();
        await waitForReady(page);

        await expect(page.getByTestId('hydration-status')).toHaveText(
            'quarantined'
        );

        const keys = await listStorageKeys(page);
        expect(
            keys.some(key => key.startsWith('yasm-e2e-state_corrupted_backup_'))
        ).toBe(true);

        // The primary key was reset to a clean snapshot and stays writable.
        await page.getByTestId('note-text').fill('after-quarantine');
        await page.evaluate(() => window.__yasmE2E.save());
        const snapshot = await readParsedSnapshot(page);
        expect(snapshot?.state?.Note?.['/note']?.text).toBe(
            '$$STR$$_after-quarantine'
        );
    });

    test('a read failure lands on the failed status without crashing the app', async ({
        page
    }) => {
        // Simulates fully denied storage (private mode, blocked origin): BOTH
        // IndexedDB and localStorage are unusable, so localforage cannot
        // silently fall back to another driver — every read must genuinely
        // fail before the 'failed' status can be asserted.
        await page.addInitScript(() => {
            const originalOpen = indexedDB.open.bind(indexedDB);
            (indexedDB as unknown as { open: unknown }).open = (
                ...args: unknown[]
            ) => {
                if (String(args[0]).includes('yasm-e2e')) {
                    throw new DOMException(
                        'access denied',
                        'InvalidStateError'
                    );
                }
                return (originalOpen as (...a: unknown[]) => IDBOpenDBRequest)(
                    ...args
                );
            };

            // 🛡️ localforage's driver order is IndexedDB → WebSQL →
            // localStorage: with only IndexedDB denied it silently falls back
            // to localStorage and hydration succeeds. Deny the fallbacks too
            // so storage is genuinely unavailable.
            Object.defineProperty(window, 'localStorage', {
                configurable: true,
                get() {
                    throw new DOMException('access denied', 'SecurityError');
                }
            });
            if ('openDatabase' in window) {
                Object.defineProperty(window, 'openDatabase', {
                    configurable: true,
                    get() {
                        throw new DOMException(
                            'access denied',
                            'SecurityError'
                        );
                    }
                });
            }
        });

        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));

        await page.reload();
        await waitForReady(page);

        // 🔒 The failure must be classified as 'failed' — not silently
        // misclassified as a healthy 'hydrated' boot.
        await expect(page.getByTestId('hydration-status')).toHaveText(
            'failed'
        );

        // The app must still render and stay interactive.
        await expect(page.getByTestId('note-text')).toBeVisible();
        await page.getByTestId('note-increment').click();
        await expect(page.getByTestId('note-count')).toHaveText('1');

        // No unhandled page error may escape the hydration boundary.
        expect(errors).toEqual([]);
    });

});
