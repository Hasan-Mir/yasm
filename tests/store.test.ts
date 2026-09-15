import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init } from '../src/useYasmState';
import { purgeYasmState } from '../src/purge';
import { Section, createStore } from '../src/createStore';
import { counterSection, captureWarnings } from './helpers';

const makeStore = () => createStore({ Counter: counterSection });

test('createStore initializes empty state/subscribers/memo per section', () => {
    const store = makeStore();
    assert.deepEqual(store.state, { Counter: {} });
    assert.deepEqual(store.subscribers, { Counter: {} });
    assert.deepEqual(store.memo, { Counter: {} });
    // no routing sections -> empty path registry
    assert.deepEqual(store.pathRegistry, {});
});

test('init creates initial state and updater merges the payload', () => {
    const store = makeStore();
    init(store, 'Counter', '/a');
    assert.deepEqual(store.state.Counter['/a'], { count: 0, label: '' });

    const record = store.memo.Counter['/a'];
    record.updater({ count: 5 });
    assert.deepEqual(store.state.Counter['/a'], { count: 5, label: '' });
    assert.equal(record.getState().count, 5);
});

test('init is memoized: same record is returned for the same (name, path)', () => {
    const store = makeStore();
    const first = init(store, 'Counter', '/a');
    const second = init(store, 'Counter', '/a');
    assert.equal(first, second);
});

test('updater accepts a payload-creator function', () => {
    const store = makeStore();
    init(store, 'Counter', '/a');
    const record = store.memo.Counter['/a'];
    record.updater({ count: 10 });
    record.updater(state => ({ count: state.count + 1 }));
    assert.equal(store.state.Counter['/a'].count, 11);
});

test('overrideInitialState works in object and function forms', () => {
    const store = makeStore();
    init(store, 'Counter', '/a', { count: 42 });
    assert.equal(store.state.Counter['/a'].count, 42);
    assert.equal(store.state.Counter['/a'].label, '');

    const store2 = makeStore();
    init(store2, 'Counter', '/b', initialState => ({
        count: initialState.count + 1
    }));
    assert.equal(store2.state.Counter['/b'].count, 1);
});

test('overrideInitialState preserves array prototypes', () => {
    type Todo = { id: number; text: string };
    const listSection: Section<Todo[], { add: Todo }> = {
        initialState: [],
        updater: (draft, { add }) => {
            draft.push(add);
        }
    };

    const store = createStore({ Todos: listSection });
    init(store, 'Todos', '/list', [{ id: 1, text: 'First' }] as never);

    assert.ok(Array.isArray(store.state.Todos['/list']));
    assert.doesNotThrow(() => {
        store.memo.Todos['/list'].updater({ add: { id: 2, text: 'Second' } });
    });
    assert.equal(store.state.Todos['/list'].length, 2);
});

test('subscribers are notified on update; unsubscribe stops notifications', () => {
    const store = makeStore();
    init(store, 'Counter', '/a');
    const record = store.memo.Counter['/a'];

    let notified = 0;
    const unsubscribe = record.subscribe(() => notified++);
    record.updater({ count: 1 });
    assert.equal(notified, 1);

    unsubscribe();
    record.updater({ count: 2 });
    assert.equal(notified, 1);
});

test('subscribing to an unknown section throws a helpful error', () => {
    const store = makeStore();
    assert.throws(
        () => store.subscribe(() => undefined, 'Ghost' as never, '/a'),
        /unknown section "Ghost"/
    );
});

test('init on an unknown section throws a helpful error', () => {
    const store = makeStore();
    assert.throws(
        () => init(store, 'Ghost' as never, '/a'),
        /unknown section "Ghost"/
    );
});

test('updater is a safe no-op after the state was purged (async safety)', async () => {
    const store = makeStore();
    init(store, 'Counter', '/a');
    const record = store.memo.Counter['/a'];

    await captureWarnings(() => purgeYasmState(store, '/a'));

    assert.doesNotThrow(() => record.updater({ count: 9 }));
    assert.equal(store.state.Counter['/a'], undefined);
});

test('unsubscribe after purge is silent (no warning, no crash)', async () => {
    const store = makeStore();
    init(store, 'Counter', '/a');
    const record = store.memo.Counter['/a'];
    const unsubscribe = record.subscribe(() => undefined);

    // purge-time warning is expected here (subscriber still attached) and
    // captured separately
    await captureWarnings(() => purgeYasmState(store, '/a'));

    const warnings = await captureWarnings(() => unsubscribe());
    assert.deepEqual(warnings, []);
});

test('re-init after purge starts from a fresh initial state', async () => {
    const store = makeStore();
    init(store, 'Counter', '/a');
    store.memo.Counter['/a'].updater({ count: 100 });
    await captureWarnings(() => purgeYasmState(store, '/a'));

    init(store, 'Counter', '/a');
    assert.deepEqual(store.state.Counter['/a'], { count: 0, label: '' });
});
