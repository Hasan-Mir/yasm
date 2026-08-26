import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    deepFreeze,
    getFieldSetter,
    isPathWithinPrefix,
    mergeUpdaterGenerator,
    propertyUpdaterGenerator
} from '../src/util';

test('deepFreeze skips class instances so their constructors stay usable', () => {
    // Mimics decimal.js: every instance carries an OWN 'constructor' property
    // pointing at the shared class function, and clone-style code re-assigns
    // it on construction.
    class TinyDecimal {
        s = 1;
        d = [1];
        constructor(public raw: string) {
            (this as Record<string, unknown>).constructor = TinyDecimal;
        }
    }

    const amount = new TinyDecimal('1');
    const state = deepFreeze({
        Money: { '/m': { amount } }
    }) as { Money: { '/m': { amount: TinyDecimal } } };

    // The plain-object containers ARE frozen (dev protection intact)...
    assert.ok(Object.isFrozen(state));
    assert.ok(Object.isFrozen(state.Money));

    // ...but the class instance is intentionally left untouched:
    assert.equal(Object.isFrozen(amount), false);

    // The shared class function and its prototype must NOT be frozen —
    // otherwise `new TinyDecimal(...)` throws at `this.constructor = …`
    // exactly like the decimal.js "read only property 'constructor'" bug.
    const protoCtor = Object.getOwnPropertyDescriptor(
        TinyDecimal.prototype,
        'constructor'
    );
    assert.ok(protoCtor?.writable !== false);
    assert.doesNotThrow(() => new TinyDecimal('2'));
});

test('propertyUpdater returns the same reference when the value is unchanged', () => {
    const updater = propertyUpdaterGenerator<{ a: number; b: string }>();
    const state = { a: 1, b: 'x' };

    assert.equal(updater(state, { key: 'a', value: 1 }), state);

    const next = updater(state, { key: 'a', value: 2 });
    assert.notEqual(next, state);
    assert.deepEqual(next, { a: 2, b: 'x' });
    assert.deepEqual(state, { a: 1, b: 'x' }); // no mutation
});

test('mergeUpdater returns the same reference when all values are unchanged', () => {
    const updater = mergeUpdaterGenerator<{ a: number; b: string }>();
    const state = { a: 1, b: 'x' };

    assert.equal(updater(state, { a: 1 }), state);
    assert.equal(updater(state, {}), state);

    const next = updater(state, { a: 1, b: 'y' });
    assert.notEqual(next, state);
    assert.deepEqual(next, { a: 1, b: 'y' });
});

test('getFieldSetter caches one setter per (updateState, field) pair', () => {
    const payloads: unknown[] = [];
    const updateState = (
        payload:
            | Partial<{ total: number }>
            | ((state: { total: number }) => Partial<{ total: number }>)
    ) => {
        payloads.push(
            typeof payload === 'function' ? payload({ total: 1 }) : payload
        );
    };

    const setTotal = getFieldSetter(updateState, 'total');
    assert.equal(getFieldSetter(updateState, 'total'), setTotal);

    setTotal(5);
    setTotal(prev => prev + 1);
    assert.deepEqual(payloads, [{ total: 5 }, { total: 2 }]);
});

test('isPathWithinPrefix segment matching', () => {
    const boundaryChars = ['/', '[', '.'];

    assert.equal(isPathWithinPrefix('/a/1', '/a/1', boundaryChars), true);
    assert.equal(isPathWithinPrefix('/a/1/b', '/a/1', boundaryChars), true);
    assert.equal(isPathWithinPrefix('/a/1[3]', '/a/1', boundaryChars), true);
    assert.equal(isPathWithinPrefix('/a/1.x', '/a/1', boundaryChars), true);
    assert.equal(isPathWithinPrefix('/a/10', '/a/1', boundaryChars), false);
    assert.equal(isPathWithinPrefix('/a/1', '/a/', boundaryChars), true);
    assert.equal(isPathWithinPrefix('/anything', '', boundaryChars), true);
    assert.equal(isPathWithinPrefix('/a', '/a/b', boundaryChars), false);
    assert.equal(isPathWithinPrefix('/ab', '/a', boundaryChars), false);
});
