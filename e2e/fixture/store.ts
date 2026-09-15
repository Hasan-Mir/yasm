import localforage from 'localforage';

import {
    type Section,
    arraySectionGenerator,
    createStore,
    mergeUpdaterGenerator,
    objectSectionGenerator
} from '../../src/index';

const STORAGE_KEY = 'yasm-e2e-state';
const DB_NAME = 'yasm-e2e';
const STORE_NAME = 'yasmState';
/** Short enough to act inside, long enough to be observable from a test. */
const DEBOUNCE_MS = 600;

const yasmStorage = localforage.createInstance({
    name: DB_NAME,
    storeName: STORE_NAME
});

const storageAdapter = {
    getItem: (key: string) => yasmStorage.getItem<string>(key),
    setItem: (key: string, value: string) =>
        yasmStorage.setItem(key, value).then(() => undefined),
    removeItem: (key: string) => yasmStorage.removeItem(key),
    clear: () => yasmStorage.clear()
};

// Mirrors the application's universal string-escape mechanism: EVERY string is
// tagged so a user typing a literal "$$BIGINT$$_1" is never revived as BigInt.
function serializer(
    object: Record<string, unknown>,
    key: string,
    value: unknown
) {
    if (typeof object[key] === 'bigint') {
        return '$$BIGINT$$_' + (object[key] as bigint).toString();
    }
    if (object[key] instanceof Date) {
        return '$$DATE$$_' + (object[key] as Date).toISOString();
    }
    if (typeof object[key] === 'string') {
        return '$$STR$$_' + (object[key] as string);
    }
    return value;
}

function deserializer(_key: string, value: unknown) {
    if (typeof value !== 'string') {
        return value;
    }
    if (value.startsWith('$$BIGINT$$_')) {
        return BigInt(value.slice('$$BIGINT$$_'.length));
    }
    if (value.startsWith('$$DATE$$_')) {
        return new Date(value.slice('$$DATE$$_'.length));
    }
    if (value.startsWith('$$STR$$_')) {
        return value.slice('$$STR$$_'.length);
    }
    return value;
}

type NoteState = {
    text: string;
    count: number;
    isLoading: boolean;
    createdAt: Date | undefined;
    bulk: string[];
};

const noteSection: Section<NoteState, Partial<NoteState>> = {
    initialState: {
        text: '',
        count: 0,
        isLoading: false,
        createdAt: undefined,
        bulk: []
    },
    updater: mergeUpdaterGenerator<NoteState>()
};

type SecretState = { token: string };

const secretSection: Section<SecretState, Partial<SecretState>> = {
    initialState: { token: '' },
    updater: mergeUpdaterGenerator<SecretState>(),
    persist: false
};

type ProfileState = { firstName: string; lastName: string };

const profileSection: Section<ProfileState, Partial<ProfileState>> = {
    initialState: { firstName: '', lastName: '' },
    updater: mergeUpdaterGenerator<ProfileState>()
};

// `Row` is an ObjectSection that is ALSO an ArraySection child — it owns no
// state of its own, which is exactly the shape whose pathRegistry entry used to
// be pruned on every hydration.
const rowSection = objectSectionGenerator({
    profile: {
        name: 'Profile',
        state: profileSection.initialState,
        updater: profileSection.updater
    }
});

const E2E_SECTIONS = {
    Note: noteSection,
    Secret: secretSection,
    Table: arraySectionGenerator('Row', rowSection),
    Row: rowSection,
    Profile: profileSection
};

const store = createStore(E2E_SECTIONS, {
    serializer,
    deserializer,
    persist: {
        key: STORAGE_KEY,
        storage: storageAdapter,
        autoSave: true,
        persistDebounceMS: DEBOUNCE_MS
    }
});

export {
    DEBOUNCE_MS,
    DB_NAME,
    E2E_SECTIONS,
    STORAGE_KEY,
    STORE_NAME,
    store,
    yasmStorage
};
export type { NoteState, ProfileState, SecretState };
