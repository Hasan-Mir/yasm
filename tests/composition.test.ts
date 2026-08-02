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
