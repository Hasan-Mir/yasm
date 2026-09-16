import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init } from '../src/useYasmState';
import {
    type Section,
    type SubscribeManyChange,
    createStore
} from '../src/createStore';
import { arraySectionGenerator, mergeUpdaterGenerator } from '../src/util';
import { counterSection, captureConsole, type CounterState } from './helpers';

type Row = { title: string; done: boolean };
const rowSection: Section<Row, Partial<Row>> = {
    initialState: { title: '', done: false },
    updater: mergeUpdaterGenerator<Row>()
};

// A primitive-valued section: a reverted value is reference-identical
// (Object.is) to the last delivered value, which is the exact condition
// `subscribeMany` uses to drop changes reverted within one flush.
type NumState = number;
const numberSection: Section<NumState, NumState> = {
    initialState: 0,
    updater: (_state, payload) => payload
};

type CounterSM = { Counter: typeof counterSection };
type CounterChange = SubscribeManyChange<CounterSM>;

const makeStore = () => createStore({ Counter: counterSection });

// `subscribeMany` batches on queueMicrotask; one macrotask boundary
// guarantees every pending microtask flush has executed.
const flushMicrotasks = () =>
    new Promise<void>(resolve => setTimeout(resolve, 0));

test('subscribeMany: coalesces one synchronous flush into a single call, newest value per address', async () => {
    const store = makeStore();
    init(store, 'Counter', '/a');
    init(store, 'Counter', '/b');

    const calls: CounterChange[][] = [];
    const unsubscribe = store.subscribeMany(
        [
            { name: 'Counter', path: '/a' },
            { name: 'Counter', path: '/b' }
        ],
        changes => calls.push(changes)
    );

    store.memo.Counter['/a'].updater({ count: 1 });
    store.memo.Counter['/a'].updater({ count: 2 });
    store.memo.Counter['/b'].updater({ count: 10 });

    assert.equal(
        calls.length,
        0,
        'microtask batching must not deliver synchronously'
    );
    await flushMicrotasks();

    assert.equal(calls.length, 1, 'one coalesced delivery for the whole flush');
    assert.equal(calls[0].length, 2, 'at most one entry per address');

    const aChange = calls[0].find(change => change.path === '/a');
    const bChange = calls[0].find(change => change.path === '/b');
    assert.equal(aChange?.current.count, 2, 'newest value wins');
    assert.equal(aChange?.previous?.count, 0);
    assert.equal(bChange?.current.count, 10);
    assert.equal(bChange?.previous?.count, 0);
    unsubscribe();
});

test('subscribeMany: previous reflects the last delivered value across separate flushes', async () => {
    const store = makeStore();
    init(store, 'Counter', '/a');

    const calls: CounterChange[][] = [];
    const unsubscribe = store.subscribeMany(
        [{ name: 'Counter', path: '/a' }],
        changes => calls.push(changes)
    );

    store.memo.Counter['/a'].updater({ count: 1 });
    await flushMicrotasks();
    store.memo.Counter['/a'].updater({ count: 2 });
    await flushMicrotasks();

    assert.equal(calls.length, 2);
    assert.equal(calls[0][0].previous?.count, 0);
    assert.equal(calls[0][0].current.count, 1);
    assert.equal(calls[1][0].previous?.count, 1);
    assert.equal(calls[1][0].current.count, 2);
    unsubscribe();
});

test('subscribeMany: a change reverted within the same flush is dropped entirely', async () => {
    const store = createStore({ Num: numberSection });

    const calls: SubscribeManyChange<{ Num: typeof numberSection }>[][] = [];
    const unsubscribe = store.subscribeMany(
        [{ name: 'Num', path: '/n' }],
        changes => calls.push(changes)
    );

    store.memo.Num['/n'].updater(5);
    store.memo.Num['/n'].updater(0); // revert to the initial value

    await flushMicrotasks();
    assert.equal(
        calls.length,
        0,
        'a reverted change must be dropped entirely'
    );
    unsubscribe();
});

test('subscribeMany: batch "sync" delivers inline single-entry batches', () => {
    const store = makeStore();
    init(store, 'Counter', '/a');

    const calls: CounterChange[][] = [];
    const unsubscribe = store.subscribeMany(
        [{ name: 'Counter', path: '/a' }],
        changes => calls.push(changes),
        { batch: 'sync' }
    );

    store.memo.Counter['/a'].updater({ count: 1 });
    store.memo.Counter['/a'].updater({ count: 2 });

    assert.equal(calls.length, 2, 'sync batching delivers immediately');
    assert.equal(calls[0].length, 1);
    assert.equal(calls[0][0].current.count, 1);
    assert.equal(calls[1][0].current.count, 2);
    assert.equal(calls[1][0].previous?.count, 1);
    unsubscribe();
});

test('subscribeMany: fireImmediately reports every target once with previous undefined', () => {
    const store = makeStore();
    init(store, 'Counter', '/a');
    init(store, 'Counter', '/b');

    const calls: CounterChange[][] = [];
    const unsubscribe = store.subscribeMany(
        [
            { name: 'Counter', path: '/a' },
            { name: 'Counter', path: '/b' }
        ],
        changes => calls.push(changes),
        { fireImmediately: true }
    );

    assert.equal(
        calls.length,
        1,
        'one synchronous delivery at subscription time'
    );
    assert.equal(calls[0].length, 2, 'one entry per target');
    for (const change of calls[0]) {
        assert.equal(change.previous, undefined);
        assert.deepEqual(
            change.current,
            { count: 0, label: '' } as CounterState
        );
    }
    unsubscribe();
});

test('subscribeMany: duplicate (name, path) targets are wired exactly once', async () => {
    const store = makeStore();
    init(store, 'Counter', '/a');

    const calls: CounterChange[][] = [];
    const unsubscribe = store.subscribeMany(
        [
            { name: 'Counter', path: '/a' },
            { name: 'Counter', path: '/a' }
        ],
        changes => calls.push(changes)
    );

    assert.equal(
        Object.keys(store.subscribers.Counter['/a'] ?? {}).length,
        1,
        'the first duplicate wins; only one underlying subscription exists'
    );

    store.memo.Counter['/a'].updater({ count: 1 });
    await flushMicrotasks();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].length, 1, 'deduplicated to a single change entry');
    unsubscribe();
});

test('subscribeMany: the returned unsubscribe is idempotent and detaches every target', async () => {
    const store = makeStore();
    init(store, 'Counter', '/a');
    init(store, 'Counter', '/b');

    const calls: CounterChange[][] = [];
    const unsubscribe = store.subscribeMany(
        [
            { name: 'Counter', path: '/a' },
            { name: 'Counter', path: '/b' }
        ],
        changes => calls.push(changes)
    );

    assert.doesNotThrow(() => unsubscribe(), 'a second unsubscribe is harmless');

    store.memo.Counter['/a'].updater({ count: 1 });
    await flushMicrotasks();
    assert.equal(calls.length, 0, 'no delivery after unsubscribe');
});

test('subscribeMany: lazily initializes direct addresses like a hook would', () => {
    const store = makeStore();
    assert.equal(store.state.Counter['/fresh'], undefined);

    const unsubscribe = store.subscribeMany(
        [{ name: 'Counter', path: '/fresh' }],
        () => undefined
    );

    assert.deepEqual(store.state.Counter['/fresh'], { count: 0, label: '' });
    unsubscribe();
});

test('subscribeMany: an unresolvable routed address reads as the section baseline', () => {
    const store = createStore({
        Table: arraySectionGenerator('Row', rowSection),
        Row: rowSection
    });
    init(store, 'Table', '/t'); // table exists, row 99 does not

    type SM = typeof store.sectionMap;
    const calls: SubscribeManyChange<SM>[][] = [];
    const unsubscribe = store.subscribeMany(
        [{ name: 'Row', path: '/t[99]' }],
        changes => calls.push(changes),
        { fireImmediately: true }
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0][0].previous, undefined);
    assert.deepEqual(calls[0][0].current, { title: '', done: false });
    unsubscribe();
});

test('subscribeMany: a throwing listener is isolated and logged', async () => {
    const store = makeStore();
    init(store, 'Counter', '/a');

    const errors = await captureConsole('error', async () => {
        const unsubscribe = store.subscribeMany(
            [{ name: 'Counter', path: '/a' }],
            () => {
                throw new Error('listener exploded');
            }
        );
        store.memo.Counter['/a'].updater({ count: 1 });
        await flushMicrotasks();
        unsubscribe();
    });

    assert.ok(
        errors.some(message =>
            String(message).includes('subscribeMany listener threw')
        ),
        'the isolated listener failure must be logged'
    );
});

test('subscribeMany: watched paths defer a matching purgeWhenUnused until unsubscribe', async () => {
    const store = makeStore();
    init(store, 'Counter', '/p/1');

    const unsubscribe = store.subscribeMany(
        [{ name: 'Counter', path: '/p/1' }],
        () => undefined
    );

    store.purgeWhenUnused('/p');
    assert.notEqual(
        store.state.Counter['/p/1'],
        undefined,
        'a subscribed path must never be purged while the subscription is live'
    );

    unsubscribe();
    // The destructive pass runs on the next task after the last unsubscribe.
    await flushMicrotasks();
    await flushMicrotasks();
    assert.equal(store.state.Counter['/p/1'], undefined);
});
