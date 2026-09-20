import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    Section,
    createStore,
    type HydrationStatus,
    type QuarantineInfo
} from '../src/createStore';
import { mergeUpdaterGenerator, arraySectionGenerator } from '../src/util';
import { init } from '../src/useYasmState';
import { purgeYasmState } from '../src/purge';
import { captureConsole, captureWarnings } from './helpers';

// 🧪 Mock Storage Adapter
const createMockStorage = () => {
    const data = new Map<string, string>();
    return {
        getItem: async (key: string) => data.get(key) || null,
        setItem: async (key: string, value: string) => {
            data.set(key, value);
        },
        removeItem: async (key: string) => {
            data.delete(key);
        },
        clear: async () => {
            data.clear();
        },
        get snapshot() {
            return data;
        }
    };
};

type DummyState = { count: number; text: string; isLoading: boolean };
const dummySection: Section<DummyState, Partial<DummyState>> = {
    initialState: { count: 0, text: '', isLoading: false },
    updater: mergeUpdaterGenerator<DummyState>()
};

// A routed section to test pathRegistry persistence
const tableSection = arraySectionGenerator('Row', dummySection);

// --- Core Persistence Tests ---

test('persistence: save() stores state and pathRegistry correctly', async () => {
    const storage = createMockStorage();
    const store = createStore(
        { Dummy: dummySection, Table: tableSection, Row: dummySection },
        { persist: { key: 'test-key', storage } }
    );

    await store.hydrate();

    init(store, 'Dummy', '/a');
    store.memo.Dummy['/a'].updater({ count: 5, text: 'hello' });

    init(store, 'Table', '/t'); // Populates pathRegistry for 'Table'

    await store.save();

    const raw = await storage.getItem('test-key');
    assert.ok(raw !== null);

    const parsed = JSON.parse(raw);
    assert.deepEqual(parsed.state.Dummy['/a'], {
        count: 5,
        text: 'hello',
        isLoading: false
    });

    // Dummy has no routing, so pathRegistry is undefined
    assert.equal(parsed.pathRegistry.Dummy, undefined);

    // Table has routing, so its path gets registered and saved
    assert.deepEqual(parsed.pathRegistry.Table, ['/t']);
});

test('persistence: hydrate() restores state and pathRegistry into a fresh store', async () => {
    const storage = createMockStorage();

    // 1. Prepare data
    const store1 = createStore(
        { Dummy: dummySection, Table: tableSection, Row: dummySection },
        { persist: { key: 'test-key', storage } }
    );
    await store1.hydrate();
    init(store1, 'Dummy', '/a');
    init(store1, 'Table', '/t');
    store1.memo.Dummy['/a'].updater({ count: 10 });
    await store1.save();

    // 2. Hydrate into a completely new instance
    const store2 = createStore(
        { Dummy: dummySection, Table: tableSection, Row: dummySection },
        { persist: { key: 'test-key', storage } }
    );
    await store2.hydrate();

    assert.equal(store2.state.Dummy['/a']?.count, 10);
    assert.equal(store2.pathRegistry.Dummy, undefined);
    assert.deepEqual(store2.pathRegistry.Table, ['/t']);
});

test('persistence: omitSections completely excludes specified sections from snapshot', async () => {
    const storage = createMockStorage();
    const store = createStore(
        {
            KeepMe: dummySection,
            OmitMe: dummySection,
            KeepTable: tableSection,
            OmitTable: tableSection,
            Row: dummySection
        },
        {
            persist: {
                key: 'test-key',
                storage,
                omitSections: ['OmitMe', 'OmitTable']
            }
        }
    );

    await store.hydrate();

    init(store, 'KeepMe', '/k');
    init(store, 'OmitMe', '/o');
    init(store, 'KeepTable', '/kt');
    init(store, 'OmitTable', '/ot');

    store.memo.KeepMe['/k'].updater({ count: 1 });
    store.memo.OmitMe['/o'].updater({ count: 2 });

    await store.save();

    const parsed = JSON.parse((await storage.getItem('test-key')) as string);

    // KeepMe should be present
    assert.equal(parsed.state.KeepMe['/k'].count, 1);
    assert.equal(parsed.pathRegistry.KeepMe, undefined);
    assert.deepEqual(parsed.pathRegistry.KeepTable, ['/kt']);

    // OmitMe and OmitTable should be entirely excluded
    assert.equal(parsed.state.OmitMe, undefined);
    assert.equal(parsed.pathRegistry.OmitMe, undefined);
    assert.equal(parsed.state.OmitTable, undefined);
    assert.equal(parsed.pathRegistry.OmitTable, undefined);
});

test('persistence: custom serializer and deserializer apply correctly', async () => {
    const storage = createMockStorage();
    const store = createStore(
        { Dummy: dummySection },
        {
            serializer(
                _: Record<string, unknown>,
                key: string,
                value: unknown
            ) {
                if (key === 'text') {
                    return 'SERIALIZED_' + value;
                }
                return value;
            },
            deserializer(key: string, value: unknown) {
                if (key === 'text' && typeof value === 'string') {
                    return value.replace('SERIALIZED_', '');
                }
                return value;
            },
            persist: { key: 'test-key', storage }
        }
    );

    await store.hydrate();

    init(store, 'Dummy', '/a');
    store.memo.Dummy['/a'].updater({ text: 'secret' });
    await store.save();

    const raw = await storage.getItem('test-key');
    assert.ok(raw?.includes('SERIALIZED_secret'));

    const store2 = createStore(
        { Dummy: dummySection },
        {
            deserializer: (key: string, value: unknown) => {
                if (key === 'text' && typeof value === 'string') {
                    return value.replace('SERIALIZED_', '');
                }
                return value;
            },
            persist: { key: 'test-key', storage }
        }
    );
    await store2.hydrate();

    assert.equal(store2.state.Dummy['/a'].text, 'secret'); // Restored correctly
});

// --- Migrations & Normalization Tests ---

test('persistence: managed migrations run exactly once and update metadata', async () => {
    const storage = createMockStorage();

    // Inject old schema directly
    await storage.setItem(
        'test-key',
        JSON.stringify({
            state: {
                Dummy: {
                    '/a': { count: 1, oldText: 'legacy', isLoading: false }
                }
            },
            pathRegistry: {}
        })
    );

    let migrationRunCount = 0;

    const store = createStore(
        { Dummy: dummySection },
        {
            persist: {
                key: 'test-key',
                storage,
                migrations: {
                    Dummy: [
                        {
                            id: 'v1-migration',
                            migrate: (state: Record<string, unknown>) => {
                                migrationRunCount++;
                                state.text = state.oldText;
                                delete state.oldText;
                            }
                        }
                    ]
                }
            }
        }
    );

    await store.hydrate();

    assert.equal(migrationRunCount, 1);
    assert.equal(store.state.Dummy['/a'].text, 'legacy');
    assert.equal(
        (store.state.Dummy['/a'] as Record<string, unknown>).oldText,
        undefined
    );

    // Ensure it saved the updated metadata after hydration
    const rawAfter = await storage.getItem('test-key');
    const parsedAfter = JSON.parse(rawAfter as string);
    assert.deepEqual(parsedAfter.metadata.executedMigrations, [
        'Dummy/v1-migration'
    ]);

    // Hydrating again should NOT run the migration
    await store.hydrate();
    assert.equal(migrationRunCount, 1);
});

test('persistence: normalization prunes stale fields and resets transient fields', async () => {
    const storage = createMockStorage();

    // Inject polluted state
    await storage.setItem(
        'test-key',
        JSON.stringify({
            state: {
                Dummy: {
                    '/a': {
                        count: 5,
                        text: 'ok',
                        isLoading: true,
                        staleField: 'delete-me'
                    }
                }
            },
            pathRegistry: {}
        })
    );

    const store = createStore(
        { Dummy: dummySection },
        {
            persist: {
                key: 'test-key',
                storage,
                normalization: {
                    pruneStaleFields: true,
                    transientExact: { Dummy: ['isLoading'] }
                }
            }
        }
    );

    await store.hydrate();

    const state = store.state.Dummy['/a'];

    // Pruned
    assert.equal((state as Record<string, unknown>).staleField, undefined);

    // Transient field reset to initialState (false)
    assert.equal(state.isLoading, false);

    // Valid data preserved
    assert.equal(state.count, 5);
});

test('persistence: isTransient, transientPatterns customize normalization properly', async () => {
    const storage = createMockStorage();
    await storage.setItem(
        'test-key',
        JSON.stringify({
            state: {
                Dummy: {
                    '/a': { count: 5, text: 'ok', isLoading: true },
                    '/b': { count: 10, text: 'transient_ok', isLoading: false }
                }
            },
            pathRegistry: {}
        })
    );

    const store = createStore(
        { Dummy: dummySection },
        {
            persist: {
                key: 'test-key',
                storage,
                normalization: {
                    pruneStaleFields: true,
                    transientPatterns: [/isLoading/i],
                    isTransient: (sectionName, fieldName) => {
                        return sectionName === 'Dummy' && fieldName === 'text';
                    }
                }
            }
        }
    );

    await store.hydrate();

    // text was reset by isTransient custom evaluator
    assert.equal(store.state.Dummy['/b'].text, '');
    // isLoading was reset by transientPatterns regex
    assert.equal(store.state.Dummy['/a'].isLoading, false);
});

test('persistence: onBeforeHydrate hook allows custom transformations', async () => {
    const storage = createMockStorage();
    await storage.setItem(
        'test-key',
        JSON.stringify({
            state: { GhostSection: { '/old': { value: 99 } } },
            pathRegistry: { GhostSection: ['/old'] }
        })
    );

    const store = createStore(
        { Dummy: dummySection },
        {
            persist: {
                key: 'test-key',
                storage,
                onBeforeHydrate: snapshot => {
                    const anyState = snapshot.state as Record<string, any>;

                    if (anyState['GhostSection']) {
                        anyState['Dummy'] = {
                            '/new': {
                                count: anyState['GhostSection']['/old'].value,
                                text: '',
                                isLoading: false
                            }
                        };
                    }
                }
            }
        }
    );

    await store.hydrate();

    assert.equal(store.state.Dummy['/new'].count, 99);
    assert.equal(store.pathRegistry.Dummy, undefined);
    // GhostSection natively removed because it's not in sectionMap
    assert.equal(
        (store.state as Record<string, unknown>).GhostSection,
        undefined
    );
    // Invalid pathRegistry natively cleaned up
    assert.equal(
        (store.pathRegistry as Record<string, unknown>).GhostSection,
        undefined
    );
});

test('persistence [INTERACTION]: deep normalization works seamlessly for ArraySection and ObjectSection', async () => {
    const storage = createMockStorage();

    await storage.setItem(
        'test-key',
        JSON.stringify({
            state: {
                Table: {
                    '/t': {
                        order: [1],
                        map: {
                            1: {
                                count: 5,
                                text: 'row',
                                isLoading: true,
                                staleField: 'x'
                            }
                        }
                    }
                }
            },
            pathRegistry: { Table: ['/t'] }
        })
    );

    const store = createStore(
        { Dummy: dummySection, Table: tableSection, Row: dummySection },
        {
            persist: {
                key: 'test-key',
                storage,
                normalization: {
                    pruneStaleFields: true,
                    // The TypeScript error is natively solved, Row holds the isLoading logic
                    transientExact: { Row: ['isLoading'] }
                }
            }
        }
    );

    await store.hydrate();

    const rowState = store.state.Table['/t'].map[1] as any;

    // Both asserts will now PASS because ArraySection natively uses the 'normalize' hook!
    assert.equal(
        rowState.isLoading,
        false,
        'Transient field inside ArraySection item was not reset!'
    );
    assert.equal(
        rowState.staleField,
        undefined,
        'Stale field inside ArraySection item was not pruned!'
    );
});

test('persistence: ArraySection normalize heals corrupted order data', async () => {
    const storage = createMockStorage();
    await storage.setItem(
        'test-key',
        JSON.stringify({
            state: {
                Table: {
                    '/t': {
                        // duplicates, stringified ids, null/true garbage and
                        // a ghost id that has no matching map entry
                        order: [2, '1', 2, null, true, 99],
                        map: {
                            1: { count: 1, text: 'a', isLoading: false },
                            2: { count: 2, text: 'b', isLoading: false },
                            '': { count: 99, text: 'junk', isLoading: false }
                        }
                    }
                }
            },
            pathRegistry: { Table: ['/t'] }
        })
    );

    const store = createStore(
        { Dummy: dummySection, Table: tableSection, Row: dummySection },
        { persist: { key: 'test-key', storage } }
    );

    await store.hydrate();

    const tableState = store.state.Table['/t'];

    // Ghost 99 dropped; '1' coerced to a real number; duplicate 2 removed;
    // null/true rejected (Number(null) === 0 / Number(true) === 1 traps);
    // the empty-string key (which masquerades as id 0) rejected.
    assert.deepEqual(tableState.order, [2, 1]);
    assert.deepEqual(Object.keys(tableState.map).sort(), ['1', '2']);
    assert.equal(tableState.map[1].count, 1);
    assert.equal(tableState.map[2].count, 2);

    // The healed snapshot is persisted back by the repair-save
    const saved = JSON.parse((await storage.getItem('test-key')) as string);
    assert.deepEqual(saved.state.Table['/t'].order, [2, 1]);
    assert.equal(saved.state.Table['/t'].map[''], undefined);
});

// --- Concurrency & Error Handlers Tests ---

test('persistence: hydrate is idempotent and handles concurrent calls safely (Single-Flight)', async () => {
    const storage = createMockStorage();
    let getCallCount = 0;

    const delayedStorage = {
        ...storage,
        getItem: async (key: string) => {
            getCallCount++;
            return new Promise<string | null>(resolve =>
                setTimeout(() => resolve(storage.getItem(key)), 10)
            );
        }
    };

    const store = createStore(
        { Dummy: dummySection },
        { persist: { key: 'test-key', storage: delayedStorage } }
    );

    // Call hydrate twice concurrently
    const p1 = store.hydrate();
    const p2 = store.hydrate();

    assert.equal(
        p1,
        p2,
        'Should return the exact same promise for concurrent calls'
    );

    await Promise.all([p1, p2]);
    assert.equal(getCallCount, 1, 'Storage.getItem should only be called once');
});

test('persistence: save queue prevents race conditions on concurrent saves', async () => {
    const storage = createMockStorage();
    let writeCount = 0;
    let lastWrittenValue = '';

    // Slow storage to force race conditions
    const slowStorage = {
        ...storage,
        setItem: async (key: string, value: string) => {
            writeCount++;
            await new Promise(r => setTimeout(r, 50));
            storage.setItem(key, value);
            lastWrittenValue = value;
        }
    };

    const store = createStore(
        { Dummy: dummySection },
        { persist: { key: 'test-key', storage: slowStorage } }
    );

    await store.hydrate();

    init(store, 'Dummy', '/a');

    // Trigger 3 concurrent saves with different state mutations
    store.memo.Dummy['/a'].updater({ count: 1 });
    const p1 = store.save();

    store.memo.Dummy['/a'].updater({ count: 2 });
    const p2 = store.save();

    store.memo.Dummy['/a'].updater({ count: 3 });
    const p3 = store.save();

    await Promise.all([p1, p2, p3]);

    // Even though save() was called 3 times, the queue ensures sequential execution
    assert.equal(writeCount, 3);

    // The final written value MUST reflect the latest state (count: 3),
    // proving that an older queued save didn't overwrite the newer one.
    const parsedFinal = JSON.parse(lastWrittenValue);
    assert.equal(parsedFinal.state.Dummy['/a'].count, 3);
});

test('persistence: save() during hydrate() waits for hydration to finish (Race Condition Guard)', async () => {
    const storage = createMockStorage();
    let resolveGetItem: (value: string | null) => void;

    const delayedStorage = {
        ...storage,
        getItem: () =>
            new Promise<string | null>(resolve => {
                resolveGetItem = resolve;
            })
    };

    const store = createStore(
        { Dummy: dummySection },
        { persist: { key: 'test-key', storage: delayedStorage } }
    );

    init(store, 'Dummy', '/a');
    store.memo.Dummy['/a'].updater({ count: 99 });

    // 1. Start hydration (it will hang on getItem)
    const hydratePromise = store.hydrate();

    // 2. Trigger save WHILE hydrating is still pending
    const savePromise = store.save();

    // 3. Resolve hydration with empty data (simulating first load)
    resolveGetItem!(null);

    await hydratePromise;
    await savePromise;

    // The save should have captured the state (count: 99) AFTER hydration finished
    const raw = await storage.getItem('test-key');
    const parsed = JSON.parse(raw as string);
    assert.equal(parsed.state.Dummy['/a'].count, 99);
});

test('persistence: corrupt JSON triggers quarantine, creates backup, and starts fresh session', async () => {
    const storage = createMockStorage();
    const badData = '{ invalid json!!!';
    await storage.setItem('test-key', badData);

    const store = createStore(
        { Dummy: dummySection },
        { persist: { key: 'test-key', storage } }
    );

    // Suppress expected console.error/warn for cleaner test output
    await captureConsole('error', async () => {
        await captureConsole('warn', async () => {
            await store.hydrate();
        });
    });

    // 1. App boots normally with empty state
    assert.equal(store.state.Dummy['/a'], undefined);

    // 2. The main key was overwritten with a fresh, healthy snapshot by the repair-save
    const mainRaw = await storage.getItem('test-key');
    const mainParsed = JSON.parse(mainRaw as string);
    assert.deepEqual(mainParsed.state, { Dummy: {} });

    // 3. The backup key was created and contains the exact bad string
    const allKeys = Array.from(storage.snapshot.keys());
    const backupKey = allKeys.find(k =>
        k.startsWith('test-key_corrupted_backup_')
    );
    assert.ok(backupKey, 'Backup key should be generated');
    assert.equal(await storage.getItem(backupKey!), badData);

    // 4. Save is UNLOCKED and works for new updates
    init(store, 'Dummy', '/a');
    store.memo.Dummy['/a'].updater({ count: 99 });
    await store.save();

    const newMainRaw = await storage.getItem('test-key');
    const newMainParsed = JSON.parse(newMainRaw as string);
    assert.equal(newMainParsed.state.Dummy['/a'].count, 99);
});

test('persistence: omitSections works as a dynamic function evaluating current state', async () => {
    const storage = createMockStorage();
    const store = createStore(
        { Dummy: dummySection, Secret: dummySection },
        {
            persist: {
                key: 'test-key',
                storage,
                // Do not persist Secret when count is greater than zero
                omitSections: state =>
                    state.Dummy['/a']?.count > 0 ? ['Secret'] : []
            }
        }
    );

    await store.hydrate();

    init(store, 'Dummy', '/a');
    init(store, 'Secret', '/s');

    store.memo.Secret['/s'].updater({ count: 99 });
    store.memo.Dummy['/a'].updater({ count: 1 }); // Triggers the omit behavior

    await store.save();

    const parsed = JSON.parse((await storage.getItem('test-key')) as string);
    assert.equal(
        parsed.state.Secret,
        undefined,
        'Secret section should be dynamically omitted'
    );
    assert.equal(parsed.state.Dummy['/a'].count, 1);
});

test('persistence: lifecycle hooks (onBeforeSave and customPersistCallback) execute correctly', async () => {
    const storage = createMockStorage();
    let beforeSaveCalled = false;
    let customCallbackCalled = false;

    const store = createStore(
        { Dummy: dummySection },
        {
            persist: {
                key: 'test-key',
                storage,
                onBeforeSave: snapshot => {
                    beforeSaveCalled = true;
                    // Test snapshot structure
                    assert.ok(snapshot.state !== undefined);
                },
                customPersistCallback: async snapshot => {
                    customCallbackCalled = true;
                    assert.ok(snapshot.state !== undefined);
                }
            }
        }
    );

    await store.hydrate();

    init(store, 'Dummy', '/a');
    await store.save();

    assert.equal(beforeSaveCalled, true, 'onBeforeSave was not executed');
    assert.equal(
        customCallbackCalled,
        true,
        'customPersistCallback was not executed'
    );
});

// --- Failure Isolation, Autosave & Snapshot Semantics Tests ---

test('persistence: a failing migration triggers quarantine, creates backup, and starts fresh session', async () => {
    const storage = createMockStorage();
    const originalData = JSON.stringify({
        state: {
            One: { '/x': { count: 7, text: '', isLoading: false } }
        },
        pathRegistry: {}
    });
    await storage.setItem('test-key', originalData);

    const store = createStore(
        { One: dummySection },
        {
            persist: {
                key: 'test-key',
                storage,
                migrations: {
                    One: [
                        {
                            id: 'm1',
                            migrate: () => {
                                throw new Error('migration failed');
                            }
                        }
                    ]
                }
            }
        }
    );

    await captureConsole('error', async () => {
        await captureConsole('warn', async () => {
            await store.hydrate();
        });
    });

    // 1. Main key is overwritten with fresh state (empty)
    const mainRaw = await storage.getItem('test-key');
    const mainParsed = JSON.parse(mainRaw as string);
    assert.deepEqual(mainParsed.state, { One: {} });

    // 2. Backup key created containing the valid JSON string that failed migration
    const allKeys = Array.from(storage.snapshot.keys());
    const backupKey = allKeys.find(k =>
        k.startsWith('test-key_corrupted_backup_')
    );
    assert.ok(backupKey);
    assert.equal(await storage.getItem(backupKey!), originalData);

    // 3. User can save again
    init(store, 'One', '/x');
    store.memo.One['/x'].updater({ count: 42 });
    await store.save();

    const finalMain = JSON.parse((await storage.getItem('test-key')) as string);
    assert.equal(finalMain.state.One['/x'].count, 42);
});

test('persistence: a corrupt pathRegistry triggers quarantine and starts fresh session', async () => {
    const storage = createMockStorage();
    const originalData = JSON.stringify({
        state: {
            Dummy: { '/a': { count: 42, text: 'precious', isLoading: false } }
        },
        // Intentionally corrupt the pathRegistry structure (not an array)
        pathRegistry: { Table: 'not-an-array' }
    });
    await storage.setItem('test-key', originalData);

    const store = createStore(
        { Dummy: dummySection, Table: tableSection, Row: dummySection },
        { persist: { key: 'test-key', storage } }
    );

    await captureConsole('error', async () => {
        await captureConsole('warn', async () => {
            await store.hydrate();
        });
    });

    // 1. The current application state should be empty/fresh
    assert.equal(store.state.Dummy['/a'], undefined);

    // 2. The main key in the database should be replaced with a clean state
    const mainRaw = await storage.getItem('test-key');
    const mainParsed = JSON.parse(mainRaw as string);
    assert.deepEqual(mainParsed.state, { Dummy: {}, Table: {}, Row: {} });

    // 3. A backup of the corrupt data should have been successfully created
    const allKeys = Array.from(storage.snapshot.keys());
    const backupKey = allKeys.find(k =>
        k.startsWith('test-key_corrupted_backup_')
    );
    assert.ok(backupKey, 'Backup key must be created for corrupt pathRegistry');
    assert.equal(await storage.getItem(backupKey!), originalData);

    // 4. The save lock is released and the user can continue
    init(store, 'Dummy', '/a');
    store.memo.Dummy['/a'].updater({ count: 100 });
    await store.save();

    const finalMain = JSON.parse((await storage.getItem('test-key')) as string);
    assert.equal(finalMain.state.Dummy['/a'].count, 100);
});

test('persistence: throwing hooks are isolated and never reject hydrate or save', async () => {
    const storage = createMockStorage();

    const store = createStore(
        { Dummy: dummySection },
        {
            onStateChange: () => {
                throw new Error('onStateChange boom');
            },
            persist: {
                key: 'test-key',
                storage,
                onBeforeSave: () => {
                    throw new Error('onBeforeSave boom');
                },
                onHydrated: () => {
                    throw new Error('onHydrated boom');
                }
            }
        }
    );

    const errors = await captureConsole('error', async () => {
        await assert.doesNotReject(store.hydrate());

        init(store, 'Dummy', '/a');
        // The notification path must swallow the onStateChange failure
        store.memo.Dummy['/a'].updater({ count: 1 });

        await assert.doesNotReject(store.save());
    });

    assert.ok(
        errors.some(message => message.includes('onHydrated hook failed'))
    );
    assert.ok(
        errors.some(message =>
            message.includes('onStateChange callback failed')
        )
    );
    assert.ok(errors.some(message => message.includes('save queue task')));

    // The failed onBeforeSave aborted the write itself
    assert.equal(await storage.getItem('test-key'), null);
});

test('persistence: autosave debounces rapid updates into a single write', async () => {
    const storage = createMockStorage();
    let writeCount = 0;
    const countingStorage = {
        ...storage,
        setItem: async (key: string, value: string) => {
            writeCount++;
            await storage.setItem(key, value);
        }
    };

    const store = createStore(
        { Dummy: dummySection },
        {
            persist: {
                key: 'test-key',
                storage: countingStorage,
                // Function form of autoSave for runtime control
                autoSave: () => true,
                persistDebounceMS: 20
            }
        }
    );

    await store.hydrate();
    init(store, 'Dummy', '/a');

    for (let i = 1; i <= 5; i++) {
        store.memo.Dummy['/a'].updater({ count: i });
    }

    await new Promise(resolve => setTimeout(resolve, 150));

    assert.equal(writeCount, 1, 'rapid updates must coalesce into one write');
    const parsed = JSON.parse((await storage.getItem('test-key')) as string);
    assert.equal(parsed.state.Dummy['/a'].count, 5);
});

test('persistence: persistDebounceMS function form is respected', async () => {
    const storage = createMockStorage();
    let writeCount = 0;
    const countingStorage = {
        ...storage,
        setItem: async (key: string, value: string) => {
            writeCount++;
            await storage.setItem(key, value);
        }
    };

    const store = createStore(
        { Dummy: dummySection },
        {
            persist: {
                key: 'test-key',
                storage: countingStorage,
                autoSave: true,
                persistDebounceMS: () => 60
            }
        }
    );

    await store.hydrate();
    init(store, 'Dummy', '/a');
    store.memo.Dummy['/a'].updater({ count: 1 });

    // Still inside the dynamic debounce window: nothing written yet
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(writeCount, 0);

    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(writeCount, 1);
});

test('persistence: autosave is not scheduled before hydration finishes', async () => {
    const storage = createMockStorage();
    let resolveGetItem: (value: string | null) => void;
    let writeCount = 0;
    const delayedStorage = {
        ...storage,
        getItem: () =>
            new Promise<string | null>(resolve => {
                resolveGetItem = resolve;
            }),
        setItem: async (key: string, value: string) => {
            writeCount++;
            await storage.setItem(key, value);
        }
    };

    const store = createStore(
        { Dummy: dummySection },
        {
            persist: {
                key: 'test-key',
                storage: delayedStorage,
                autoSave: true,
                persistDebounceMS: 10
            }
        }
    );

    const hydratePromise = store.hydrate();

    init(store, 'Dummy', '/a');
    store.memo.Dummy['/a'].updater({ count: 3 });

    // The debounce window elapses while hydration is still pending
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(writeCount, 0, 'no autosave may run before hydration');

    resolveGetItem!(null);
    await hydratePromise;

    // The swallowed notification is not retried: only a new update saves
    store.memo.Dummy['/a'].updater({ count: 4 });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(writeCount, 1);

    const parsed = JSON.parse((await storage.getItem('test-key')) as string);
    assert.equal(parsed.state.Dummy['/a'].count, 4);
});

test('persistence: purge triggers a debounced autosave removing purged paths', async () => {
    const storage = createMockStorage();
    const store = createStore(
        { Dummy: dummySection },
        {
            persist: {
                key: 'test-key',
                storage,
                autoSave: true,
                persistDebounceMS: 10
            }
        }
    );

    await store.hydrate();
    init(store, 'Dummy', '/a');
    init(store, 'Dummy', '/b');
    store.memo.Dummy['/a'].updater({ count: 1 });
    store.memo.Dummy['/b'].updater({ count: 2 });
    await new Promise(resolve => setTimeout(resolve, 80));

    purgeYasmState(store, '/a');
    await new Promise(resolve => setTimeout(resolve, 80));

    const parsed = JSON.parse((await storage.getItem('test-key')) as string);
    assert.equal(parsed.state.Dummy['/a'], undefined);
    assert.equal(parsed.state.Dummy['/b'].count, 2);
});

test('persistence: fresh installs mark migrations as executed without running them', async () => {
    const storage = createMockStorage();
    let runCount = 0;

    const createMigrationStore = () =>
        createStore(
            { Dummy: dummySection },
            {
                persist: {
                    key: 'test-key',
                    storage,
                    migrations: {
                        Dummy: [
                            {
                                id: 'm1',
                                migrate: () => {
                                    runCount++;
                                }
                            }
                        ]
                    }
                }
            }
        );

    // 1. First boot with empty storage: nothing to migrate
    const first = createMigrationStore();
    await first.hydrate();
    assert.equal(runCount, 0);

    init(first, 'Dummy', '/a');
    first.memo.Dummy['/a'].updater({ count: 5 });
    await first.save();

    // The saved bookkeeping already contains the migration marker
    const saved = JSON.parse((await storage.getItem('test-key')) as string);
    assert.deepEqual(saved.metadata.executedMigrations, ['Dummy/m1']);

    // 2. Second boot: the migration must not re-run on fresh-schema data
    const second = createMigrationStore();
    await second.hydrate();
    assert.equal(runCount, 0);
    assert.equal(second.state.Dummy['/a'].count, 5);
});

test('persistence: pathRegistry entries without matching state are pruned and persisted', async () => {
    const storage = createMockStorage();
    await storage.setItem(
        'test-key',
        JSON.stringify({
            state: { Table: { '/kept': { order: [], map: {} } } },
            pathRegistry: { Table: ['/kept', '/ghost'] }
        })
    );

    const store = createStore(
        { Dummy: dummySection, Table: tableSection, Row: dummySection },
        { persist: { key: 'test-key', storage } }
    );

    await store.hydrate();

    assert.deepEqual(store.pathRegistry.Table, ['/kept']);

    // The repair-save persists the pruned registry
    const parsed = JSON.parse((await storage.getItem('test-key')) as string);
    assert.deepEqual(parsed.pathRegistry.Table, ['/kept']);
});

test('persistence: save() captures the snapshot at call time, not queue-drain time', async () => {
    const storage = createMockStorage();

    // Slow storage to keep the save queue backed up
    const slowStorage = {
        ...storage,
        setItem: async (key: string, value: string) => {
            await new Promise(resolve => setTimeout(resolve, 40));
            await storage.setItem(key, value);
        }
    };

    const store = createStore(
        { Dummy: dummySection },
        { persist: { key: 'test-key', storage: slowStorage } }
    );

    await store.hydrate();
    init(store, 'Dummy', '/a');

    store.memo.Dummy['/a'].updater({ count: 1 });
    const saving = store.save(); // captures count: 1 synchronously

    // Mutate before the queued task drains the queue
    store.memo.Dummy['/a'].updater({ count: 2 });

    await saving;
    const firstWrite = JSON.parse(
        (await storage.getItem('test-key')) as string
    );
    assert.equal(
        firstWrite.state.Dummy['/a'].count,
        1,
        'the first save must serialize the state captured at call time'
    );

    await store.save();
    const secondWrite = JSON.parse(
        (await storage.getItem('test-key')) as string
    );
    assert.equal(secondWrite.state.Dummy['/a'].count, 2);
});

test('persistence: autosave uses requestIdleCallback when the browser exposes it', async () => {
    const storage = createMockStorage();

    let idleCallCount = 0;
    const globalScope = globalThis as { window?: unknown };
    const originalWindow = globalScope.window;

    globalScope.window = {
        requestIdleCallback: (callback: IdleRequestCallback) => {
            idleCallCount++;
            setTimeout(callback, 0);
            return 0;
        }
    };

    try {
        const store = createStore(
            { Dummy: dummySection },
            {
                persist: {
                    key: 'test-key',
                    storage,
                    autoSave: true,
                    persistDebounceMS: 10
                }
            }
        );

        await store.hydrate();
        init(store, 'Dummy', '/a');
        store.memo.Dummy['/a'].updater({ count: 8 });

        await new Promise(resolve => setTimeout(resolve, 120));

        assert.equal(idleCallCount, 1, 'the idle-callback branch must be used');
        const parsed = JSON.parse(
            (await storage.getItem('test-key')) as string
        );
        assert.equal(parsed.state.Dummy['/a'].count, 8);
    } finally {
        if (originalWindow === undefined) {
            delete globalScope.window;
        } else {
            globalScope.window = originalWindow;
        }
    }
});

test('persistence: hydration restores routing so children work before the parent mounts', async () => {
    const storage = createMockStorage();
    await storage.setItem(
        'test-key',
        JSON.stringify({
            state: {
                Table: {
                    '/t': {
                        order: [3],
                        map: {
                            3: { count: 1, text: 'persisted', isLoading: false }
                        }
                    }
                }
            },
            pathRegistry: { Table: ['/t'] }
        })
    );

    const store = createStore(
        { Dummy: dummySection, Table: tableSection, Row: dummySection },
        { persist: { key: 'test-key', storage } }
    );
    await store.hydrate();

    // The parent component never mounted — routing works through the
    // restored registry instead of a live registration.
    init(store, 'Row', '/t[3]');
    const row = store.memo.Row['/t[3]'];
    assert.equal(row.getState().text, 'persisted');

    row.updater({ text: 'after hydration' });
    assert.equal(store.state.Table['/t'].map[3].text, 'after hydration');
    assert.equal(store.state.Row['/t[3]'], undefined);
});

test('persistence: lifecycle phases execute in the documented order', async () => {
    const storage = createMockStorage();
    await storage.setItem(
        'test-key',
        JSON.stringify({
            state: {
                Dummy: { '/a': { count: 1, text: '', isLoading: false } }
            },
            pathRegistry: {}
        })
    );

    const phases: string[] = [];
    const seen = new Set<string>();
    const mark = (label: string) => {
        if (!seen.has(label)) {
            seen.add(label);
            phases.push(label);
        }
    };

    const store = createStore(
        { Dummy: dummySection },
        {
            deserializer: (_key, value) => {
                mark('deserialize');
                return value;
            },
            serializer: (_object, _key, value) => {
                mark('serialize');
                return value;
            },
            persist: {
                key: 'test-key',
                storage: {
                    getItem: async key => {
                        mark('getItem');
                        return storage.getItem(key);
                    },
                    setItem: async (key, value) => {
                        mark('setItem');
                        await storage.setItem(key, value);
                    },
                    removeItem: async key => {
                        await storage.removeItem(key);
                    }
                },
                migrations: {
                    Dummy: [
                        {
                            id: 'm1',
                            migrate: () => {
                                mark('migration');
                            }
                        }
                    ]
                },
                onBeforeHydrate: () => {
                    mark('onBeforeHydrate');
                },
                onHydrated: () => {
                    mark('onHydrated');
                },
                onBeforeSave: () => {
                    mark('onBeforeSave');
                }
            }
        }
    );

    await store.hydrate();

    // The migration sets the changed-flag, so the repair-save (onBeforeSave
    // → serialize → setItem) runs after the merge and before onHydrated.
    assert.deepEqual(phases, [
        'getItem',
        'deserialize',
        'migration',
        'onBeforeHydrate',
        'onBeforeSave',
        'serialize',
        'setItem',
        'onHydrated'
    ]);
});

test('persistence: purged state does not resurrect after save and rehydration', async () => {
    const storage = createMockStorage();
    const createTestStore = () =>
        createStore(
            { Dummy: dummySection },
            { persist: { key: 'test-key', storage } }
        );

    const store1 = createTestStore();
    await store1.hydrate();
    init(store1, 'Dummy', '/keep');
    init(store1, 'Dummy', '/gone');
    store1.memo.Dummy['/keep'].updater({ count: 1 });
    store1.memo.Dummy['/gone'].updater({ count: 2 });
    purgeYasmState(store1, '/gone');
    await store1.save();

    const store2 = createTestStore();
    await store2.hydrate();

    assert.equal(store2.state.Dummy['/gone'], undefined);
    assert.equal(store2.state.Dummy['/keep']?.count, 1);
});

test('persistence: custom serializer round-trips BigInt and Date values', async () => {
    const storage = createMockStorage();
    const BIGINT_PREFIX = '$$BIGINT$$_';
    const DATE_PREFIX = '$$DATE$$_';

    type WalletState = { balance: bigint; createdAt: Date };
    const walletSection: Section<WalletState, Partial<WalletState>> = {
        // BigInt() instead of literals: the test tsconfig targets ES5
        initialState: { balance: BigInt(0), createdAt: new Date(0) },
        updater: mergeUpdaterGenerator<WalletState>()
    };

    const createWalletStore = () =>
        createStore(
            { Wallet: walletSection },
            {
                serializer: (object, _key, value) => {
                    const original = object[_key];
                    if (typeof original === 'bigint') {
                        return BIGINT_PREFIX + original.toString();
                    }
                    if (original instanceof Date) {
                        return DATE_PREFIX + original.toISOString();
                    }
                    return value;
                },
                deserializer: (_key, value) => {
                    if (
                        typeof value === 'string' &&
                        value.startsWith(BIGINT_PREFIX)
                    ) {
                        return BigInt(value.slice(BIGINT_PREFIX.length));
                    }
                    if (
                        typeof value === 'string' &&
                        value.startsWith(DATE_PREFIX)
                    ) {
                        return new Date(value.slice(DATE_PREFIX.length));
                    }
                    return value;
                },
                persist: { key: 'test-key', storage }
            }
        );

    const store1 = createWalletStore();
    await store1.hydrate();
    init(store1, 'Wallet', '/w');
    store1.memo.Wallet['/w'].updater({
        balance: BigInt(10),
        createdAt: new Date(1000)
    });
    await store1.save();

    const store2 = createWalletStore();
    await store2.hydrate();

    const restored = store2.state.Wallet['/w'];
    assert.equal(typeof restored.balance, 'bigint');
    assert.equal(restored.balance, BigInt(10));
    assert.ok(restored.createdAt instanceof Date);
    assert.equal(restored.createdAt.getTime(), 1000);
});

test('persistence: normalization fills fields missing from the stored snapshot', async () => {
    const storage = createMockStorage();
    await storage.setItem(
        'test-key',
        JSON.stringify({
            state: { Dummy: { '/a': { count: 5 } } },
            pathRegistry: {}
        })
    );

    const store = createStore(
        { Dummy: dummySection },
        { persist: { key: 'test-key', storage } }
    );
    await store.hydrate();

    const state = store.state.Dummy['/a'];
    assert.equal(state.count, 5); // stored value preserved
    assert.equal(state.text, ''); // missing fields filled from initialState
    assert.equal(state.isLoading, false);
});

test('persistence: duplicate migration ids within a section throw at store creation', () => {
    const storage = createMockStorage();
    const migrate = () => {
        // migrations never run in this test
    };

    assert.throws(
        () =>
            createStore(
                { Dummy: dummySection },
                {
                    persist: {
                        key: 'test-key',
                        storage,
                        migrations: {
                            Dummy: [
                                { id: 'same', migrate },
                                { id: 'same', migrate }
                            ]
                        }
                    }
                }
            ),
        /duplicate migration id "same" in section "Dummy"/
    );

    // The same id in a DIFFERENT section is fine — executed-tracking keys
    // include the section name.
    assert.doesNotThrow(() =>
        createStore(
            { One: dummySection, Two: dummySection },
            {
                persist: {
                    key: 'test-key',
                    storage,
                    migrations: {
                        One: [{ id: 'same', migrate }],
                        Two: [{ id: 'same', migrate }]
                    }
                }
            }
        )
    );
});

test('persistence: pending purgeWhenUnused entries are persisted and drained on hydration', async () => {
    const storage = createMockStorage();

    // Session 1: '/b' is subscribed → its purge stays pending
    const store1 = createStore(
        { Dummy: dummySection },
        { persist: { key: 'test-key', storage } }
    );
    await store1.hydrate();
    init(store1, 'Dummy', '/b');
    const unsubscribe = store1.memo.Dummy['/b'].subscribe(() => undefined);

    store1.purgeWhenUnused('/b');
    await store1.save();

    const saved = JSON.parse((await storage.getItem('test-key')) as string);
    assert.deepEqual(saved.metadata.pendingPurges, [{ pathPrefix: '/b' }]);
    assert.notEqual(
        saved.state.Dummy['/b'],
        undefined,
        'state must be kept while a subscriber is attached'
    );

    unsubscribe();

    // Session 2: nothing is mounted — the persisted pending purge executes
    // during hydration, and the repair-save clears the marker
    const store2 = createStore(
        { Dummy: dummySection },
        { persist: { key: 'test-key', storage } }
    );
    await store2.hydrate();

    assert.equal(store2.state.Dummy['/b'], undefined);
    const after = JSON.parse((await storage.getItem('test-key')) as string);
    assert.equal(after.state.Dummy['/b'], undefined);
    assert.deepEqual(after.metadata.pendingPurges, []);
});

test('persistence: raw purge over a pending purgeWhenUnused drains the pending marker', async () => {
    const storage = createMockStorage();
    const store = createStore(
        { Dummy: dummySection },
        { persist: { key: 'test-key', storage } }
    );
    await store.hydrate();

    init(store, 'Dummy', '/b');
    const unsubscribe = store.memo.Dummy['/b'].subscribe(() => undefined);

    store.purgeWhenUnused('/b'); // pends: /b is subscribed

    // A raw purge destroys the subscriber record directly (with a warning).
    // A raw purge destroys the subscriber record directly (with a warning).
    // The pending entry must reconcile its bookkeeping instead of leaking
    // into every future snapshot's metadata.
    await captureWarnings(() => purgeYasmState(store, '/b'));

    await store.save();
    const saved = JSON.parse((await storage.getItem('test-key')) as string);
    assert.deepEqual(saved.metadata.pendingPurges, []);
    assert.equal(saved.state.Dummy['/b'], undefined);

    // The late unsubscribe is a tolerant no-op and must not resurrect anything
    unsubscribe();
    assert.equal(store.state.Dummy['/b'], undefined);
});

test('persistence: deferred purge marker remains persisted until the actual purge executes', async () => {
    const storage = createMockStorage();

    const store = createStore(
        { Dummy: dummySection },
        { persist: { key: 'test-key', storage } }
    );

    await store.hydrate();

    init(store, 'Dummy', '/gone');

    store.memo.Dummy['/gone'].updater({ count: 2 });

    const unsubscribe = store.memo.Dummy['/gone'].subscribe(() => undefined);

    store.purgeWhenUnused('/gone');

    unsubscribe();

    // This save happens before setTimeout(0) executes.
    await store.save();

    const duringWindow = JSON.parse(
        (await storage.getItem('test-key')) as string
    );

    assert.equal(duringWindow.state.Dummy['/gone'].count, 2);
    assert.deepEqual(duringWindow.metadata.pendingPurges, [
        { pathPrefix: '/gone' }
    ]);

    await new Promise<void>(resolve => setTimeout(resolve, 0));

    await store.save();

    const afterPurge = JSON.parse(
        (await storage.getItem('test-key')) as string
    );

    assert.equal(afterPurge.state.Dummy['/gone'], undefined);
    assert.deepEqual(afterPurge.metadata.pendingPurges, []);
});

test('persistence: immediate purgeWhenUnused leaves no pending markers', async () => {
    const storage = createMockStorage();
    const store = createStore(
        { Dummy: dummySection },
        { persist: { key: 'test-key', storage } }
    );
    await store.hydrate();
    init(store, 'Dummy', '/a');

    // No subscribers → the purge executes immediately, nothing pends
    store.purgeWhenUnused('/a');
    await store.save();

    const saved = JSON.parse((await storage.getItem('test-key')) as string);
    assert.equal(saved.state.Dummy['/a'], undefined);
    assert.deepEqual(saved.metadata.pendingPurges, []);
});

test('persistence: a throwing raw subscriber does not quarantine valid data', async () => {
    const storage = createMockStorage();
    // A previous session persisted valid data.
    await storage.setItem(
        'test-key',
        JSON.stringify({
            state: {
                Dummy: { '/x': { count: 42, text: 'kept', isLoading: false } }
            },
            pathRegistry: {},
            metadata: { executedMigrations: [], pendingPurges: [] }
        })
    );

    const store = createStore(
        { Dummy: dummySection },
        { persist: { key: 'test-key', storage } }
    );

    // App-style unguarded raw subscriber on a path that is never initialized
    // (lazily created + omitted from persistence): it THROWS during the
    // post-hydrate notification pass.
    const unsubBad = store.subscribe(
        () => {
            const s = store.state.Dummy['/never-initialized'];
            if (s === undefined) throw new Error('unguarded mirror');
        },
        'Dummy',
        '/mirror'
    );

    const notified: number[] = [];
    const unsubGood = store.subscribe(() => notified.push(1), 'Dummy', '/x');

    // hydrate() must resolve; the valid snapshot must NOT be quarantined...
    await assert.doesNotReject(() => store.hydrate());
    const keys: string[] = [];
    storage.snapshot.forEach((_v, k) => keys.push(k));
    assert.equal(
        keys.find(k => k.includes('corrupted')),
        undefined,
        'valid persisted data must not be classified as corrupted'
    );

    // ...the merged value must be live in memory...
    assert.equal(store.state.Dummy['/x']?.count, 42);
    // ...and the healthy subscriber must still receive the post-hydrate notify.
    assert.deepEqual(notified, [1]);

    unsubBad();
    unsubGood();
});

test('persistence: primitive/null persisted roots are quarantined and repaired', async () => {
    for (const badRoot of ['null', '7', '"oops"']) {
        const storage = createMockStorage();
        await storage.setItem('test-key', badRoot);

        const store = createStore(
            { Dummy: dummySection },
            { persist: { key: 'test-key', storage } }
        );
        await assert.doesNotReject(() => store.hydrate());

        // Raw payload backed up untouched under a quarantine key...
        const keys: string[] = [];
        storage.snapshot.forEach((_v, k) => keys.push(k));
        const backupKey = keys.find(k =>
            k.startsWith('test-key_corrupted_backup_')
        );
        assert.ok(backupKey, `expected a quarantine key for root ${badRoot}`);
        assert.equal(await storage.getItem(backupKey as string), badRoot);

        // ...and the primary key overwritten with a clean snapshot.
        const cleaned = JSON.parse(
            (await storage.getItem('test-key')) as string
        );
        assert.deepEqual(cleaned.state, { Dummy: {} });
        assert.equal(store.isHydrated(), true);
    }
});

test('persistence: normalization repair-saves fields added from initialState', async () => {
    const storage = createMockStorage();
    // Snapshot from an OLDER schema: `isLoading` did not exist yet.
    await storage.setItem(
        'test-key',
        JSON.stringify({
            state: { Dummy: { '/x': { count: 3, text: 'old' } } },
            pathRegistry: {},
            metadata: { executedMigrations: [], pendingPurges: [] }
        })
    );

    const store = createStore(
        { Dummy: dummySection },
        { persist: { key: 'test-key', storage } }
    );
    await store.hydrate();

    // In-memory state healed AND persisted back — no re-heal next launch.
    const saved = JSON.parse((await storage.getItem('test-key')) as string);
    assert.deepEqual(saved.state.Dummy['/x'], {
        count: 3,
        text: 'old',
        isLoading: false
    });
});

test('persistence: normalize-hook sections do not force a repair-save when nothing changed', async () => {
    const storage = createMockStorage();
    const store1 = createStore(
        { Table: tableSection },
        { persist: { key: 'test-key', storage } }
    );
    await store1.hydrate();
    init(store1, 'Table', '/t');
    store1.memo.Table['/t'].updater({ addingItems: [{ id: 1 }] });
    await store1.save();
    const beforeSave = await storage.getItem('test-key');

    // Fresh store, same storage: hydration normalizes but changes nothing,
    // so NO repair-save may run (the serialized snapshot stays identical).
    const store2 = createStore(
        { Table: tableSection },
        { persist: { key: 'test-key', storage } }
    );
    let saveCalls = 0;
    const origSetItem = storage.setItem.bind(storage);
    storage.setItem = async (k: string, v: string) => {
        saveCalls++;
        return origSetItem(k, v);
    };

    await store2.hydrate();
    assert.equal(
        saveCalls,
        0,
        'unchanged normalize output must not trigger a repair-save'
    );

    const afterHydrate = await storage.getItem('test-key');
    assert.equal(afterHydrate, beforeSave);
});

// --- onQuarantine lifecycle callback ---

test('persistence: onQuarantine receives the corrupt payload, backup key and error', async () => {
    const storage = createMockStorage();
    const badData = '{ invalid json!!!';
    await storage.setItem('test-key', badData);

    let info: QuarantineInfo | undefined;
    const store = createStore(
        { Dummy: dummySection },
        {
            persist: {
                key: 'test-key',
                storage,
                onQuarantine: received => {
                    info = received;
                }
            }
        }
    );

    await captureConsole('error', async () => {
        await captureConsole('warn', async () => {
            await store.hydrate();
        });
    });

    assert.ok(info, 'onQuarantine must be called on corruption');
    assert.equal(info!.key, 'test-key');
    assert.ok(
        info!.backupKey !== null &&
            info!.backupKey.startsWith('test-key_corrupted_backup_')
    );
    assert.equal(info!.rawData, badData);
    assert.match(String(info!.error), /JSON/i);

    // The backup key really contains the untouched corrupt payload, and the
    // primary key was reset to a clean snapshot.
    assert.equal(await storage.getItem(info!.backupKey!), badData);
    const mainRaw = JSON.parse((await storage.getItem('test-key')) as string);
    assert.deepEqual(mainRaw.state, { Dummy: {} });
});

test('persistence: onQuarantine fires when a migration throws', async () => {
    const storage = createMockStorage();
    const originalData = JSON.stringify({
        state: { One: { '/x': { count: 7, text: '', isLoading: false } } },
        pathRegistry: {}
    });
    await storage.setItem('test-key', originalData);

    let info: QuarantineInfo | undefined;
    const store = createStore(
        { One: dummySection },
        {
            persist: {
                key: 'test-key',
                storage,
                migrations: {
                    One: [
                        {
                            id: 'm1',
                            migrate: () => {
                                throw new Error('migration failed');
                            }
                        }
                    ]
                },
                onQuarantine: received => {
                    info = received;
                }
            }
        }
    );

    await captureConsole('error', async () => {
        await captureConsole('warn', async () => {
            await store.hydrate();
        });
    });

    assert.ok(info);
    assert.equal(info!.rawData, originalData);
    assert.match(String(info!.error), /migration failed/);
    assert.equal(await storage.getItem(info!.backupKey!), originalData);
});

test('persistence: a throwing onQuarantine does not break hydration or the quarantine reset', async () => {
    const storage = createMockStorage();
    await storage.setItem('test-key', '{ broken');

    let calls = 0;
    const store = createStore(
        { Dummy: dummySection },
        {
            persist: {
                key: 'test-key',
                storage,
                onQuarantine: () => {
                    calls++;
                    throw new Error('sentry is down');
                }
            }
        }
    );

    const errors = await captureConsole('error', async () => {
        await captureConsole('warn', async () => {
            await assert.doesNotReject(async () => store.hydrate());
        });
    });

    assert.equal(calls, 1);
    assert.ok(
        errors.some(msg => String(msg).includes('onQuarantine callback failed'))
    );
    assert.equal(store.getHydrationStatus(), 'quarantined');

    // The primary key was STILL reset and the session stays usable.
    const mainRaw = JSON.parse((await storage.getItem('test-key')) as string);
    assert.deepEqual(mainRaw.state, { Dummy: {} });
    init(store, 'Dummy', '/a');
    store.memo.Dummy['/a'].updater({ count: 42 });
    await store.save();
});

test('persistence: an async onQuarantine is awaited before hydration completes', async () => {
    const storage = createMockStorage();
    await storage.setItem('test-key', '{ broken');

    let finished = false;
    const store = createStore(
        { Dummy: dummySection },
        {
            persist: {
                key: 'test-key',
                storage,
                onQuarantine: async () => {
                    await Promise.resolve();
                    finished = true;
                }
            }
        }
    );

    await captureConsole('error', async () => {
        await captureConsole('warn', async () => {
            await store.hydrate();
        });
    });

    assert.equal(
        finished,
        true,
        'hydration must await the async onQuarantine callback'
    );
});

test('persistence: onQuarantine is NOT called on a healthy hydration', async () => {
    const storage = createMockStorage();
    await storage.setItem(
        'test-key',
        JSON.stringify({ state: { Dummy: {} }, pathRegistry: {} })
    );

    let calls = 0;
    const store = createStore(
        { Dummy: dummySection },
        {
            persist: {
                key: 'test-key',
                storage,
                onQuarantine: () => {
                    calls++;
                }
            }
        }
    );

    await store.hydrate();
    assert.equal(calls, 0);
});

test('persistence: onQuarantine reports backupKey null when the backup write fails', async () => {
    const storage = createMockStorage();
    await storage.setItem('test-key', '{ broken');
    const originalSetItem = storage.setItem.bind(storage);
    storage.setItem = async (key: string, value: string) => {
        if (key.startsWith('test-key_corrupted_backup_')) {
            throw new Error('disk full');
        }
        return originalSetItem(key, value);
    };

    let info: QuarantineInfo | undefined;
    const store = createStore(
        { Dummy: dummySection },
        {
            persist: {
                key: 'test-key',
                storage,
                onQuarantine: received => {
                    info = received;
                }
            }
        }
    );

    await captureConsole('error', async () => {
        await captureConsole('warn', async () => {
            await assert.doesNotReject(async () => store.hydrate());
        });
    });

    assert.ok(info);
    assert.equal(info!.backupKey, null);
    assert.equal(store.getHydrationStatus(), 'quarantined');
});

// --- Observable hydration lifecycle ---

test('hydration status: reflects whether persistence is configured', () => {
    const noPersistStore = createStore({ Dummy: dummySection });
    assert.equal(noPersistStore.getHydrationStatus(), 'hydrated');
    assert.equal(noPersistStore.getHydrationSnapshot().isHydrated, true);
    assert.equal(noPersistStore.isHydrated(), true);

    const persistStore = createStore(
        { Dummy: dummySection },
        { persist: { key: 'k', storage: createMockStorage() } }
    );
    assert.equal(persistStore.getHydrationStatus(), 'idle');
    assert.equal(persistStore.getHydrationSnapshot().isHydrated, false);
    assert.equal(persistStore.isHydrated(), false);
});

test('hydration status: hydrate() transitions idle → hydrating → hydrated', async () => {
    const storage = createMockStorage();
    const store = createStore(
        { Dummy: dummySection },
        { persist: { key: 'test-key', storage } }
    );

    const transitions: HydrationStatus[] = [];
    store.subscribeHydration(() =>
        transitions.push(store.getHydrationStatus())
    );

    const hydration = store.hydrate();
    assert.equal(store.getHydrationStatus(), 'hydrating');

    await hydration;
    assert.equal(store.getHydrationStatus(), 'hydrated');
    assert.deepEqual(transitions, ['hydrating', 'hydrated']);
    assert.equal(store.getHydrationSnapshot().isHydrated, true);
});

test('hydration status: stays hydrating while a slow storage read is in flight', async () => {
    const storage = createMockStorage();
    let releaseGet: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
        releaseGet = resolve;
    });

    const store = createStore(
        { Dummy: dummySection },
        {
            persist: {
                key: 'test-key',
                storage: {
                    ...storage,
                    getItem: async () => {
                        await gate;
                        return null;
                    }
                }
            }
        }
    );

    const hydration = store.hydrate();
    assert.equal(store.getHydrationStatus(), 'hydrating');

    releaseGet();
    await hydration;
    assert.equal(store.getHydrationStatus(), 'hydrated');
});

test('hydration status: the snapshot object is stable between transitions', async () => {
    const storage = createMockStorage();
    const store = createStore(
        { Dummy: dummySection },
        { persist: { key: 'test-key', storage } }
    );

    const idle = store.getHydrationSnapshot();
    assert.equal(store.getHydrationSnapshot(), idle);

    await store.hydrate();
    const hydrated = store.getHydrationSnapshot();
    assert.notEqual(hydrated, idle);
    assert.equal(store.getHydrationSnapshot(), hydrated);
});

test('hydration status: a corrupt payload lands on quarantined with the error attached', async () => {
    const storage = createMockStorage();
    await storage.setItem('test-key', '{ nope');

    const store = createStore(
        { Dummy: dummySection },
        { persist: { key: 'test-key', storage } }
    );

    const transitions: HydrationStatus[] = [];
    store.subscribeHydration(() =>
        transitions.push(store.getHydrationStatus())
    );

    await captureConsole('error', async () => {
        await captureConsole('warn', async () => {
            await assert.doesNotReject(async () => store.hydrate());
        });
    });

    assert.equal(store.getHydrationStatus(), 'quarantined');
    assert.deepEqual(transitions, ['hydrating', 'quarantined']);

    const snapshot = store.getHydrationSnapshot();
    assert.equal(snapshot.isHydrated, true, 'the app boots normally');
    assert.ok(snapshot.error !== undefined);
});

test('hydration status: an unrecoverable repair-save failure lands on failed', async () => {
    const storage = createMockStorage();
    await storage.setItem('test-key', '{ nope');

    const store = createStore(
        { Dummy: dummySection },
        {
            persist: {
                key: 'test-key',
                storage,
                // Throws synchronously while save() builds its snapshot — the
                // repair-save after the quarantine reset therefore rejects.
                omitSections: () => {
                    throw new Error('omitSections exploded');
                }
            }
        }
    );

    let rejection: unknown = undefined;
    await captureConsole('error', async () => {
        await captureConsole('warn', async () => {
            try {
                await store.hydrate();
            } catch (error) {
                rejection = error;
            }
        });
    });

    assert.ok(rejection !== undefined, 'hydrate() must reject');
    assert.match(String(rejection), /omitSections exploded/);

    assert.equal(store.getHydrationStatus(), 'failed');
    const snapshot = store.getHydrationSnapshot();
    assert.equal(snapshot.isHydrated, false);
    assert.ok(snapshot.error !== undefined);
});

test('persistence: a storage getItem failure does not wipe existing data', async () => {
    const storage = createMockStorage();
    await storage.setItem(
        'test-key',
        JSON.stringify({
            state: {
                Dummy: { '/a': { count: 100, text: 'keep', isLoading: false } }
            },
            pathRegistry: {},
            metadata: { executedMigrations: [], pendingPurges: [] }
        })
    );

    // The real adapter stays readable — only the store's read path throws.
    const brokenStorage = {
        ...storage,
        getItem: async () => {
            throw new Error('Disk unreadable');
        }
    };

    const store = createStore(
        { Dummy: dummySection },
        { persist: { key: 'test-key', storage: brokenStorage } }
    );

    await captureConsole('error', () => store.hydrate());
    assert.equal(store.getHydrationStatus(), 'failed');

    // The unreadable DB must not be overwritten with an empty state.
    const raw = await storage.getItem('test-key');
    assert.ok(raw?.includes('keep'));
});

test('hydration status: subscribeHydration unsubscribes per callback', async () => {
    const storage = createMockStorage();
    const store = createStore(
        { Dummy: dummySection },
        { persist: { key: 'test-key', storage } }
    );

    let a = 0;
    let b = 0;
    store.subscribeHydration(() => a++);
    const unsubscribeB = store.subscribeHydration(() => b++);
    unsubscribeB();

    await store.hydrate();

    assert.equal(a, 2, 'the subscribed callback sees both transitions');
    assert.equal(b, 0, 'the unsubscribed callback is never called');
});
