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

    test('a primitive persisted root is quarantined rather than silently ignored', async ({
        page
    }) => {
        await writeRawSnapshot(page, 'null');

        await page.reload();
        await waitForReady(page);

        await expect(page.getByTestId('hydration-status')).toHaveText(
            'quarantined'
        );
    });

    test('the corrupt payload is backed up byte-for-byte', async ({ page }) => {
        const corrupt = '{"state":{"Note":{"/note":';
        await writeRawSnapshot(page, corrupt);

        await page.reload();
        await waitForReady(page);

        const keys = await listStorageKeys(page);
        const backupKey = keys.find(key =>
            key.startsWith('yasm-e2e-state_corrupted_backup_')
        );
        expect(backupKey).toBeDefined();

        const backup = await page.evaluate(
            key => window.__yasmE2E.readRaw(key),
            backupKey!
        );
        expect(backup).toBe(corrupt);
    });

    test('repeated corruption creates one backup per boot without touching the primary key', async ({
        page
    }) => {
        // Documents the accumulation the README warns about, and proves the
        // primary key is left clean each time.
        for (let attempt = 0; attempt < 2; attempt++) {
            await writeRawSnapshot(page, `{"broken":${attempt}`);
            await page.reload();
            await waitForReady(page);
            await expect(page.getByTestId('hydration-status')).toHaveText(
                'quarantined'
            );
        }

        const keys = await listStorageKeys(page);
        const backups = keys.filter(key =>
            key.startsWith('yasm-e2e-state_corrupted_backup_')
        );
        expect(backups.length).toBeGreaterThanOrEqual(2);

        const snapshot = await readParsedSnapshot(page);
        expect(snapshot?.state).toBeDefined();
    });

    test('a read failure lands on the failed status without crashing the app', async ({
        page
    }) => {
        // Simulates denied/broken storage (private mode, blocked origin).
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
        });

        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));

        await page.reload();
        await waitForReady(page);

        // The app must still render and stay interactive.
        await expect(page.getByTestId('note-text')).toBeVisible();
        await page.getByTestId('note-increment').click();
        await expect(page.getByTestId('note-count')).toHaveText('1');

        // No unhandled page error may escape the hydration boundary.
        expect(errors).toEqual([]);
    });

    test('a corrupt pathRegistry is quarantined and previously valid data is preserved in the backup', async ({
        page
    }) => {
        const corrupt = JSON.stringify({
            state: {
                Note: { '/note': { text: '$$STR$$_precious', count: 9 } }
            },
            pathRegistry: { Table: 'not-an-array' },
            metadata: {}
        });
        await writeRawSnapshot(page, corrupt);

        await page.reload();
        await waitForReady(page);

        await expect(page.getByTestId('hydration-status')).toHaveText(
            'quarantined'
        );
        await expect(page.getByTestId('note-text')).toHaveValue('');

        const keys = await listStorageKeys(page);
        const backupKey = keys.find(key =>
            key.startsWith('yasm-e2e-state_corrupted_backup_')
        );
        const backup = await page.evaluate(
            key => window.__yasmE2E.readRaw(key),
            backupKey!
        );
        expect(backup).toBe(corrupt);
    });
});
