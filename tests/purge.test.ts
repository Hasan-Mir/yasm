import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init } from '../src/useYasmState';
import { purgeYasmState } from '../src/purge';
import { createStore } from '../src/createStore';
import { counterSection, captureWarnings } from './helpers';

const makeStore = () => createStore({ Counter: counterSection });

test('segment matching: purging "/tabs/1" does NOT purge "/tabs/10"', () => {
    const store = makeStore();
    init(store, 'Counter', '/tabs/1');
    init(store, 'Counter', '/tabs/10');
    init(store, 'Counter', '/tabs/1/child');
    init(store, 'Counter', '/tabs/1[3]');

    purgeYasmState(store, '/tabs/1');

    assert.equal(store.state.Counter['/tabs/1'], undefined);
    assert.equal(store.state.Counter['/tabs/1/child'], undefined);
    assert.equal(store.state.Counter['/tabs/1[3]'], undefined);
    assert.notEqual(store.state.Counter['/tabs/10'], undefined);

    // memo records are cleaned up the same way
    assert.equal(store.memo.Counter['/tabs/1'], undefined);
    assert.equal(store.memo.Counter['/tabs/1/child'], undefined);
    assert.notEqual(store.memo.Counter['/tabs/10'], undefined);
});

test('legacy raw prefix matching is available via { match: "startsWith" }', () => {
    const store = makeStore();
    init(store, 'Counter', '/tabs/1');
    init(store, 'Counter', '/tabs/10');

    purgeYasmState(store, '/tabs/1', { match: 'startsWith' });

    assert.equal(store.state.Counter['/tabs/1'], undefined);
    assert.equal(store.state.Counter['/tabs/10'], undefined);
});

test('purging an empty prefix purges everything', () => {
    const store = makeStore();
    init(store, 'Counter', '/a');
    init(store, 'Counter', '/b');
    purgeYasmState(store, '');
    assert.deepEqual(store.state.Counter, {});
    assert.deepEqual(store.memo.Counter, {});
});

test('purge warns when subscribers are still attached', async () => {
    const store = makeStore();
    init(store, 'Counter', '/a');
    store.memo.Counter['/a'].subscribe(() => undefined);

    const warnings = await captureWarnings(() => purgeYasmState(store, '/a'));

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /still mounted/);
    assert.match(warnings[0], /"Counter" at path "\/a"/);
});

test('purge does not warn when nobody is subscribed anymore', async () => {
    const store = makeStore();
    init(store, 'Counter', '/a');
    const unsubscribe = store.memo.Counter['/a'].subscribe(() => undefined);
    unsubscribe();

    const warnings = await captureWarnings(() => purgeYasmState(store, '/a'));
    assert.deepEqual(warnings, []);
});

test('purge tolerates stale sections restored from outdated persistence', () => {
    const store = makeStore();
    init(store, 'Counter', '/a');

    // Simulate a persisted store that contains a section which no longer
    // exists in the current section map: state exists, but there are no
    // matching subscribers/memo records. This used to crash with
    // "cannot read/delete property of undefined".
    (store.state as Record<string, Record<string, unknown>>).Ghost = {
        '/a': { some: 'thing' },
        '/b': { other: 'thing' }
    };

    assert.doesNotThrow(() => purgeYasmState(store, '/a'));
    const ghost = (store.state as Record<string, Record<string, unknown>>)
        .Ghost;
    assert.equal(ghost['/a'], undefined);
    assert.notEqual(ghost['/b'], undefined);
});

test('purging the same path twice is idempotent and safe', async () => {
    const store = makeStore();
    init(store, 'Counter', '/a');
    await captureWarnings(() => purgeYasmState(store, '/a'));
    assert.doesNotThrow(() => purgeYasmState(store, '/a'));
});

test('purging a path that never existed is safe', () => {
    const store = makeStore();
    assert.doesNotThrow(() => purgeYasmState(store, '/never'));
});

test('purgeWhenUnused executes immediately when nothing is subscribed', async () => {
    const store = makeStore();
    init(store, 'Counter', '/a');

    const warnings = await captureWarnings(() => store.purgeWhenUnused('/a'));

    assert.deepEqual(warnings, [], 'the safe API must never warn');
    assert.equal(store.state.Counter['/a'], undefined);
    assert.equal(store.memo.Counter['/a'], undefined);
});

test('purgeWhenUnused defers until the last matching subscriber leaves', async () => {
    const store = makeStore();
    init(store, 'Counter', '/t/1');
    init(store, 'Counter', '/t/2');

    const unsubscribeFirst = store.memo.Counter['/t/1'].subscribe(
        () => undefined
    );
    const unsubscribeSecond = store.memo.Counter['/t/2'].subscribe(
        () => undefined
    );

    const warnings = await captureWarnings(() => store.purgeWhenUnused('/t'));
    assert.deepEqual(warnings, []);
    assert.notEqual(store.state.Counter['/t/1'], undefined);
    assert.notEqual(store.state.Counter['/t/2'], undefined);

    unsubscribeFirst();
    assert.notEqual(
        store.state.Counter['/t/1'],
        undefined,
        'the second subscriber still holds the prefix'
    );

    unsubscribeSecond();
    assert.equal(store.state.Counter['/t/1'], undefined);
    assert.equal(store.state.Counter['/t/2'], undefined);
    assert.equal(store.memo.Counter['/t/1'], undefined);
    assert.equal(store.memo.Counter['/t/2'], undefined);
});

test('purgeWhenUnused never wipes revived paths (fire-time re-verification)', () => {
    const store = makeStore();
    init(store, 'Counter', '/t/1');
    init(store, 'Counter', '/t/2');

    const unsubscribeFirst = store.memo.Counter['/t/1'].subscribe(
        () => undefined
    );
    const unsubscribeSecond = store.memo.Counter['/t/2'].subscribe(
        () => undefined
    );

    store.purgeWhenUnused('/t');
    unsubscribeFirst();

    // /t/1 comes back to life (e.g. a refetch restored the row) before the
    // purge could fire
    const unsubscribeRevived = store.memo.Counter['/t/1'].subscribe(
        () => undefined
    );

    unsubscribeSecond();
    // The fire attempt re-verified against live subscribers, found the
    // revived /t/1, and keeps waiting instead of wiping it
    assert.notEqual(store.state.Counter['/t/1'], undefined);
    assert.notEqual(store.state.Counter['/t/2'], undefined);

    unsubscribeRevived();
    // Now genuinely unused — the whole prefix is destroyed
    assert.equal(store.state.Counter['/t/1'], undefined);
    assert.equal(store.state.Counter['/t/2'], undefined);
});

test('purgeWhenUnused re-scheduling replaces the previous snapshot (dedup)', () => {
    const store = makeStore();
    init(store, 'Counter', '/t/1');
    const unsubscribeFirst = store.memo.Counter['/t/1'].subscribe(
        () => undefined
    );

    store.purgeWhenUnused('/t');

    // A second consumer appears after the first schedule...
    init(store, 'Counter', '/t/2');
    const unsubscribeSecond = store.memo.Counter['/t/2'].subscribe(
        () => undefined
    );
    // ...and the prefix is scheduled again — the fresh snapshot includes /t/2
    store.purgeWhenUnused('/t');

    unsubscribeFirst();
    // Stale bookkeeping would fire here and wipe /t/2; the fresh snapshot
    // (and the fire-time re-verification) keeps waiting instead.
    assert.notEqual(store.state.Counter['/t/2'], undefined);

    unsubscribeSecond();
    assert.equal(store.state.Counter['/t/2'], undefined);
});

test('purgeWhenUnused supports legacy { match: "startsWith" }', () => {
    const store = makeStore();
    init(store, 'Counter', '/t/1');
    init(store, 'Counter', '/t/10');
    const unsubscribeTen = store.memo.Counter['/t/10'].subscribe(
        () => undefined
    );

    // With startsWith, the subscribed /t/10 makes the schedule pend even
    // though segment matching would have purged /t/1 immediately.
    store.purgeWhenUnused('/t/1', { match: 'startsWith' });
    assert.notEqual(store.state.Counter['/t/1'], undefined);
    assert.notEqual(store.state.Counter['/t/10'], undefined);

    unsubscribeTen();
    // The deferred fire wipes both paths, exactly like a raw startsWith purge.
    assert.equal(store.state.Counter['/t/1'], undefined);
    assert.equal(store.state.Counter['/t/10'], undefined);
});

test('purgeWhenUnused fire-time re-verification tracks subscriptions, not bare state', () => {
    const store = makeStore();
    init(store, 'Counter', '/t/1');
    const unsubscribe = store.memo.Counter['/t/1'].subscribe(() => undefined);

    store.purgeWhenUnused('/t');

    // A write-only consumer recreates a sibling path (no subscription):
    init(store, 'Counter', '/t/2');

    unsubscribe();
    // Only /t/1 was tracked; the fire wipes the whole prefix including the
    // freshly initialized-but-unsubscribed /t/2 (documented caveat).
    assert.equal(store.state.Counter['/t/2'], undefined);
});

test('purgeWhenUnused uses segment-aware matching like raw purge', () => {
    const store = makeStore();
    init(store, 'Counter', '/t/1');
    init(store, 'Counter', '/t/10');

    const unsubscribeTen = store.memo.Counter['/t/10'].subscribe(
        () => undefined
    );

    // /t/1 has no subscribers → immediate purge of the '/t/1' subtree only
    store.purgeWhenUnused('/t/1');

    assert.equal(store.state.Counter['/t/1'], undefined);
    assert.notEqual(store.state.Counter['/t/10'], undefined);

    unsubscribeTen();
});
