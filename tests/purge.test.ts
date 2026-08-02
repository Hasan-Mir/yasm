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
