import type { Page } from '@playwright/test';
import { PersistedSnapshot } from '../../src';

const STORAGE_KEY = 'yasm-e2e-state';

/** Waits until the fixture has mounted and hydration has settled. */
const waitForReady = async (page: Page): Promise<void> => {
    await page.waitForFunction(() => window.__yasmE2E !== undefined);
    await page
        .getByTestId('hydration-status')
        .filter({ hasText: /hydrated|quarantined|failed/ })
        .waitFor();
};

/** Reads the raw persisted payload straight out of IndexedDB. */
const readRawSnapshot = async (
    page: Page,
    key: string = STORAGE_KEY
): Promise<string | null> =>
    page.evaluate(storageKey => window.__yasmE2E.readRaw(storageKey), key);

/** Reads the persisted payload and parses it WITHOUT the app deserializer. */
const readParsedSnapshot = async (
    page: Page,
    key: string = STORAGE_KEY
): Promise<PersistedSnapshot<Record<string, any>> | null> => {
    const raw = await readRawSnapshot(page, key);
    if (raw === null) {
        return null;
    }
    return JSON.parse(raw);
};

/** Every key currently present in the fixture's IndexedDB store. */
const listStorageKeys = (page: Page): Promise<string[]> =>
    page.evaluate(() => window.__yasmE2E.listKeys());

/** Overwrites the persisted payload with an arbitrary raw string. */
const writeRawSnapshot = (
    page: Page,
    value: string,
    key: string = STORAGE_KEY
): Promise<void> =>
    page.evaluate(
        ([storageKey, payload]) =>
            window.__yasmE2E.writeRaw(storageKey, payload),
        [key, value] as const
    );

/** Empties the fixture's IndexedDB store. */
const clearStorage = (page: Page): Promise<void> =>
    page.evaluate(() => window.__yasmE2E.clearStorage());

export {
    STORAGE_KEY,
    clearStorage,
    listStorageKeys,
    readParsedSnapshot,
    readRawSnapshot,
    waitForReady,
    writeRawSnapshot
};
