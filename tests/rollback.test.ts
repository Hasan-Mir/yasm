import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init } from '../src/useYasmState';
import { purgeYasmState } from '../src/purge';
import { captureWarnings } from './helpers';
import { Section, createStore } from '../src/createStore';
import { arraySectionGenerator, mergeUpdaterGenerator } from '../src/util';

type CounterState = { count: number; label: string };
const counterSection: Section<CounterState, Partial<CounterState>> = {
    initialState: { count: 0, label: '' },
    updater: mergeUpdaterGenerator<CounterState>()
};

type NoteState = { text: string };
const noteSection: Section<NoteState, Partial<NoteState>> = {
    initialState: { text: '' },
    updater: mergeUpdaterGenerator<NoteState>()
};

type Row = { title: string; done: boolean };
const rowSection: Section<Row, Partial<Row>> = {
    initialState: { title: '', done: false },
    updater: mergeUpdaterGenerator<Row>()
};

const makeTableStore = () =>
    createStore({
        Table: arraySectionGenerator('Row', rowSection),
        Row: rowSection
    });

test('rollback: single-path restores the captured value on a later update', () => {
    const store = createStore({ Counter: counterSection });
    init(store, 'Counter', '/a');
    const record = store.memo.Counter['/a'];
    record.updater({ count: 1, label: 'one' });

    const rollback = store.captureRollback('Counter', '/a');

    record.updater({ count: 2, label: 'two' });
    assert.equal(store.state.Counter['/a'].count, 2);

    rollback();
    assert.deepEqual(store.state.Counter['/a'], { count: 1, label: 'one' });
});

test('rollback: is a no-op (reference equality) when nothing changed since capture', () => {
    let changes = 0;
    const store = createStore(
        { Counter: counterSection },
        { onStateChange: () => changes++ }
    );
    init(store, 'Counter', '/a');
    const record = store.memo.Counter['/a'];
    record.updater({ count: 5 });
    assert.equal(changes, 1);

    const rollback = store.captureRollback('Counter', '/a');
    const before = store.state.Counter['/a'];

    rollback();

    assert.equal(store.state.Counter['/a'], before);
    assert.equal(changes, 1, 'an unchanged rollback must not notify');
});

test('rollback: is idempotent — the second call never re-mutates', () => {
    let changes = 0;
    const store = createStore(
        { Counter: counterSection },
        { onStateChange: () => changes++ }
    );
    init(store, 'Counter', '/a');
    const record = store.memo.Counter['/a'];
    record.updater({ count: 1 });
    assert.equal(changes, 1);

    const rollback = store.captureRollback('Counter', '/a');

    record.updater({ count: 2 });
    assert.equal(changes, 2);

    rollback();
    assert.equal(changes, 3);
    const restored = store.state.Counter['/a'];
    assert.deepEqual(restored, { count: 1, label: '' });

    rollback();
    assert.equal(
        store.state.Counter['/a'],
        restored,
        'second rollback keeps the restored reference'
    );
    assert.equal(changes, 3);
});

test('rollback: routed child restores through its ArraySection parent', () => {
    const store = makeTableStore();
    init(store, 'Table', '/t');
    store.memo.Table['/t'].updater({
        addingItems: [{ id: 3, partialState: { title: 'row3' } }],
        order: [3]
    });
    init(store, 'Row', '/t[3]');
    const row = store.memo.Row['/t[3]'];

    const rollback = store.captureRollback('Row', '/t[3]');

    row.updater({ title: 'edited', done: true });
    assert.equal(store.state.Table['/t'].map[3].title, 'edited');

    rollback();

    assert.equal(store.state.Table['/t'].map[3].title, 'row3');
    assert.equal(store.state.Table['/t'].map[3].done, false);
});

test('rollback: routed child safely ignores a row removed after capture', () => {
    const store = makeTableStore();
    init(store, 'Table', '/t');
    const table = store.memo.Table['/t'];
    table.updater({ addingItems: [{ id: 3 }], order: [3] });
    init(store, 'Row', '/t[3]');

    const rollback = store.captureRollback('Row', '/t[3]');

    table.updater({ removingIDs: [3], order: [] });
    assert.equal(store.state.Table['/t'].map[3], undefined);

    assert.doesNotThrow(() => rollback());
    assert.equal(
        store.state.Table['/t'].map[3],
        undefined,
        'rollback must never resurrect a removed routed element'
    );
});

test('rollback: a path that never existed captures the section baseline', () => {
    const store = createStore({ Counter: counterSection });
    const rollback = store.captureRollback('Counter', '/ghost');

    // `init` lazily initialized the path to the baseline.
    assert.deepEqual(store.state.Counter['/ghost'], { count: 0, label: '' });

    assert.doesNotThrow(() => rollback());
    assert.deepEqual(store.state.Counter['/ghost'], { count: 0, label: '' });
});

test('rollback: path-prefix restores every captured section/path at once', () => {
    const store = createStore({ Counter: counterSection, Note: noteSection });
    init(store, 'Counter', '/tabs/1');
    store.memo.Counter['/tabs/1'].updater({ count: 1 });
    init(store, 'Note', '/tabs/2');
    store.memo.Note['/tabs/2'].updater({ text: 'two' });
    init(store, 'Counter', '/other');
    store.memo.Counter['/other'].updater({ count: 9 });

    const rollback = store.captureRollback('/tabs');

    store.memo.Counter['/tabs/1'].updater({ count: 42 });
    store.memo.Note['/tabs/2'].updater({ text: 'changed' });

    rollback();

    assert.deepEqual(store.state.Counter['/tabs/1'], { count: 1, label: '' });
    assert.deepEqual(store.state.Note['/tabs/2'], { text: 'two' });
    // Paths outside the prefix are untouched.
    assert.deepEqual(store.state.Counter['/other'], { count: 9, label: '' });
});

test('rollback: path-prefix captures the generic global prefix too', () => {
    const store = createStore({ Counter: counterSection });
    init(store, 'Counter', '/a');
    init(store, 'Counter', '/b');
    store.memo.Counter['/a'].updater({ count: 1 });
    store.memo.Counter['/b'].updater({ count: 2 });

    const rollback = store.captureRollback('/');

    store.memo.Counter['/a'].updater({ count: 10 });
    store.memo.Counter['/b'].updater({ count: 20 });

    rollback();

    assert.equal(store.state.Counter['/a'].count, 1);
    assert.equal(store.state.Counter['/b'].count, 2);
});

test('rollback: path-prefix safely ignores paths purged after capture', async () => {
    const store = createStore({ Counter: counterSection, Note: noteSection });
    init(store, 'Counter', '/tabs/1');
    store.memo.Counter['/tabs/1'].updater({ count: 1 });
    init(store, 'Note', '/tabs/2');
    store.memo.Note['/tabs/2'].updater({ text: 'two' });

    const rollback = store.captureRollback('/tabs');

    store.memo.Counter['/tabs/1'].updater({ count: 42 });
    await captureWarnings(() => purgeYasmState(store, '/tabs/2'));

    rollback();

    // Restored path is rolled back…
    assert.deepEqual(store.state.Counter['/tabs/1'], { count: 1, label: '' });
    // …but the purged path is not resurrected.
    assert.equal(store.state.Note['/tabs/2'], undefined);
});

test('rollback: path-prefix restores a routed parent (ArraySection) physically', () => {
    const store = makeTableStore();
    init(store, 'Table', '/t');
    store.memo.Table['/t'].updater({
        addingItems: [{ id: 3, partialState: { title: 'keep' } }],
        order: [3]
    });

    const rollback = store.captureRollback('/t');

    init(store, 'Row', '/t[3]');
    store.memo.Row['/t[3]'].updater({ title: 'edited' });
    assert.equal(store.state.Table['/t'].map[3].title, 'edited');

    rollback();
    assert.equal(store.state.Table['/t'].map[3].title, 'keep');
});

test('rollback: capture does not mutate and the captured value is immutable', () => {
    const store = createStore({ Counter: counterSection });
    init(store, 'Counter', '/a');
    const record = store.memo.Counter['/a'];
    record.updater({ count: 1 });

    const before = store.state.Counter['/a'];
    const rollback = store.captureRollback('Counter', '/a');

    // Capturing must leave the store untouched.
    assert.equal(store.state.Counter['/a'], before);

    record.updater({ count: 2 });
    rollback();
    assert.deepEqual(store.state.Counter['/a'], { count: 1, label: '' });
});

test('rollback: routed child with command-based updater restores captured state cleanly', () => {
    type TodoItem = { text: string; completed: boolean };
    type TodoAction = { type: 'TOGGLE' } | { type: 'SET_TEXT'; text: string };

    const todoItemSection: Section<TodoItem, TodoAction> = {
        initialState: { text: '', completed: false },
        updater: (draft, action) => {
            if (action.type === 'TOGGLE') {
                draft.completed = !draft.completed;
            } else if (action.type === 'SET_TEXT') {
                draft.text = action.text;
            }
        }
    };

    const store = createStore({
        TodoList: arraySectionGenerator('TodoItem', todoItemSection),
        TodoItem: todoItemSection
    });

    init(store, 'TodoList', '/todos');
    store.memo.TodoList['/todos'].updater({
        addingItems: [{ id: 1, partialState: { text: 'Initial', completed: false } }],
        order: [1]
    });

    init(store, 'TodoItem', '/todos[1]');
    const itemRecord = store.memo.TodoItem['/todos[1]'];

    const rollback = store.captureRollback('TodoItem', '/todos[1]');

    itemRecord.updater({ type: 'TOGGLE' });
    itemRecord.updater({ type: 'SET_TEXT', text: 'Mutated' });
    assert.equal(store.state.TodoList['/todos'].map[1].completed, true);
    assert.equal(store.state.TodoList['/todos'].map[1].text, 'Mutated');

    rollback();

    assert.equal(store.state.TodoList['/todos'].map[1].completed, false);
    assert.equal(store.state.TodoList['/todos'].map[1].text, 'Initial');
});
