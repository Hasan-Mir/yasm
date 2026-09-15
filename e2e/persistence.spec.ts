import { expect, test } from '@playwright/test';

import {
    clearStorage,
    readParsedSnapshot,
    waitForReady,
    writeRawSnapshot
} from './helpers/storage';

// Real IndexedDB + real serializer round-trips. None of this is reachable from
// the in-memory `createMemoryStorage` adapter the unit suite uses.
test.describe('persistence against a real IndexedDB adapter', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/');
        await waitForReady(page);
        await clearStorage(page);
    });

    test('a hard reload restores state written before the reload', async ({
        page
    }) => {
        await page.getByTestId('note-text').fill('survives-reload');
        await page.getByTestId('note-increment').click();
        await page.evaluate(() => window.__yasmE2E.save());

        await page.reload();
        await waitForReady(page);

        await expect(page.getByTestId('note-text')).toHaveValue(
            'survives-reload'
        );
        await expect(page.getByTestId('note-count')).toHaveText('1');
    });

    test('a reload DURING the autosave debounce window keeps the tail through the pagehide flush', async ({
        page
    }) => {
        await page.getByTestId('note-text').fill('typed-inside-debounce');
        // Deliberately do NOT wait for the 600ms debounce: the emergency flush
        // on teardown is the only thing that can save this value. The flush is
        // invoked through the app's own `pagehide` listener and the write is
        // awaited before reloading, because a real teardown gives an async
        // IndexedDB write no chance to commit.
        await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
        await expect
            .poll(async () => {
                const snapshot = await readParsedSnapshot(page);
                return snapshot?.state?.Note?.['/note']?.text ?? null;
            })
            .toBe('$$STR$$_typed-inside-debounce');

        await page.reload();
        await waitForReady(page);

        await expect(page.getByTestId('note-text')).toHaveValue(
            'typed-inside-debounce'
        );
    });

    test('a Date survives the serializer round-trip through real storage', async ({
        page
    }) => {
        await page.getByTestId('note-set-date').click();
        await page.evaluate(() => window.__yasmE2E.save());

        await page.reload();
        await waitForReady(page);

        await expect(page.getByTestId('note-created-at')).toHaveText(
            '2024-03-04T05:06:07.008Z'
        );
    });

    test('a user-typed string that mimics a serializer prefix is restored verbatim', async ({
        page
    }) => {
        // Without the universal `$$STR$$_` escape this would come back a BigInt.
        await page.getByTestId('note-text').fill('$$BIGINT$$_123');
        await page.evaluate(() => window.__yasmE2E.save());

        await page.reload();
        await waitForReady(page);

        await expect(page.getByTestId('note-text')).toHaveValue(
            '$$BIGINT$$_123'
        );
    });

    test('a large payload round-trips through IndexedDB without truncation', async ({
        page
    }) => {
        await page.getByTestId('note-fill-bulk').click();
        await expect(page.getByTestId('note-bulk-size')).toHaveText('2000');
        await page.evaluate(() => window.__yasmE2E.save());

        await page.reload();
        await waitForReady(page);

        await expect(page.getByTestId('note-bulk-size')).toHaveText('2000');
    });

    test('a section declared persist:false never reaches storage and starts fresh', async ({
        page
    }) => {
        await page.getByTestId('secret-set').click();
        await expect(page.getByTestId('secret-token')).toHaveText(
            'in-memory-only'
        );
        await page.evaluate(() => window.__yasmE2E.save());

        const snapshot = await readParsedSnapshot(page);
        expect(snapshot).not.toBeNull();
        expect(snapshot?.state.Secret).toBeUndefined();

        await page.reload();
        await waitForReady(page);
        await expect(page.getByTestId('secret-token')).toHaveText('empty');
    });

    test('a multi-level composition child still resolves through its parent after a reload', async ({
        page
    }) => {
        await page.getByTestId('table-add-row').click();
        await expect(page.getByTestId('table-has-row')).toHaveText('true');

        await page.getByTestId('profile-input').fill('deeply-routed');
        await page.evaluate(() => window.__yasmE2E.save());

        await page.reload();
        await waitForReady(page);

        // The intermediate `Row` registration must survive hydration, or the
        // Profile falls back to direct storage and shows the default.
        await expect(page.getByTestId('profile-first-name')).toHaveText(
            'deeply-routed'
        );

        const registry = await page.evaluate(() =>
            window.__yasmE2E.getPathRegistry()
        );
        expect(registry.Row).toContain('/table[5]');

        // The real data must live inside the parent, not in a phantom slot.
        const snapshot = await readParsedSnapshot(page);
        expect(snapshot).not.toBeNull();
        expect(
            snapshot?.state?.Profile?.['/table[5][profile]']
        ).toBeUndefined();
    });

    test('a purged path does not resurrect across a reload', async ({
        page
    }) => {
        await page.getByTestId('note-text').fill('doomed');
        await page.evaluate(() => window.__yasmE2E.save());

        // Unmount the only reader, then let the deferred purge fire.
        await page.getByTestId('purge-note').click();
        await page.getByTestId('toggle-note').click();
        await page.waitForTimeout(100);
        await page.evaluate(() => window.__yasmE2E.save());

        await page.reload();
        await waitForReady(page);

        await expect(page.getByTestId('note-text')).toHaveValue('');
    });

    test('a snapshot written mid-pending-purge self-heals on the next boot', async ({
        page
    }) => {
        await page.getByTestId('note-text').fill('pending-purge-victim');
        // Schedule while the reader is still mounted, so the purge stays
        // pending and its marker is written into metadata.pendingPurges.
        await page.getByTestId('purge-note').click();
        await page.evaluate(() => window.__yasmE2E.save());

        const snapshot = await readParsedSnapshot(page);
        // The fixture's universal string escape tags the path too, and the raw
        // parse deliberately skips the app deserializer.
        expect(snapshot?.metadata?.pendingPurges).toContainEqual(
            expect.objectContaining({ pathPrefix: '$$STR$$_/note' })
        );

        await page.reload();
        await waitForReady(page);

        // Nothing is mounted at hydrate time, so the pending purge executes
        // immediately and the repair-save clears the marker.
        await expect(page.getByTestId('note-text')).toHaveValue('');
        const healed = await readParsedSnapshot(page);
        expect(healed?.metadata?.pendingPurges).toEqual([]);
    });

    test('an unknown section left by an older build is dropped and the repair-save persists that', async ({
        page
    }) => {
        await writeRawSnapshot(
            page,
            JSON.stringify({
                state: {
                    Note: {
                        '/note': {
                            text: '$$STR$$_kept',
                            count: 3,
                            isLoading: false,
                            bulk: []
                        }
                    },
                    RemovedInV2: { '/gone': { anything: 1 } }
                },
                pathRegistry: {},
                metadata: {}
            })
        );

        await page.reload();
        await waitForReady(page);

        await expect(page.getByTestId('note-text')).toHaveValue('kept');
        const snapshot = await readParsedSnapshot(page);
        expect(snapshot).not.toBeNull();
        expect(snapshot?.state.RemovedInV2).toBeUndefined();
    });
});
