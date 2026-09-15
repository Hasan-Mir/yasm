import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init } from '../src/useYasmState';
import { purgeYasmState } from '../src/purge';
import { Section, createStore } from '../src/createStore';
import { arraySectionGenerator, mergeUpdaterGenerator } from '../src/util';
import {
    counterSection,
    captureWarnings,
    captureConsole,
    type CounterState
} from './helpers';

type Row = { title: string; done: boolean };
const rowSection: Section<Row, Partial<Row>> = {
    initialState: { title: '', done: false },
    updater: mergeUpdaterGenerator<Row>()
};

const makeStore = () => createStore({ Counter: counterSection });

test('selector-aware subscribe: transforms state and tracks prevSelected', () => {
    const store = makeStore();
    init(store, 'Counter', '/a');
    const record = store.memo.Counter['/a'];

    const calls: [number, number | undefined][] = [];
    const unsubscribe = store.subscribe(
        'Counter',
        '/a',
        (s: CounterState) => s.count,
        (selected, prevSelected) => calls.push([selected, prevSelected])
    );

    record.updater({ count: 1 });
    assert.deepEqual(calls, [[1, undefined]]);

    record.updater({ count: 5 });
    assert.deepEqual(calls, [
        [1, undefined],
        [5, 1]
    ]);

    unsubscribe();
    record.updater({ count: 9 });
    assert.deepEqual(
        calls,
        [
            [1, undefined],
            [5, 1]
        ],
        'unsubscribed listeners must not be notified'
    );
});

test('selector-aware subscribe: default shallow equality bails out on structurally-identical selections', () => {
    const store = makeStore();
    init(store, 'Counter', '/a');
    const record = store.memo.Counter['/a'];

    let fires = 0;
    // Returns a NEW object identity on every call — only a top-level value
    // change may re-fire under the default 'shallow' strategy.
    const unsubscribe = store.subscribe(
        'Counter',
        '/a',
        (s: CounterState) => ({ label: s.label }),
        () => fires++
    );

    record.updater({ label: 'a' });
    assert.equal(fires, 1);

    // Same top-level values → structural equality → no re-fire.
    record.updater({ count: 999 });
    assert.equal(fires, 1);

    record.updater({ label: 'b' });
    assert.equal(fires, 2);
    unsubscribe();
});

test('selector-aware subscribe: strict equality re-fires on new object identity', () => {
    const store = makeStore();
    init(store, 'Counter', '/a');
    const record = store.memo.Counter['/a'];

    let fires = 0;
    store.subscribe(
        'Counter',
        '/a',
        (s: CounterState) => ({ label: s.label }),
        () => fires++,
        { equality: 'strict' }
    );

    // Each update really changes the store, but the SELECTED output is
    // structurally identical every time. Under 'strict' (Object.is) the new
    // object identity wins and every notification fires — unlike the default
    // 'shallow' strategy which bails out.
    record.updater({ count: 1 });
    record.updater({ count: 2 });
    record.updater({ count: 3 });
    assert.equal(fires, 3);
});

test('selector-aware subscribe: a custom equality function decides unchanged selections', () => {
    const store = makeStore();
    init(store, 'Counter', '/a');
    const record = store.memo.Counter['/a'];

    let fires = 0;
    store.subscribe(
        'Counter',
        '/a',
        (s: CounterState) => s.count,
        () => fires++,
        // Only parity changes matter.
        { equality: (prev: number, next: number) => prev % 2 === next % 2 }
    );

    record.updater({ count: 1 }); // 0 → 1: parity changed
    assert.equal(fires, 1);
    record.updater({ count: 3 }); // 1 → 3: same parity → no-op
    assert.equal(fires, 1);
    record.updater({ count: 4 }); // 3 → 4: parity changed
    assert.equal(fires, 2);
});

test('selector-aware subscribe: fireImmediately reports (current, undefined) on a lazy path', () => {
    const store = makeStore();
    // `/fresh` is NEVER initialized: the subscription itself lazily
    // initializes it from `initialState` so the listener never sees raw
    // `undefined` for a valid section.
    const calls: [number, number | undefined][] = [];
    store.subscribe(
        'Counter',
        '/fresh',
        (s: CounterState) => s.count,
        (selected, prevSelected) => calls.push([selected, prevSelected]),
        { fireImmediately: true }
    );

    assert.deepEqual(calls, [[0, undefined]]);
});

test('selector-aware subscribe: a purged path re-subscribes from the baseline, never undefined', async () => {
    const store = makeStore();
    init(store, 'Counter', '/x');
    store.memo.Counter['/x'].updater({ count: 42 });

    await captureWarnings(() => purgeYasmState(store, '/x'));

    assert.equal(store.state.Counter['/x'], undefined);

    // A fresh selector subscription after the purge re-initializes the path
    // from `initialState` — no crash, no raw undefined.
    const calls: [number, number | undefined][] = [];
    store.subscribe(
        'Counter',
        '/x',
        (s: CounterState) => s.count,
        (selected, prevSelected) => calls.push([selected, prevSelected]),
        { fireImmediately: true }
    );
    assert.deepEqual(calls, [[0, undefined]]);
    assert.deepEqual(store.state.Counter['/x'], { count: 0, label: '' });
});

test('selector-aware subscribe: routed children observe parent updates through their physical path', () => {
    const store = createStore({
        Table: arraySectionGenerator('Row', rowSection),
        Row: rowSection
    });
    init(store, 'Table', '/t');
    store.memo.Table['/t'].updater({
        addingItems: [{ id: 3, partialState: { title: 'row3' } }],
        order: [3]
    });

    const titles: string[] = [];
    store.subscribe('Row', '/t[3]', (row: Row) => row.title, title => {
        titles.push(title);
    });

    store.memo.Table['/t'].updater({
        editingItems: [{ id: 3, itemPayload: { title: 'edited' } }]
    });
    assert.deepEqual(titles, ['edited']);
});

test('selector-aware subscribe: a never-initialized routed element falls back to the section baseline', () => {
    const store = createStore({
        Table: arraySectionGenerator('Row', rowSection),
        Row: rowSection
    });
    init(store, 'Table', '/t'); // table exists, but row 99 does not

    const calls: [string, string | undefined][] = [];
    store.subscribe(
        'Row',
        '/t[99]',
        (row: Row) => row.title,
        (selected, prevSelected) => calls.push([selected, prevSelected]),
        { fireImmediately: true }
    );

    // The route cannot resolve → the section baseline is read instead of
    // throwing or surfacing raw `undefined`.
    assert.deepEqual(calls, [['', undefined]]);
});

test('selector-aware subscribe: a throwing listener is isolated from other subscribers', async () => {
    const store = makeStore();
    init(store, 'Counter', '/a');
    const record = store.memo.Counter['/a'];

    let otherNotified = 0;
    record.subscribe(() => otherNotified++);

    store.subscribe(
        'Counter',
        '/a',
        (s: CounterState) => s.count,
        () => {
            throw new Error('listener exploded');
        }
    );

    const errors = await captureConsole('error', () =>
        record.updater({ count: 1 })
    );

    assert.equal(otherNotified, 1, 'the raw subscriber must still be notified');
    assert.equal(errors.length, 1);
    assert.match(errors[0], /listener threw an exception/);
});

test('selector-aware subscribe: the low-level overload still works after the overload split', () => {
    const store = makeStore();
    let notified = 0;
    const unsubscribe = store.subscribe(
        () => notified++,
        'Counter',
        '/low'
    );
    init(store, 'Counter', '/low');
    store.memo.Counter['/low'].updater({ count: 7 });
    assert.equal(notified, 1);
    unsubscribe();
    store.memo.Counter['/low'].updater({ count: 8 });
    assert.equal(notified, 1);
});

test('selector-aware subscribe: shallow equality notifies when Date values change', () => {
    type SessionState = { loginTime: Date };
    const sessionSection: Section<SessionState, Partial<SessionState>> = {
        initialState: { loginTime: new Date(1000) },
        updater: mergeUpdaterGenerator<SessionState>()
    };

    const store = createStore({ Session: sessionSection });
    init(store, 'Session', '/session');

    let fires = 0;
    let lastTime: number | undefined;

    store.subscribe(
        'Session',
        '/session',
        (s: SessionState) => s.loginTime,
        date => {
            fires++;
            lastTime = date.getTime();
        }
    );

    store.memo.Session['/session'].updater({ loginTime: new Date(2000) });
    assert.equal(fires, 1);
    assert.equal(lastTime, 2000);

    // Identical timestamp Date should not re-fire
    store.memo.Session['/session'].updater({ loginTime: new Date(2000) });
    assert.equal(fires, 1);
});
