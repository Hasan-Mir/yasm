import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init } from '../src/useYasmState';
import { purgeYasmState } from '../src/purge';
import { captureWarnings } from './helpers';
import { Section, createStore } from '../src/createStore';
import {
    arraySectionGenerator,
    extractArrayIndexAndRemainedPathQuery,
    immer,
    mergeUpdaterGenerator,
    objectSectionGenerator
} from '../src/util';

type Row = { title: string; done: boolean };
const rowSection: Section<Row, Partial<Row>> = {
    initialState: { title: '', done: false },
    updater: mergeUpdaterGenerator<Row>()
};

const makeStore = () =>
    createStore({
        Table: arraySectionGenerator('Row', rowSection),
        Row: rowSection
    });

test('ArraySection: add, edit, remove and order', () => {
    const store = makeStore();
    init(store, 'Table', '/t');
    const table = store.memo.Table['/t'];

    table.updater({
        addingItems: [{ id: 1 }, { id: 2, partialState: { title: 'second' } }],
        order: [1, 2]
    });
    assert.deepEqual(store.state.Table['/t'].order, [1, 2]);
    assert.deepEqual(store.state.Table['/t'].map[1], {
        title: '',
        done: false
    });
    assert.deepEqual(store.state.Table['/t'].map[2], {
        title: 'second',
        done: false
    });

    table.updater({ editingItems: [{ id: 1, itemPayload: { done: true } }] });
    assert.equal(store.state.Table['/t'].map[1].done, true);

    table.updater({ removingIDs: [1], order: [2] });
    assert.equal(store.state.Table['/t'].map[1], undefined);
    assert.deepEqual(store.state.Table['/t'].order, [2]);
});

test('ArraySection: adding and editing the same item in one payload works', () => {
    // Used to fail before the fix: edits were applied before additions.
    const store = makeStore();
    init(store, 'Table', '/t');
    const table = store.memo.Table['/t'];

    table.updater({
        addingItems: [{ id: 7 }],
        editingItems: [{ id: 7, itemPayload: { title: 'seven' } }]
    });
    assert.equal(store.state.Table['/t'].map[7].title, 'seven');
});

test('ArraySection: editing a missing id warns (dev) and is skipped', async () => {
    const store = makeStore();
    init(store, 'Table', '/t');
    const table = store.memo.Table['/t'];

    const warnings = await captureWarnings(() =>
        table.updater({
            editingItems: [{ id: 99, itemPayload: { title: 'x' } }]
        })
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /id "99"/);
    assert.equal(store.state.Table['/t'].map[99], undefined);
});

test('routed child: read and update through the parent ArraySection', () => {
    const store = makeStore();
    init(store, 'Table', '/t');
    store.memo.Table['/t'].updater({
        addingItems: [{ id: 3, partialState: { title: 'row3' } }],
        order: [3]
    });

    init(store, 'Row', '/t[3]');
    const row = store.memo.Row['/t[3]'];
    assert.equal(row.getState().title, 'row3');

    // the routed child does NOT create its own storage
    assert.equal(store.state.Row['/t[3]'], undefined);

    // parent subscribers are notified when the child updates
    let notified = 0;
    store.memo.Table['/t'].subscribe(() => notified++);

    const before = store.state.Table['/t'];
    row.updater({ title: 'updated' });
    assert.equal(store.state.Table['/t'].map[3].title, 'updated');
    assert.equal(notified, 1);
    // immutability: the parent reference changed
    assert.notEqual(store.state.Table['/t'], before);
});

test('routing uses segment-aware matching (no "/t" vs "/t2" hijacking)', () => {
    const store = makeStore();
    init(store, 'Table', '/t');

    // "/t2" starts with "/t" but is a different segment; it must NOT be
    // routed into the Table registered at "/t".
    init(store, 'Row', '/t2');
    assert.notEqual(store.state.Row['/t2'], undefined);
});

test('routed child updater is a safe no-op after the row was removed', () => {
    const store = makeStore();
    init(store, 'Table', '/t');
    store.memo.Table['/t'].updater({ addingItems: [{ id: 3 }], order: [3] });
    init(store, 'Row', '/t[3]');
    const row = store.memo.Row['/t[3]'];

    store.memo.Table['/t'].updater({ removingIDs: [3], order: [] });

    assert.doesNotThrow(() => row.updater({ title: 'ghost write' }));
    assert.equal(store.state.Table['/t'].map[3], undefined);
});

test('purge cleans the path registry of routed sections', async () => {
    const store = makeStore();
    init(store, 'Table', '/t');
    assert.deepEqual(store.pathRegistry.Table, ['/t']);

    await captureWarnings(() => purgeYasmState(store, '/t'));
    assert.deepEqual(store.pathRegistry.Table, []);

    // re-init after purge registers the path again exactly once
    init(store, 'Table', '/t');
    assert.deepEqual(store.pathRegistry.Table, ['/t']);
});

test('extractArrayIndexAndRemainedPathQuery validates its input', () => {
    assert.deepEqual(extractArrayIndexAndRemainedPathQuery('[5]/rest'), [
        5,
        '/rest'
    ]);
    assert.deepEqual(extractArrayIndexAndRemainedPathQuery('[0]'), [0, '']);
    // all invalid inputs return an error string instead of a tuple
    assert.equal(typeof extractArrayIndexAndRemainedPathQuery('[]'), 'string'); // used to parse as index 0!
    assert.equal(
        typeof extractArrayIndexAndRemainedPathQuery('[abc]'),
        'string'
    );
    assert.equal(
        typeof extractArrayIndexAndRemainedPathQuery('[-1]'),
        'string'
    );
    assert.equal(
        typeof extractArrayIndexAndRemainedPathQuery('[1.5]'),
        'string'
    );
    assert.equal(
        typeof extractArrayIndexAndRemainedPathQuery('nope'),
        'string'
    );
});

test('ObjectSection composes named sections', () => {
    const composed = objectSectionGenerator({
        counter: {
            name: 'Counter',
            state: { count: 0 },
            updater: mergeUpdaterGenerator<{ count: number }>()
        },
        flag: {
            name: 'Flag',
            state: { on: false },
            updater: mergeUpdaterGenerator<{ on: boolean }>()
        }
    });

    assert.deepEqual(composed.initialState, {
        counter: { count: 0 },
        flag: { on: false }
    });

    const next = immer.produce(composed.initialState, (draft: any) =>
        composed.updater(draft, { counter: { count: 2 } })
    );
    assert.equal(next.counter.count, 2);
    assert.equal(next.flag.on, false);
});

test('multi-level composition routes through nested parents', () => {
    const profileSection: Section<{ name: string }, { name?: string }> = {
        initialState: { name: '' },
        updater: mergeUpdaterGenerator<{ name: string }>()
    };
    const settingsSection: Section<
        { compact: boolean },
        { compact?: boolean }
    > = {
        initialState: { compact: false },
        updater: mergeUpdaterGenerator<{ compact: boolean }>()
    };
    const rowForm = objectSectionGenerator({
        profile: {
            name: 'Profile',
            state: profileSection.initialState,
            updater: profileSection.updater
        },
        settings: {
            name: 'Settings',
            state: settingsSection.initialState,
            updater: settingsSection.updater
        }
    });
    const store = createStore({
        Table: arraySectionGenerator('Row', rowForm),
        Row: rowForm,
        Profile: profileSection,
        Settings: settingsSection
    });

    init(store, 'Table', '/table');
    store.memo.Table['/table'].updater({
        addingItems: [{ id: 5, partialState: { profile: { name: 'Sara' } } }],
        order: [5]
    });

    // Register the intermediate row path, then route two levels deep
    init(store, 'Row', '/table[5]');
    // Regression lock: the routed intermediate parent MUST register its
    // path — this is exactly what used to break multi-level composition.
    assert.deepEqual(store.pathRegistry.Row, ['/table[5]']);
    init(store, 'Profile', '/table[5][profile]');

    const profile = store.memo.Profile['/table[5][profile]'];
    assert.equal(profile.getState().name, 'Sara');

    profile.updater({ name: 'Updated' });
    assert.equal(store.state.Table['/table'].map[5].profile.name, 'Updated');

    // The routed leaf never creates its own storage
    assert.equal(store.state.Profile['/table[5][profile]'], undefined);
});

test('a child used before its parent falls back to direct storage', () => {
    const store = makeStore();

    // No Table hook at '/t' yet: routing cannot resolve a registered parent,
    // so the child state is stored directly instead of inside the parent.
    init(store, 'Row', '/t[3]');
    assert.notEqual(store.state.Row['/t[3]'], undefined);

    // Once the parent path is registered, new child hooks route through it
    init(store, 'Table', '/t');
    init(store, 'Row', '/t[9]');
    assert.equal(store.state.Row['/t[9]'], undefined);
});

test('ArraySection: removing and editing the same id in one payload skips the edit', async () => {
    const store = makeStore();
    init(store, 'Table', '/t');
    store.memo.Table['/t'].updater({ addingItems: [{ id: 4 }], order: [4] });

    // Removals run before edits, so the edit targets an already-removed row
    const warnings = await captureWarnings(() =>
        store.memo.Table['/t'].updater({
            removingIDs: [4],
            editingItems: [{ id: 4, itemPayload: { title: 'zombie' } }]
        })
    );

    assert.equal(store.state.Table['/t'].map[4], undefined);
    assert.equal(warnings.length, 1, 'the skipped edit must warn in dev');
});

test('two ArraySection instances at different paths are fully isolated', () => {
    const store = makeStore();
    init(store, 'Table', '/tabs/1/users');
    init(store, 'Table', '/tabs/2/users');

    store.memo.Table['/tabs/1/users'].updater({
        addingItems: [{ id: 1, partialState: { title: 't1' } }],
        order: [1]
    });
    store.memo.Table['/tabs/2/users'].updater({
        addingItems: [{ id: 1, partialState: { title: 't2' } }],
        order: [1]
    });

    assert.equal(store.state.Table['/tabs/1/users'].map[1].title, 't1');
    assert.equal(store.state.Table['/tabs/2/users'].map[1].title, 't2');
});

test('custom routers compose sections with their own path syntax', () => {
    type Entry = { label: string };
    const entrySection: Section<Entry, Partial<Entry>> = {
        initialState: { label: '' },
        updater: mergeUpdaterGenerator<Entry>()
    };
    const dictionarySection: Section<
        Record<string, Entry>,
        Record<string, Partial<Entry>>
    > = {
        initialState: {},
        updater: (state, payload) => {
            for (const key in payload) {
                state[key] = { ...state[key], ...payload[key] };
            }
        },
        routing: {
            Entry: {
                // pathQuery is the part after the registered parent path,
                // e.g. '.user1' for init(store, 'Entry', '/dict.user1')
                selectByPathQuery: (state, pathQuery) => {
                    const key = pathQuery.slice(1); // strip the leading '.'
                    if (state[key] === undefined) {
                        throw new Error(
                            `YASM: unknown dictionary key "${key}".`
                        );
                    }
                    return [state[key], ''];
                },
                updateByPathQuery: (state, pathQuery, getEntryState) => {
                    const key = pathQuery.slice(1);
                    const newEntry = getEntryState(state[key], '');

                    // No-op bailout: an unchanged child keeps the parent ref
                    if (newEntry === state[key]) {
                        return state;
                    }

                    return { ...state, [key]: newEntry };
                }
            }
        }
    };

    const store = createStore({ Dict: dictionarySection, Entry: entrySection });
    init(store, 'Dict', '/dict');
    store.memo.Dict['/dict'].updater({ user1: { label: 'first' } });

    // '.' is a default boundary char, so '/dict.user1' routes through the
    // custom router instead of bracket syntax.
    init(store, 'Entry', '/dict.user1');
    const entry = store.memo.Entry['/dict.user1'];
    assert.equal(entry.getState().label, 'first');
    assert.equal(store.state.Entry['/dict.user1'], undefined);

    const before = store.state.Dict['/dict'];
    entry.updater({ label: 'updated' });
    assert.equal(store.state.Dict['/dict'].user1.label, 'updated');
    assert.notEqual(store.state.Dict['/dict'], before);

    // A no-op child update preserves the parent reference entirely
    const refBeforeNoop = store.state.Dict['/dict'];
    entry.updater({ label: 'updated' });
    assert.equal(store.state.Dict['/dict'], refBeforeNoop);
});

test('routed child reader does not throw when its backing element is removed', () => {
    const store = makeStore();
    init(store, 'Table', '/t');
    store.memo.Table['/t'].updater({ addingItems: [{ id: 3 }], order: [3] });
    init(store, 'Row', '/t[3]');
    const row = store.memo.Row['/t[3]'];

    // Reader resolves normally before the removal
    assert.deepEqual(row.getState(), { title: '', done: false });

    store.memo.Table['/t'].updater({ removingIDs: [3], order: [] });

    // The updater is a guarded no-op; the reader must be lifecycle-safe too:
    // it returns the LAST KNOWN value (stable reference, safe under uSES)
    // instead of throwing during a render-phase getSnapshot call.
    let result: unknown;
    assert.doesNotThrow(() => {
        result = row.getState();
    });
    assert.deepEqual(result, { title: '', done: false });

    // A reader that NEVER resolved successfully keeps the historical
    // fail-fast behavior: genuine routing misconfigurations must surface
    // instead of being masked by a silent default.
    const store2 = makeStore();
    init(store2, 'Table', '/t');
    init(store2, 'Row', '/t[7]'); // never initialized inside the parent
    assert.throws(() => store2.memo.Row['/t[7]'].getState());
});

test('a throwing subscriber on one path does not block sibling notifications', () => {
    const store = makeStore();
    init(store, 'Table', '/t');

    const seen: string[] = [];
    const unsubBad = store.subscribe(() => {
        throw new Error('boom');
    }, 'Table', '/t');
    const unsubGood = store.subscribe(() => {
        seen.push('ok');
    }, 'Table', '/t');

    // Must not throw out of the update fan-out...
    assert.doesNotThrow(() =>
        store.memo.Table['/t'].updater({ addingItems: [{ id: 1 }] })
    );
    // ...and the healthy subscriber must still have been notified.
    assert.deepEqual(seen, ['ok']);

    unsubBad();
    unsubGood();
});
