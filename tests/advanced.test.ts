import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { YasmContext } from '../src/Context';
import { createStore, Section } from '../src/createStore';
import { init, route, useYasmState } from '../src/useYasmState';
import { purgeYasmState } from '../src/purge';
import {
    arraySectionGenerator,
    deepFreeze,
    extractObjectIndexAndRemainedPathQuery,
    immer,
    mergeUpdaterGenerator,
    objectSectionGenerator,
    snapshot
} from '../src/util';

type State = { value: number; text: string };
const section: Section<State, Partial<State>> = {
    initialState: { value: 0, text: '' },
    updater: mergeUpdaterGenerator<State>()
};

const createStorage = (initial?: string | null) => {
    let value = initial ?? null;
    return {
        getItem: () => value,
        setItem: (_key: string, next: string) => {
            value = next;
        },
        removeItem: () => {
            value = null;
        },
        read: () => value
    };
};

const captureDebug = async (fn: () => void | Promise<void>) => {
    const original = console.debug;
    const messages: unknown[][] = [];
    console.debug = (...args: unknown[]) => messages.push(args);
    try {
        await fn();
    } finally {
        console.debug = original;
    }
    return messages;
};

const captureErrors = async (fn: () => void | Promise<void>) => {
    const original = console.error;
    const messages: unknown[][] = [];
    console.error = (...args: unknown[]) => messages.push(args);
    try {
        await fn();
    } finally {
        console.error = original;
    }
    return messages;
};

test('deepFreeze freezes nested, circular and symbol-keyed values without invoking getters', () => {
    const symbol = Symbol('nested');
    const child = { value: 1 };
    const root: Record<PropertyKey, unknown> = { child };
    root[symbol] = { value: 2 };
    root.self = root;
    let getterCalls = 0;
    Object.defineProperty(root, 'computed', {
        get: () => {
            getterCalls++;
            return child;
        },
        enumerable: true
    });

    deepFreeze(root);

    assert.equal(Object.isFrozen(root), true);
    assert.equal(Object.isFrozen(child), true);
    assert.equal(Object.isFrozen(root[symbol]), true);
    assert.equal(Object.isFrozen(root.self), true);
    assert.equal(getterCalls, 0);
    void (root as { computed: unknown }).computed;
    assert.equal(getterCalls, 1);
});

test('snapshot round-trips undefined values and invokes custom serialization hooks', async () => {
    const messages = await captureDebug(() => {
        snapshot(
            { present: 1, missing: undefined, nested: { missing: undefined } },
            {
                serializer: (_object, key, value) =>
                    key === 'present' ? Number(value) + 1 : value,
                deserializer: (_key, value) => value
            }
        );
    });

    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0][0], {
        present: 2,
        missing: undefined,
        nested: { missing: undefined }
    });
});

test('custom path boundary options are used by routing and purge matching', async () => {
    const row: Section<State, Partial<State>> = section;
    const table = arraySectionGenerator('Row', row);
    const store = createStore(
        { Table: table, Row: row },
        { pathBoundaryChars: () => ['/', '~'] }
    );

    assert.deepEqual(store.pathBoundaryChars, ['/', '~']);
    init(store, 'Table', '/table');
    init(store, 'Row', '/table.1');
    assert.notEqual(store.state.Row['/table.1'], undefined);

    init(store, 'Row', '/table/child');
    purgeYasmState(store, '/table');
    assert.equal(store.state.Row['/table/child'], undefined);
    assert.notEqual(store.state.Row['/table.1'], undefined);
});

test('ObjectSection routes child reads and updates, and validates malformed paths', () => {
    const composed = objectSectionGenerator({
        value: {
            name: 'Value',
            state: { value: 1 },
            updater: mergeUpdaterGenerator<{ value: number }>()
        },
        text: {
            name: 'Text',
            state: { text: 'initial' },
            updater: mergeUpdaterGenerator<{ text: string }>()
        }
    });
    const store = createStore({
        Form: composed,
        Value: section,
        Text: section
    });
    init(store, 'Form', '/form');
    const form = store.memo.Form['/form'];
    form.updater({ value: { value: 4 } });

    init(store, 'Value', '/form[value]');
    const value = store.memo.Value['/form[value]'];
    assert.equal(value.getState().value, 4);
    value.updater({ value: 8 });
    assert.equal(store.state.Form['/form'].value.value, 8);

    assert.deepEqual(extractObjectIndexAndRemainedPathQuery('[x]/y'), [
        'x',
        '/y'
    ]);
    assert.equal(typeof extractObjectIndexAndRemainedPathQuery('x'), 'string');

    const invalidChild = init(store, 'Value', '/form[]');
    assert.throws(() => invalidChild.getState(), /invalid ObjectSection path/);

    const missingChild = route(store, 'Value', '/form[missing]');
    assert.throws(() => missingChild.getState(), /has not been initialized/);
});

test('routing reports unknown targets and malformed array/missing-element paths', async () => {
    const table = arraySectionGenerator('MissingRow', section);
    const errors = await captureErrors(() => {
        createStore({ Table: table } as never);
    });
    assert.equal(errors.length, 1);
    assert.match(String(errors[0][0]), /no "MissingRow" section/);

    const store = createStore({ Table: table, MissingRow: section });
    init(store, 'Table', '/table');

    const invalidArrayChild = init(store, 'MissingRow', '/table[]');
    assert.throws(
        () => invalidArrayChild.getState(),
        /invalid ArraySection path/
    );

    const missingArrayChild = init(store, 'MissingRow', '/table[99]');
    assert.throws(
        () => missingArrayChild.getState(),
        /element \(index 99\) that has not been initialized/
    );
});

test('updates preserve identity and notify only when state changes', async () => {
    let changes = 0;
    const store = createStore(
        { State: section },
        { onStateChange: () => changes++ }
    );
    init(store, 'State', '/a');
    const record = store.memo.State['/a'];
    let subscribers = 0;
    record.subscribe(() => subscribers++);

    record.updater({ value: 0 });
    assert.equal(changes, 0);
    assert.equal(subscribers, 0);
    record.updater({ value: 1 });
    assert.equal(changes, 1);
    assert.equal(subscribers, 1);
    purgeYasmState(store, '/a');
    assert.equal(changes, 2);
});

test('debug options log local/full update and none/full purge snapshots', async () => {
    const localStore = createStore(
        { State: section },
        { debugOptions: { logStateUpdates: true } }
    );
    init(localStore, 'State', '/a');
    const localMessages = await captureDebug(() =>
        localStore.memo.State['/a'].updater({ value: 2 })
    );
    assert.ok(localMessages.some(args => String(args[0]).includes('updating')));
    assert.ok(localMessages.some(args => args[0] === 'before:'));

    const fullStore = createStore(
        { State: section },
        {
            debugOptions: {
                logStateUpdates: true,
                snapshotScope: 'full',
                purgeSnapshotScope: 'full'
            }
        }
    );
    init(fullStore, 'State', '/a');
    const fullMessages = await captureDebug(() =>
        purgeYasmState(fullStore, '/a')
    );
    assert.ok(fullMessages.some(args => args[0] === 'before purge:'));
    assert.ok(fullMessages.some(args => args[0] === 'after purge:'));
});

test('persistence supports custom-only saves, pre-hydration protection, and null snapshots', async () => {
    let callbackCount = 0;
    const customStore = createStore(
        { State: section },
        {
            persist: {
                customPersistCallback: snapshotValue => {
                    callbackCount++;
                    assert.ok(snapshotValue.state.State);
                }
            }
        }
    );
    init(customStore, 'State', '/a');
    await customStore.save();
    assert.equal(callbackCount, 0);
    await customStore.hydrate();
    await customStore.save();
    assert.equal(callbackCount, 1);

    let hydrated = 0;
    const storage = createStorage('null');
    const store = createStore(
        { State: section },
        { persist: { key: 'key', storage, onHydrated: () => hydrated++ } }
    );
    await store.hydrate();
    assert.equal(hydrated, 1);
    assert.deepEqual(store.state, { State: {} });
});

test('normalization false preserves stale fields while pruneStaleFields false supports dictionaries', async () => {
    const raw = JSON.stringify({
        state: { State: { '/a': { value: 3, text: 'x', stale: true } } },
        pathRegistry: {}
    });
    const disabledStorage = createStorage(raw);
    const disabled = createStore(
        { State: section },
        {
            persist: {
                key: 'key',
                storage: disabledStorage,
                normalization: false
            }
        }
    );
    await disabled.hydrate();
    assert.equal(
        (disabled.state.State['/a'] as State & { stale: boolean }).stale,
        true
    );

    const permissiveStorage = createStorage(raw);
    const permissive = createStore(
        { State: section },
        {
            persist: {
                key: 'key',
                storage: permissiveStorage,
                normalization: { pruneStaleFields: false }
            }
        }
    );
    await permissive.hydrate();
    assert.equal(
        (permissive.state.State['/a'] as State & { stale: boolean }).stale,
        true
    );
});

test('React hooks require a provider and render selected state with a provider', () => {
    const missingProvider = () =>
        renderToString(
            React.createElement(() => {
                // The hook throws during rendering, which is the public error contract.
                useYasmState('State' as never, '/a');
                return null;
            })
        );
    assert.throws(missingProvider, /no store was found in the React context/);

    const store = createStore({ State: section });
    const Consumer = () => {
        const [value] = useYasmState('State', '/a', state => state.value);
        return React.createElement('span', null, value);
    };
    const html = renderToString(
        React.createElement(
            YasmContext.Provider,
            { value: store as never },
            React.createElement(Consumer)
        )
    );
    assert.match(html, />0</);
});

test('array section normalizer rejects malformed persisted maps safely', async () => {
    const storage = createStorage(
        JSON.stringify({
            state: {
                Table: {
                    '/t': { order: 'not-an-array', map: { bad: {}, 0: null } }
                }
            },
            pathRegistry: { Table: ['/t'] }
        })
    );
    const table = arraySectionGenerator('Row', section);
    const store = createStore(
        { Table: table, Row: section },
        { persist: { key: 'key', storage } }
    );
    await store.hydrate();
    assert.deepEqual(store.state.Table['/t'].order, []);
    assert.deepEqual(store.state.Table['/t'].map, { 0: section.initialState });
});

test('failed storage writes and reads are isolated and reported', async () => {
    const writeFailure = createStorage();
    writeFailure.setItem = () => {
        throw new Error('write failed');
    };
    const store = createStore(
        { State: section },
        { persist: { key: 'key', storage: writeFailure } }
    );
    await store.hydrate();
    init(store, 'State', '/a');
    const writeErrors = await captureErrors(() => store.save());
    assert.ok(writeErrors.some(args => String(args[0]).includes('save queue')));

    const readFailure = {
        ...createStorage(),
        getItem: () => {
            throw new Error('read failed');
        }
    };
    const readStore = createStore(
        { State: section },
        { persist: { key: 'key', storage: readFailure } }
    );
    const readErrors = await captureErrors(() => readStore.hydrate());
    assert.ok(
        readErrors.some(args => String(args[0]).includes('hydrate state'))
    );
});

test('object updates remain immutable when composed through Immer', () => {
    const composed = objectSectionGenerator({
        child: {
            name: 'Child',
            state: { value: 1 },
            updater: mergeUpdaterGenerator<{ value: number }>()
        }
    });
    const before = composed.initialState;
    const after = immer.produce(before, draft => {
        composed.updater(draft, { child: { value: 2 } });
    });
    assert.equal(before.child.value, 1);
    assert.equal(after.child.value, 2);
    assert.notEqual(after, before);
});
