import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { STORAGE_KEY, store, yasmStorage } from './store';

declare global {
    interface Window {
        __yasmE2E: {
            save: () => Promise<void>;
            readRaw: (key?: string) => Promise<string | null>;
            listKeys: () => Promise<string[]>;
            writeRaw: (key: string, value: string) => Promise<void>;
            clearStorage: () => Promise<void>;
            getHydrationStatus: () => string;
            getPathRegistry: () => Record<string, string[]>;
            getState: () => Record<string, unknown>;
        };
    }
}

window.__yasmE2E = {
    save: () => store.save(),
    readRaw: (key = STORAGE_KEY) => yasmStorage.getItem<string>(key),
    listKeys: () => yasmStorage.keys(),
    writeRaw: (key: string, value: string) =>
        yasmStorage.setItem(key, value).then(() => undefined),
    clearStorage: () => yasmStorage.clear(),
    getHydrationStatus: () => store.getHydrationStatus(),
    getPathRegistry: () =>
        JSON.parse(JSON.stringify(store.pathRegistry)) as Record<
            string,
            string[]
        >,
    getState: () => store.snapshotByPrefix()
};

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <App />
    </StrictMode>
);
