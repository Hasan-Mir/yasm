import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cloneYasmSubtree } from '../src/clone';
import { Section, createStore } from '../src/createStore';
import { init } from '../src/useYasmState';
import { arraySectionGenerator, mergeUpdaterGenerator, objectSectionGenerator } from '../src/util';
import { counterSection } from './helpers';

test('cloneSubtree: clones state across simple sections independently', () => {
    const store = createStore({ Counter: counterSection });
    init(store, 'Counter', '/tabs/1/counter');
    store.memo.Counter['/tabs/1/counter'].updater({
        count: 42,
        label: 'original'
    });

    cloneYasmSubtree(store, '/tabs/1', '/tabs/2');

    assert.deepEqual(store.state.Counter['/tabs/2/counter'], {
        count: 42,
        label: 'original'
    });

    // Verify reference independence
    store.memo.Counter['/tabs/1/counter'].updater({ count: 99 });
    assert.equal(store.state.Counter['/tabs/1/counter'].count, 99);
    assert.equal(store.state.Counter['/tabs/2/counter'].count, 42);
});

test('cloneSubtree: respects segment boundaries (no sibling hijacking)', () => {
    const store = createStore({ Counter: counterSection });
    init(store, 'Counter', '/tabs/1');
    init(store, 'Counter', '/tabs/10');
    store.memo.Counter['/tabs/1'].updater({ count: 1 });
    store.memo.Counter['/tabs/10'].updater({ count: 10 });

    cloneYasmSubtree(store, '/tabs/1', '/tabs/copy');

    assert.equal(store.state.Counter['/tabs/copy']?.count, 1);
    assert.equal(store.state.Counter['/tabs/copy0'], undefined);
});

test('cloneSubtree: normalizes asymmetric trailing slashes between source and target', () => {
    const store = createStore({ Counter: counterSection });
    init(store, 'Counter', '/tabs/1/counter');
    store.memo.Counter['/tabs/1/counter'].updater({ count: 10 });

    // Permutation 1: Source has trailing slash, target does not
    cloneYasmSubtree(store, '/tabs/1/', '/tabs/2');
    assert.equal(store.state.Counter['/tabs/2/counter']?.count, 10);
    assert.equal(store.state.Counter['/tabs/2counter'], undefined);

    // Permutation 2: Target has trailing slash, source does not
    cloneYasmSubtree(store, '/tabs/1', '/tabs/3/');
    assert.equal(store.state.Counter['/tabs/3/counter']?.count, 10);
    assert.equal(store.state.Counter['/tabs/3//counter'], undefined);

    // Permutation 3: Both have trailing slashes
    cloneYasmSubtree(store, '/tabs/1/', '/tabs/4/');
    assert.equal(store.state.Counter['/tabs/4/counter']?.count, 10);
    assert.equal(store.state.Counter['/tabs/4//counter'], undefined);
});

test('cloneSubtree: duplicates pathRegistry so ArraySection child routing works on target', () => {
    type Row = { title: string; done: boolean };
    const rowSection: Section<Row, Partial<Row>> = {
        initialState: { title: '', done: false },
        updater: mergeUpdaterGenerator<Row>()
    };

    const store = createStore({
        Table: arraySectionGenerator('Row', rowSection),
        Row: rowSection
    });

    init(store, 'Table', '/page1/table');
    store.memo.Table['/page1/table'].updater({
        addingItems: [{ id: 5, partialState: { title: 'Item 5' } }],
        order: [5]
    });

    // Parent path is registered in store.pathRegistry
    assert.deepEqual(store.pathRegistry.Table, ['/page1/table']);

    cloneYasmSubtree(store, '/page1', '/page2');

    // Both state and pathRegistry must reflect the cloned path
    assert.deepEqual(store.pathRegistry.Table, [
        '/page1/table',
        '/page2/table'
    ]);
    assert.deepEqual(store.state.Table['/page2/table'].order, [5]);
    assert.equal(store.state.Table['/page2/table'].map[5].title, 'Item 5');

    // Child hook at the target path must route through Table without creating separate storage
    init(store, 'Row', '/page2/table[5]');
    const childRecord = store.memo.Row['/page2/table[5]'];
    assert.equal(childRecord.getState().title, 'Item 5');

    childRecord.updater({ title: 'Modified in Page 2' });
    assert.equal(
        store.state.Table['/page2/table'].map[5].title,
        'Modified in Page 2'
    );
    assert.equal(store.state.Table['/page1/table'].map[5].title, 'Item 5');
    assert.equal(store.state.Row['/page2/table[5]'], undefined);
});

test('cloneSubtree: omitSections leaves specified sections untouched in state and registry', () => {
    const dialogSection: Section<{ isOpen: boolean }, { isOpen: boolean }> = {
        initialState: { isOpen: false },
        updater: mergeUpdaterGenerator<{ isOpen: boolean }>()
    };
    const rowSection: Section<{ name: string }, Partial<{ name: string }>> = {
        initialState: { name: '' },
        updater: mergeUpdaterGenerator<{ name: string }>()
    };

    const store = createStore({
        Counter: counterSection,
        Dialog: dialogSection,
        Table: arraySectionGenerator('Row', rowSection),
        Row: rowSection
    });

    init(store, 'Counter', '/tab1/counter');
    init(store, 'Dialog', '/tab1/modal');
    init(store, 'Table', '/tab1/table');
    store.memo.Counter['/tab1/counter'].updater({ count: 10 });
    store.memo.Dialog['/tab1/modal'].updater({ isOpen: true });

    cloneYasmSubtree(store, '/tab1', '/tab2', {
        omitSections: ['Dialog', 'Table']
    });

    assert.equal(store.state.Counter['/tab2/counter']?.count, 10);
    assert.equal(store.state.Dialog['/tab2/modal'], undefined);
    assert.equal(store.state.Table['/tab2/table'], undefined);
    // pathRegistry of omitted Table must not be cloned
    assert.deepEqual(store.pathRegistry.Table, ['/tab1/table']);
});

test('cloneSubtree: transform option mutates state before placement', () => {
    const store = createStore({ Counter: counterSection });
    init(store, 'Counter', '/tab1/counter');
    store.memo.Counter['/tab1/counter'].updater({
        count: 10,
        label: 'orig'
    });

    cloneYasmSubtree(store, '/tab1', '/tab2', {
        transform: (sectionName, state) => {
            if (sectionName === 'Counter') {
                const s = state as { count: number; label: string };
                return { ...s, label: `${s.label} (clone)` };
            }
            return state;
        }
    });

    assert.deepEqual(store.state.Counter['/tab2/counter'], {
        count: 10,
        label: 'orig (clone)'
    });
});

test('cloneSubtree: preserves custom data types with serializer & deserializer', () => {
    class MockDecimal {
        constructor(public value: string) {}
        toJSON() {
            return this.value;
        }
    }

    type PriceState = { amount: MockDecimal; date: Date };
    const priceSection: Section<PriceState, Partial<PriceState>> = {
        initialState: { amount: new MockDecimal('0'), date: new Date(0) },
        updater: mergeUpdaterGenerator<PriceState>()
    };

    const store = createStore(
        { Price: priceSection },
        {
            serializer(obj, key, val) {
                const raw = obj[key];
                if (raw instanceof MockDecimal) {
                    return `$$DECIMAL$$_` + raw.value;
                }
                if (raw instanceof Date) {
                    return `$$DATE$$_` + raw.toISOString();
                }
                return val;
            },
            deserializer(_key, val) {
                if (typeof val === 'string' && val.startsWith('$$DECIMAL$$_')) {
                    return new MockDecimal(val.slice('$$DECIMAL$$_'.length));
                }
                if (typeof val === 'string' && val.startsWith('$$DATE$$_')) {
                    return new Date(val.slice('$$DATE$$_'.length));
                }
                return val;
            }
        }
    );

    init(store, 'Price', '/price/1');
    store.memo.Price['/price/1'].updater({
        amount: new MockDecimal('1500.50'),
        date: new Date('2026-09-19T10:00:00.000Z')
    });

    cloneYasmSubtree(store, '/price/1', '/price/2');

    const cloned = store.state.Price['/price/2'];
    assert.ok(cloned.amount instanceof MockDecimal);
    assert.equal(cloned.amount.value, '1500.50');
    assert.ok(cloned.date instanceof Date);
    assert.equal(cloned.date.toISOString(), '2026-09-19T10:00:00.000Z');

    // Deep independence survives custom-type cloning
    assert.notEqual(
        store.state.Price['/price/1'].amount,
        store.state.Price['/price/2'].amount
    );
});

test('cloneSubtree: falls back to structuredClone for BigInt values', () => {
    type Money = { total: bigint };
    const moneySection: Section<Money, Partial<Money>> = {
        initialState: { total: BigInt(0) },
        updater: mergeUpdaterGenerator<Money>()
    };

    const store = createStore({ Money: moneySection });
    init(store, 'Money', '/wallet/1');
    store.memo.Money['/wallet/1'].updater({
        total: BigInt('9007199254740993')
    });

    // The default serializer is plain JSON (which cannot carry BigInt), so the
    // clone must degrade to `structuredClone` instead of corrupting the value.
    cloneYasmSubtree(store, '/wallet/1', '/wallet/2');

    const cloned = store.state.Money['/wallet/2'].total;
    assert.equal(typeof cloned, 'bigint');
    assert.equal(cloned, BigInt('9007199254740993'));
});

test('cloneSubtree: no-op when sourcePrefix equals targetPrefix', () => {
    let stateChanges = 0;
    const store = createStore(
        { Counter: counterSection },
        { onStateChange: () => stateChanges++ }
    );
    init(store, 'Counter', '/tab1/counter');

    cloneYasmSubtree(store, '/tab1', '/tab1');
    assert.equal(stateChanges, 0);
});

test('cloneSubtree: triggers SYMBOL_NOTIFY_CHANGE and onStateChange', () => {
    let stateChanges = 0;
    const store = createStore(
        { Counter: counterSection },
        { onStateChange: () => stateChanges++ }
    );
    init(store, 'Counter', '/tab1/counter');

    cloneYasmSubtree(store, '/tab1', '/tab2');
    assert.equal(stateChanges, 1);
});

test('cloneSubtree: store.cloneSubtree is pre-bound to the store', () => {
    const store = createStore({ Counter: counterSection });
    init(store, 'Counter', '/tab1/counter');
    store.memo.Counter['/tab1/counter'].updater({ count: 5 });

    store.cloneSubtree('/tab1', '/tab2');

    assert.equal(store.state.Counter['/tab2/counter'].count, 5);
});

test('cloneSubtree: snapshots before writing so a nested target cannot loop', () => {
    const store = createStore({ Counter: counterSection });
    init(store, 'Counter', '/a/x');
    store.memo.Counter['/a/x'].updater({ count: 7 });

    // `targetPrefix` starts with `sourcePrefix` — the snapshot-first pass must
    // clone exactly the original entries and never its own fresh writes.
    cloneYasmSubtree(store, '/a', '/a/b');

    assert.deepEqual(Object.keys(store.state.Counter), ['/a/x', '/a/b/x']);
    assert.equal(store.state.Counter['/a/b/x'].count, 7);
    assert.equal(store.state.Counter['/a/b/b/x'], undefined);
});

test('cloneSubtree: match "startsWith" reproduces the legacy loose matching', () => {
    const store = createStore({ Counter: counterSection });
    init(store, 'Counter', '/tabs/1');
    init(store, 'Counter', '/tabs/10');
    store.memo.Counter['/tabs/1'].updater({ count: 1 });
    store.memo.Counter['/tabs/10'].updater({ count: 10 });

    cloneYasmSubtree(store, '/tabs/1', '/copy/1', {
        match: 'startsWith'
    });

    assert.equal(store.state.Counter['/copy/1'].count, 1);
    assert.equal(store.state.Counter['/copy/10'].count, 10);
});

test('cloneSubtree: isolates throwing subscribers at the target path', () => {
    const store = createStore({ Counter: counterSection });
    init(store, 'Counter', '/tab1/counter');
    store.memo.Counter['/tab1/counter'].updater({ count: 3 });

    const calls: string[] = [];
    store.subscribe(
        () => {
            calls.push('throwing');
            throw new Error('boom');
        },
        'Counter',
        '/tab2/counter'
    );
    store.subscribe(() => calls.push('healthy'), 'Counter', '/tab2/counter');

    const loggedErrors: unknown[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
        loggedErrors.push(args);
    };
    try {
        cloneYasmSubtree(store, '/tab1', '/tab2');
    } finally {
        console.error = originalError;
    }

    assert.deepEqual(calls, ['throwing', 'healthy']);
    assert.equal(loggedErrors.length, 1);
    assert.equal(store.state.Counter['/tab2/counter'].count, 3);
});

test('cloneSubtree: dev-frozen clone keeps nested references independent', () => {
    type Nested = { items: { label: string }[] };
    const nestedSection: Section<Nested, Partial<Nested>> = {
        initialState: { items: [] },
        updater: mergeUpdaterGenerator<Nested>()
    };

    const store = createStore({ Nested: nestedSection });
    init(store, 'Nested', '/doc/1');
    store.memo.Nested['/doc/1'].updater({
        items: [{ label: 'a' }, { label: 'b' }]
    });

    cloneYasmSubtree(store, '/doc/1', '/doc/2');

    const source = store.state.Nested['/doc/1'];
    const target = store.state.Nested['/doc/2'];

    assert.deepEqual(target, { items: [{ label: 'a' }, { label: 'b' }] });
    assert.notEqual(source, target);
    assert.notEqual(source.items, target.items);
    assert.notEqual(source.items[0], target.items[0]);

    if (process.env.NODE_ENV !== 'production') {
        // Cloned plain objects and arrays are deep-frozen in dev
        assert.equal(Object.isFrozen(target), true);
        assert.equal(Object.isFrozen(target.items), true);
    }
});

test('cloneSubtree: default cloning preserves native structured-clone types', () => {
    type State = {
        date: Date;
        map: Map<string, number>;
        set: Set<string>;
        regex: RegExp;
    };

    const section: Section<State, Partial<State>> = {
        initialState: {
            date: new Date(0),
            map: new Map(),
            set: new Set(),
            regex: /initial/g
        },
        updater: mergeUpdaterGenerator<State>()
    };

    const store = createStore({ State: section });

    init(store, 'State', '/source');

    // Replace the whole state entry directly — no Map/Set value is ever
    // routed through an Immer draft (which would require the MapSet plugin).
    store.state.State['/source'] = {
        date: new Date('2026-09-20T12:00:00.000Z'),
        map: new Map([['a', 1]]),
        set: new Set(['x', 'y']),
        regex: /hello/gi
    };

    cloneYasmSubtree(store, '/source', '/target');

    const source = store.state.State['/source'];
    const target = store.state.State['/target'];

    assert.ok(target.date instanceof Date);
    assert.equal(target.date.toISOString(), source.date.toISOString());

    assert.ok(target.map instanceof Map);
    assert.deepEqual(Array.from(target.map.entries()), [['a', 1]]);

    assert.ok(target.set instanceof Set);
    assert.deepEqual(Array.from(target.set.values()), ['x', 'y']);

    assert.ok(target.regex instanceof RegExp);
    assert.equal(target.regex.source, 'hello');
    assert.equal(target.regex.flags, 'gi');

    assert.notEqual(target.date, source.date);
    assert.notEqual(target.map, source.map);
    assert.notEqual(target.set, source.set);
    assert.notEqual(target.regex, source.regex);
});

test('cloneSubtree: throws instead of aliasing a value when both clone mechanisms fail', () => {
    type State = {
        value: {
            fn: () => void;
            self?: unknown;
        };
    };

    const section: Section<State, Partial<State>> = {
        initialState: {
            value: {
                fn: () => undefined
            }
        },
        updater: mergeUpdaterGenerator<State>()
    };

    const store = createStore({ State: section });

    const value: State['value'] = {
        fn: () => undefined
    };
    value.self = value;

    store.state.State['/source'] = { value };

    assert.throws(
        () => cloneYasmSubtree(store, '/source', '/target'),
        /cloneSubtree could not clone/
    );

    assert.equal(store.state.State['/target'], undefined);

    if (process.env.NODE_ENV !== 'production') {
        assert.equal(Object.isFrozen(value), false);
    }
});

test('cloneSubtree: transform failure leaves the entire target unchanged', () => {
    const store = createStore({ Counter: counterSection });

    init(store, 'Counter', '/source/a');
    init(store, 'Counter', '/source/b');
    init(store, 'Counter', '/target/a');
    init(store, 'Counter', '/target/b');

    // Initial state is deep-frozen in dev — seed through the updaters.
    store.memo.Counter['/source/a'].updater({ count: 1 });
    store.memo.Counter['/source/b'].updater({ count: 2 });
    store.memo.Counter['/target/a'].updater({ count: 10 });
    store.memo.Counter['/target/b'].updater({ count: 20 });

    let notified = 0;

    store.subscribe(
        () => {
            notified++;
        },
        'Counter',
        '/target/a'
    );

    assert.throws(
        () =>
            cloneYasmSubtree(store, '/source', '/target', {
                transform: (_sectionName, state, sourcePath) => {
                    if (sourcePath === '/source/b') {
                        throw new Error('transform failure');
                    }

                    return state;
                }
            }),
        /transform failure/
    );

    assert.equal(store.state.Counter['/target/a'].count, 10);
    assert.equal(store.state.Counter['/target/b'].count, 20);
    assert.equal(notified, 0);
});

test('cloneSubtree: subscribers observe the fully committed subtree before reentrant updates', () => {
    const store = createStore({ Counter: counterSection });

    init(store, 'Counter', '/source/a');
    init(store, 'Counter', '/source/b');
    init(store, 'Counter', '/target/a');
    init(store, 'Counter', '/target/b');

    store.memo.Counter['/source/a'].updater({ count: 1 });
    store.memo.Counter['/source/b'].updater({ count: 2 });

    store.memo.Counter['/target/a'].updater({ count: 10 });
    store.memo.Counter['/target/b'].updater({ count: 20 });

    const observed: number[] = [];
    let reentered = false;

    store.subscribe(
        () => {
            observed.push(store.state.Counter['/target/b'].count);

            if (!reentered) {
                reentered = true;
                store.memo.Counter['/target/b'].updater({ count: 99 });
            }
        },
        'Counter',
        '/target/a'
    );

    cloneYasmSubtree(store, '/source', '/target');

    assert.deepEqual(observed, [2]);
    assert.equal(store.state.Counter['/target/a'].count, 1);
    assert.equal(store.state.Counter['/target/b'].count, 99);
});

test('cloneSubtree: pre-mounted routed child rebinds after its target parent is registered', () => {
    const rowSection: Section<
        { title: string },
        Partial<{ title: string }>
    > = {
        initialState: { title: '' },
        updater: mergeUpdaterGenerator<{ title: string }>()
    };

    const store = createStore({
        Table: arraySectionGenerator('Row', rowSection),
        Row: rowSection
    });

    init(store, 'Table', '/source/table');

    store.memo.Table['/source/table'].updater({
        addingItems: [
            {
                id: 5,
                partialState: {
                    title: 'Item 5'
                }
            }
        ],
        order: [5]
    });

    // The child is initialized BEFORE the target parent exists.
    init(store, 'Row', '/target/table[5]');

    const childRecord = store.memo.Row['/target/table[5]'];

    const notifications: string[] = [];
    const unsubscribe = childRecord.subscribe(() => {
        notifications.push(childRecord.getState().title);
    });

    assert.equal(childRecord.getState().title, '');

    cloneYasmSubtree(store, '/source', '/target');

    assert.equal(childRecord.getState().title, 'Item 5');
    assert.deepEqual(notifications, ['Item 5']);
    assert.equal(store.state.Row['/target/table[5]'], undefined);

    unsubscribe();
});

test('cloneSubtree: omitSections does not create dangling descendant routing registrations', () => {
    const profileSection: Section<
        { name: string },
        Partial<{ name: string }>
    > = {
        initialState: { name: '' },
        updater: mergeUpdaterGenerator<{ name: string }>()
    };

    const rowForm = objectSectionGenerator({
        profile: {
            name: 'Profile',
            state: profileSection.initialState,
            updater: profileSection.updater
        }
    });

    const store = createStore({
        Table: arraySectionGenerator('Row', rowForm),
        Row: rowForm,
        Profile: profileSection
    });

    init(store, 'Table', '/source/table');

    store.memo.Table['/source/table'].updater({
        addingItems: [
            {
                id: 5,
                partialState: {
                    profile: {
                        name: 'Sara'
                    }
                }
            }
        ],
        order: [5]
    });

    init(store, 'Row', '/source/table[5]');

    cloneYasmSubtree(store, '/source', '/target', {
        omitSections: ['Table']
    });

    assert.equal(store.state.Table['/target/table'], undefined);
    assert.equal(
        store.pathRegistry.Table.includes('/target/table'),
        false
    );
    assert.equal(
        store.pathRegistry.Row.includes('/target/table[5]'),
        false
    );

    init(store, 'Profile', '/target/table[5][profile]');

    assert.doesNotThrow(() => {
        store.memo.Profile['/target/table[5][profile]'].getState();
    });

    assert.equal(
        store.state.Profile['/target/table[5][profile]'].name,
        ''
    );
});

test('cloneSubtree: startsWith mode uses the raw source prefix', () => {
    const store = createStore({ Counter: counterSection });

    init(store, 'Counter', '/tabs/1/child');
    init(store, 'Counter', '/tabs/10');

    store.memo.Counter['/tabs/1/child'].updater({ count: 1 });
    store.memo.Counter['/tabs/10'].updater({ count: 10 });

    cloneYasmSubtree(store, '/tabs/1/', '/copy', {
        match: 'startsWith'
    });

    assert.equal(store.state.Counter['/copy/child'].count, 1);
    assert.equal(store.state.Counter['/copy0'], undefined);
});

test('cloneSubtree: target root prefix clones the exact source path to root', () => {
    const store = createStore({ Counter: counterSection });

    init(store, 'Counter', '/source');
    store.memo.Counter['/source'].updater({ count: 7 });

    cloneYasmSubtree(store, '/source', '/');

    assert.equal(store.state.Counter['/'].count, 7);
    assert.equal(store.state.Counter['']?.count, undefined);
});

test('cloneSubtree: source root prefix clones the exact root entry and descendants to the target prefix', () => {
    const store = createStore({ Counter: counterSection });

    init(store, 'Counter', '/');
    init(store, 'Counter', '/child');

    store.memo.Counter['/'].updater({ count: 1 });
    store.memo.Counter['/child'].updater({ count: 2 });

    cloneYasmSubtree(store, '/', '/copy');

    assert.equal(store.state.Counter['/copy'].count, 1);
    assert.equal(store.state.Counter['/copy/child'].count, 2);
    assert.equal(store.state.Counter['/copy/']?.count, undefined);
    assert.equal(store.state.Counter['/copy//child']?.count, undefined);
});
