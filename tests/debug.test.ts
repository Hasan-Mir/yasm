import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, type Section } from '../src/createStore';
import { init } from '../src/useYasmState';
import { purgeYasmState } from '../src/purge';
import {
    composeDebugLogArgs,
    createMemoryStorage,
    mergeUpdaterGenerator,
    snapshotByPrefix
} from '../src/util';

type TabState = { title: string };
const tabSection: Section<TabState, Partial<TabState>> = {
    initialState: { title: '' },
    updater: mergeUpdaterGenerator<TabState>()
};

type CellState = { amount: number };
const cellSection: Section<CellState, Partial<CellState>> = {
    initialState: { amount: 0 },
    updater: mergeUpdaterGenerator<CellState>()
};

const makeStore = () => {
    const store = createStore({ Tab: tabSection, Cell: cellSection }, {});
    // Seed state directly (mirrors production layouts: one tab with a form and
    // nested cells, plus sibling/other-tab states that must NOT match).
    (store.state as any).Tab['/tabs/1'] = { title: 'one' };
    (store.state as any).Tab['/tabs/10'] = { title: 'ten' };
    (store.state as any).Cell['/tabs/1/form'] = { amount: 5 };
    (store.state as any).Cell['/tabs/1/form/name'] = { amount: 7 };
    (store.state as any).Cell['/tabs/2'] = { amount: 99 };
    return store;
};

// ---------- snapshotByPrefix: flat mode ----------

test('snapshotByPrefix flat mode filters by prefix and keeps descendants', () => {
    const store = makeStore();
    const snap = snapshotByPrefix(store, '/tabs/1');

    assert.deepEqual(snap, {
        Tab: {
            '/tabs/1': { title: 'one' }
        },
        Cell: {
            '/tabs/1/form': { amount: 5 },
            '/tabs/1/form/name': { amount: 7 }
        }
    });
});

test('snapshotByPrefix never matches sibling prefixes (/tabs/1 ≠ /tabs/10)', () => {
    const store = makeStore();
    const snap = snapshotByPrefix(store, '/tabs/1');
    assert.equal((snap.Tab as any)['/tabs/10'], undefined);
});

test('snapshotByPrefix supports multiple prefixes and legacy startsWith', () => {
    const store = makeStore();

    const both = snapshotByPrefix(store, ['/tabs/1', '/tabs/2']);
    assert.deepEqual(Object.keys(both.Cell as any).sort(), [
        '/tabs/1/form',
        '/tabs/1/form/name',
        '/tabs/2'
    ]);

    // Legacy raw-prefix behavior must be opt-in only.
    const startsWith = snapshotByPrefix(store, '/tabs/1', {
        match: 'startsWith'
    });
    assert.notEqual(
        (startsWith.Tab as any)['/tabs/10'],
        undefined,
        'startsWith match must include /tabs/10'
    );
});

test('snapshotByPrefix: empty prefix matches all, unknown prefix matches none', () => {
    const store = makeStore();

    const everything = snapshotByPrefix(store, '');
    assert.equal(Object.keys(everything).length, 2);

    const nothing = snapshotByPrefix(store, '/nope');
    assert.deepEqual(nothing, {});
});

test('snapshotByPrefix serialize round-trips custom types; false returns live references', () => {
    type BigState = { amount: bigint };
    const bigSection: Section<BigState, Partial<BigState>> = {
        initialState: { amount: BigInt(0) },
        updater: mergeUpdaterGenerator<BigState>()
    };
    const store = createStore({ Big: bigSection }, {
        serializer: (
            object: Record<string, unknown>,
            key: string,
            value: unknown
        ) =>
            typeof object[key] === 'bigint' ? '$$B$$_' + String(value) : value,
        deserializer: (_key: string, value: unknown) =>
            typeof value === 'string' && value.startsWith('$$B$$_')
                ? BigInt(value.slice(6))
                : value
    } as any);
    (store.state as any).Big['/b'] = { amount: BigInt(42) };

    const serialized = snapshotByPrefix(store, '/b');
    assert.deepEqual(serialized.Big, { '/b': { amount: BigInt(42) } });

    const live = snapshotByPrefix(store, '/b', { serialize: false });
    assert.strictEqual(
        (live.Big as any)['/b'],
        (store.state as any).Big['/b'],
        'serialize:false must return the live reference'
    );
});

// ---------- snapshotByPrefix: tree mode ----------

test('snapshotByPrefix tree nests children under their closest ancestor', () => {
    const store = makeStore();
    const tree = snapshotByPrefix(store, '/tabs/1', {
        mode: 'tree',
        includeSubscribers: true
    });

    assert.deepEqual(tree, {
        '/tabs/1': {
            __state__: { Tab: { title: 'one' } },
            __subscribers__: 0,
            __children__: {
                '/tabs/1/form': {
                    __state__: { Cell: { amount: 5 } },
                    __subscribers__: 0,
                    __children__: {
                        '/tabs/1/form/name': {
                            __state__: { Cell: { amount: 7 } },
                            __subscribers__: 0,
                            __children__: {}
                        }
                    }
                }
            }
        }
    });
});

test('snapshotByPrefix tree groups multiple sections owning the same path', () => {
    const store = makeStore();
    // A routed/composed setup: two sections share one physical path identity.
    (store.state as any).Tab['/tabs/1/shared'] = { title: 'shared' };
    (store.state as any).Cell['/tabs/1/shared'] = { amount: 5 };

    const tree = snapshotByPrefix(store, '/tabs/1', { mode: 'tree' }) as any;
    const sharedNode = tree['/tabs/1'].__children__['/tabs/1/shared'];

    assert.deepEqual(sharedNode.__state__, {
        Tab: { title: 'shared' },
        Cell: { amount: 5 }
    });
});

test('snapshotByPrefix tree reports live subscriber counts', () => {
    const store = makeStore();
    const unsubscribe = store.subscribe(() => {}, 'Cell', '/tabs/1/form');

    const tree = snapshotByPrefix(store, '/tabs/1', {
        mode: 'tree',
        includeSubscribers: true
    }) as any;
    assert.equal(
        tree['/tabs/1'].__children__['/tabs/1/form'].__subscribers__,
        1
    );

    unsubscribe();
});

// ---------- snapshotByPrefix ----------

test('store.snapshotByPrefix mirrors the standalone helper across overloads', () => {
    const store = makeStore();

    // Prefix only.
    assert.deepEqual(
        store.snapshotByPrefix('/tabs/1'),
        snapshotByPrefix(store, '/tabs/1')
    );

    // Prefix + options.
    assert.deepEqual(
        store.snapshotByPrefix('/tabs/1', { mode: 'tree' }),
        snapshotByPrefix(store, '/tabs/1', { mode: 'tree' })
    );

    // Prefix array.
    assert.deepEqual(
        store.snapshotByPrefix(['/tabs/1', '/tabs/10']),
        snapshotByPrefix(store, ['/tabs/1', '/tabs/10'])
    );

    // No arguments → entire store, flat.
    assert.deepEqual(store.snapshotByPrefix(), snapshotByPrefix(store));

    // Options only → entire store with options.
    assert.deepEqual(
        store.snapshotByPrefix({ mode: 'tree' }),
        snapshotByPrefix(store, { mode: 'tree' })
    );
});

test('snapshotFilter.sectionFilter excludes unrelated sections from full snapshots', async () => {
    const store = createStore({ Tab: tabSection, Cell: cellSection }, {
        debugOptions: {
            logStateUpdates: true,
            snapshotScope: 'full',
            // Only Tab is interesting here — Cell must not appear in the dump
            // even though its state matches the (empty = match-all) path filter.
            snapshotFilter: { sectionFilter: 'Tab' }
        }
    } as any);
    makeStoreSeeded(store);
    init(store, 'Tab' as any, '/tabs/1' as any);

    const captured: unknown[][] = [];
    const originalDebug = console.debug;
    console.debug = (...args: unknown[]) => {
        captured.push(args);
    };
    try {
        store.memo.Tab['/tabs/1'].updater({ title: 'updated' });
    } finally {
        console.debug = originalDebug;
    }
    const combined = JSON.stringify(captured);

    assert.match(combined, /Before:/);
    assert.match(combined, /After:/);
    // Tab's state is present...
    assert.match(combined, /title/);
    // ...while Cell's is filtered out entirely.
    assert.doesNotMatch(combined, /amount/);
});

test('snapshotByPrefix without a prefix snapshots the ENTIRE store as a tree', () => {
    const store = makeStore();
    const tree = snapshotByPrefix(store, { mode: 'tree' }) as any;

    // Roots include every top-level path across all sections...
    assert.deepEqual(Object.keys(tree).sort(), [
        '/tabs/1',
        '/tabs/10',
        '/tabs/2'
    ]);
    // ...with children nested under their closest ancestors.
    assert.equal(
        tree['/tabs/1'].__children__['/tabs/1/form'].__state__.Cell.amount,
        5
    );
    assert.deepEqual(tree['/tabs/10'].__state__, {
        Tab: { title: 'ten' }
    });

    const flatAll = snapshotByPrefix(store);
    assert.equal(Object.keys(flatAll).length, 2);
});

// ---------- createMemoryStorage ----------

test('createMemoryStorage works as a persistence adapter', async () => {
    const storage = createMemoryStorage();
    await storage.setItem('k', '{"a":1}');
    assert.equal(await storage.getItem('k'), '{"a":1}');
    await storage.removeItem('k');
    assert.equal(await storage.getItem('k'), null);
    await storage.setItem('k2', 'v2');
    await storage.clear();
    assert.equal(storage.data.size, 0);
});

// ---------- debugOptions integration (update + purge logging) ----------

test('snapshotFilter.pathFilter scopes full update snapshots to the matching subtree', async () => {
    const store = createStore({ Tab: tabSection, Cell: cellSection }, {
        debugOptions: {
            logStateUpdates: true,
            snapshotScope: 'full',
            snapshotFilter: {
                pathFilter: '/tabs/1',
                mode: 'tree'
            }
        }
    } as any);
    makeStoreSeeded(store);
    init(store, 'Tab' as any, '/tabs/1' as any);

    const captured: unknown[][] = [];
    const originalDebug = console.debug;
    console.debug = (...args: unknown[]) => {
        captured.push(args);
    };
    try {
        store.memo.Tab['/tabs/1'].updater({ title: 'updated' });
    } finally {
        console.debug = originalDebug;
    }
    const combined = JSON.stringify(captured);

    assert.match(combined, /Before:/);
    assert.match(combined, /After:/);
    // The filtered tree contains the target subtree...
    assert.match(combined, /\/tabs\/1\/form/);
    assert.match(combined, /__children__/);
    // ...and nothing from outside the filter.
    assert.doesNotMatch(combined, /\/tabs\/10/);
    assert.doesNotMatch(combined, /\/tabs\/2/);
});

test('snapshotFilter match: "exact" logs a single path without its subtree', async () => {
    const store = createStore({ Tab: tabSection, Cell: cellSection }, {
        debugOptions: {
            logStateUpdates: true,
            purgeSnapshotScope: 'full',
            snapshotFilter: {
                pathFilter: '/tabs/1/form', // Cell's state — exact slot only
                match: 'exact'
            }
        }
    } as any);
    makeStoreSeeded(store);

    const captured: unknown[][] = [];
    const originalDebug = console.debug;
    console.debug = (...args: unknown[]) => {
        captured.push(args);
    };
    try {
        purgeYasmState(store, '/tabs/1');
    } finally {
        console.debug = originalDebug;
    }
    const combined = JSON.stringify(captured);

    assert.match(combined, /before purge:/);
    assert.match(combined, /after purge:/);
    // ONLY the exact path is dumped...
    assert.match(combined, /\/tabs\/1\/form/);
    // ...no descendants, siblings or other paths.
    assert.doesNotMatch(combined, /\/tabs\/1\/form\/\w/);
    assert.doesNotMatch(combined, /"title"/); // Tab's /tabs/1 stays out
    assert.doesNotMatch(combined, /\/tabs\/10/);
});

test('snapshotFilter.pathFilter scopes full purge snapshots to the matching subtree', async () => {
    const store = createStore({ Tab: tabSection, Cell: cellSection }, {
        debugOptions: {
            logStateUpdates: true,
            purgeSnapshotScope: 'full',
            snapshotFilter: { pathFilter: '/tabs/1' }
        }
    } as any);
    makeStoreSeeded(store);

    const captured: unknown[][] = [];
    const originalDebug = console.debug;
    console.debug = (...args: unknown[]) => {
        captured.push(args);
    };
    try {
        purgeYasmState(store, '/tabs/1');
    } finally {
        console.debug = originalDebug;
    }
    const combined = JSON.stringify(captured);

    // Before-snapshot shows the purged subtree...
    assert.match(combined, /\/tabs\/1\/form/);
    // ...and nothing from outside the filter.
    assert.doesNotMatch(combined, /\/tabs\/10/);
    assert.doesNotMatch(combined, /\/tabs\/2/);
});

const makeStoreSeeded = (store: ReturnType<typeof createStore>) => {
    (store.state as any).Tab['/tabs/1'] = { title: 'one' };
    (store.state as any).Tab['/tabs/10'] = { title: 'ten' };
    (store.state as any).Cell['/tabs/1/form'] = { amount: 5 };
};

// ---------- timestamps & colored purge logs ----------

const captureWarnings = async (
    run: () => void | Promise<void>
): Promise<string[]> => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(' '));
    };
    try {
        await run();
    } finally {
        console.warn = originalWarn;
    }

    return warnings;
};

const captureRawDebugLogs = async (
    run: () => void
): Promise<{
    combined: string;
    formatStrings: string[];
    capturedArgs: unknown[][];
}> => {
    const captured: unknown[][] = [];
    const originalDebug = console.debug;
    console.debug = (...args: unknown[]) => {
        captured.push(args);
    };
    try {
        run();
    } finally {
        console.debug = originalDebug;
    }
    return {
        combined: JSON.stringify(captured),
        formatStrings: captured.map(args => String(args[0])),
        capturedArgs: captured
    };
};

test('dev logs carry a dimmed timestamp by default and honor timestampFormatter', async () => {
    const store = createStore({ Tab: tabSection }, {
        debugOptions: { logStateUpdates: true }
    } as any);
    init(store, 'Tab', '/t');

    // Default: dimmed local HH:MM:SS.mmm — the %c style segment is present.
    const withDefault = await captureRawDebugLogs(() => {
        store.memo.Tab['/t'].updater({ title: 'a' });
    });
    assert.ok(
        withDefault.formatStrings.some(s => s.startsWith('%c')),
        'default timestamps must be rendered through a %c segment'
    );

    // Custom formatter content flows into the log verbatim...
    const customStore = createStore({ Tab: tabSection }, {
        debugOptions: {
            logStateUpdates: true,
            timestampFormatter: () => 'TS!'
        }
    } as any);
    init(customStore, 'Tab', '/t');
    const withCustom = await captureRawDebugLogs(() => {
        customStore.memo.Tab['/t'].updater({ title: 'b' });
    });
    assert.ok(
        withCustom.formatStrings.some(s => s.startsWith('%c')),
        'custom formatter output must flow through a %c segment'
    );
    assert.ok(
        withCustom.capturedArgs.some(args => args.includes('TS! ')),
        'custom formatter text must appear as a substitution argument'
    );

    // 🔒 %c/style parity: the header call must carry exactly one style per %c.
    // Shape (custom ts): ['%c%s%c%s', grayStyle, 'TS! ', '', headerText]
    // — trailing bare %c resets styling so gray does not bleed into text.
    // (The payload is logged separately, not as a format-string argument.)
    const headerCall = withCustom.capturedArgs.find(args =>
        String(args.join(' ')).includes('updating')
    ) as unknown[];
    assert.ok(headerCall, 'header call must exist');
    assert.equal(
        headerCall.length,
        5,
        'format + grayStyle + ts + RESET + header'
    );
    assert.equal(
        String(headerCall[0]),
        '%c%s%c%s',
        '%c%s pair + reset + plain %s'
    );
    assert.match(String(headerCall[1]), /color/);
    assert.equal(String(headerCall[2]), 'TS! ');
    assert.equal(String(headerCall[3]), '', 'reset style must be empty');
    assert.match(String(headerCall[4]), /YASM.*updating/);

    // ...and `false` disables timestamps completely (no %c in plain headers).
    const offStore = createStore({ Tab: tabSection }, {
        debugOptions: {
            logStateUpdates: true,
            timestampFormatter: false
        }
    } as any);
    init(offStore, 'Tab', '/t');
    const whenOff = await captureRawDebugLogs(() => {
        offStore.memo.Tab['/t'].updater({ title: 'c' });
    });
    const offHeader = whenOff.capturedArgs.find(args =>
        String(args.join(' ')).includes('updating')
    ) as unknown[];
    assert.ok(offHeader, 'header call must exist');
    assert.equal(
        offHeader.some(
            a => typeof a === 'string' && (a as string).includes('%c')
        ),
        false,
        'timestampFormatter:false must remove all %c segments from plain headers'
    );
});

test('purge logs use a colored 🧹 badge in both filtered and plain modes', async () => {
    const makePurgeStore = (
        logStateUpdates: boolean | ((event: never) => boolean)
    ) =>
        createStore({ Tab: tabSection, Cell: cellSection }, {
            debugOptions: {
                logStateUpdates,
                timestampFormatter: false
            }
        } as any);

    // Plain mode: orange/red badge + 🧹 emoji.
    const plainStore = makePurgeStore(true);
    makeStoreSeeded(plainStore);
    const plainLogs = await captureRawDebugLogs(() => {
        purgeYasmState(plainStore, '/tabs/1');
    });
    assert.match(plainLogs.combined, /🧹 YASM purging/);
    assert.match(plainLogs.combined, /#ea580c/);

    // Filtered mode: SAME orange badge, plus a teal `Filtered` tag before
    // the message text.
    const filteredStore = makePurgeStore(() => true);
    makeStoreSeeded(filteredStore);
    const filteredLogs = await captureRawDebugLogs(() => {
        purgeYasmState(filteredStore, '/tabs/1');
    });
    assert.match(filteredLogs.combined, /🧹 YASM purging/);
    assert.match(filteredLogs.combined, /#ea580c/);
    assert.match(filteredLogs.combined, /Filtered/);
    assert.match(filteredLogs.combined, /#0d9488/);
});

test('styled dev logs use ONE format string with every %c paired with %s', async () => {
    // Regression: adjacent bare `%c…` string arguments are mis-rendered by
    // some console wrappers (only the first style applies; later segments
    // print literal `%c` + raw CSS). The composer must instead emit a single
    // format string of chained `%c%s`/`%s` specifiers.
    const store = createStore({ Tab: tabSection, Cell: cellSection }, {
        debugOptions: { logStateUpdates: true }
    } as any);
    makeStoreSeeded(store);
    init(store, 'Tab', '/tabs/1');

    const logs = await captureRawDebugLogs(() => {
        store.memo.Tab['/tabs/1'].updater({ title: 'updated' });
        purgeYasmState(store, '/tabs/1');
    });

    for (const call of logs.capturedArgs) {
        const format = String(call[0]);
        if (!format.includes('%c')) {
            continue;
        }
        // The whole format string must be built exclusively from `%c%s`
        // pairs, plain `%s` specifiers, and bare reset `%c` markers.
        assert.match(
            format,
            /^(?:%c%s|%s|%c)+$/,
            `format string must only contain %c%s/%s/reset-%c specifiers, got: ${format}`
        );
        // Exactly one style argument per styled `%c` (resets carry '').
        const styledCount = (format.match(/%c/g) ?? []).length;
        let stylesSeen = 0;
        for (let i = 1; i < call.length; i++) {
            if (
                typeof call[i] === 'string' &&
                /(?:background|color)\s*:/.test(String(call[i]))
            ) {
                stylesSeen++;
            }
        }
        assert.ok(
            stylesSeen <= styledCount,
            'every style argument must have a matching %c'
        );
        // Every styled run must be terminated by a bare reset %c before
        // unstyled content — otherwise colors bleed into following text.
        const unstyledAfterStyled =
            /%c%s(?:(?!%c).)*$/.test(format) && !/%c%s$/.test(format);
        if (unstyledAfterStyled) {
            assert.match(
                format,
                /%c%s%c(?:%s|$)/,
                'a styled segment followed by more output must be reset'
            );
        }
    }

    // The purge header combines timestamp + badge + message: ts pair, badge
    // pair, then a reset %c so orange covers exactly `🧹 YASM ` and the
    // message stays unstyled — all inside a single format string.
    const purgeHeader = logs.capturedArgs.find(args =>
        String(args.join(' ')).includes('matching segment')
    ) as unknown[];
    assert.ok(purgeHeader, 'purge header call must exist');
    assert.equal(String(purgeHeader[0]), '%c%s%c%s%c%s');
});

test('log part seams are validated so plain output never mashes words', async () => {
    const plainStore: any = { debugOptions: { disableLogStyling: true } };

    // BAD seam: 'purging' + 'paths' would render as 'purgingpaths'.
    const bad = await captureWarnings(() => {
        composeDebugLogArgs(plainStore, [
            { text: '🧹 YASM purging' },
            { text: 'paths matching segment "/tabs/1"' }
        ]);
    });
    assert.equal(bad.length, 1, 'exactly one warning for one bad seam');
    assert.match(bad[0], /mashed together/);
    assert.match(bad[0], /YASM purging/);
    assert.match(bad[0], /paths matching segment/);
    assert.match(bad[0], /g p/); // names the offending junction characters

    // GOOD seams (trailing separator space inside each part) never warn.
    const good = await captureWarnings(() => {
        composeDebugLogArgs(plainStore, [
            { text: '🧹 YASM purging ' },
            { text: 'Filtered ' },
            { text: 'paths matching segment "/tabs/1"' }
        ]);
    });
    assert.equal(good.length, 0, 'clean parts must not warn');

    // The guard also applies to styled output — parts render adjacent there.
    const styled = await captureWarnings(() => {
        composeDebugLogArgs({ debugOptions: {} } as any, [
            { text: 'YASM purging' },
            { text: 'paths matching segment "/tabs/1"' }
        ]);
    });
    assert.equal(styled.length, 1, 'styled mode validates seams too');
});

test('all built-in dev logs stay readable with disableLogStyling', async () => {
    const store = createStore(
        { Tab: tabSection, Cell: cellSection },
        {
            debugOptions: {
                logStateUpdates: true,
                snapshotScope: 'full',
                purgeSnapshotScope: 'full',
                snapshotFilter: { pathFilter: '/tabs/1' },
                timestampFormatter: false,
                disableLogStyling: true
            }
        } as any
    );
    makeStoreSeeded(store);
    init(store, 'Tab', '/tabs/1');

    const warnings = await captureWarnings(async () => {
        store.memo.Tab['/tabs/1'].updater({ title: 'updated' });
        purgeYasmState(store, '/tabs/1');
        await Promise.resolve();
    });

    assert.deepEqual(
        warnings.filter(w => w.includes('mashed together')),
        [],
        `built-in log statements must be readable, got: ${JSON.stringify(warnings)}`
    );
});

test('disableLogStyling emits single plain lines with zero %c anywhere', async () => {
    const store = createStore({ Tab: tabSection, Cell: cellSection }, {
        debugOptions: {
            logStateUpdates: true,
            snapshotScope: 'full',
            purgeSnapshotScope: 'full',
            snapshotFilter: {
                pathFilter: '/tabs/1',
                mode: 'tree'
            },
            timestampFormatter: () => 'TS!',
            disableLogStyling: true
        }
    } as any);
    makeStoreSeeded(store);
    init(store, 'Tab' as any, '/tabs/1' as any);

    const logs = await captureRawDebugLogs(() => {
        store.memo.Tab['/tabs/1'].updater({ title: 'updated' });
        purgeYasmState(store, '/tabs/1');
    });

    // Invariant: not a single %c anywhere, in any call.
    for (const call of logs.capturedArgs) {
        assert.equal(
            call.some(a => typeof a === 'string' && String(a).includes('%c')),
            false,
            'styling must be fully disabled'
        );
    }

    // Update header: one plain line with inline timestamp + badge-less text.
    const updateLine = String(logs.capturedArgs[0][0]);
    assert.match(
        updateLine,
        /^\[TS!\] YASM: updating "Tab" at path "\/tabs\/1"$/
    );

    // Purge header: same treatment.
    const purgeLine = logs.capturedArgs
        .map(args => String(args[0]))
        .find(text => text.includes('🧹'));
    assert.match(
        String(purgeLine),
        /^\[TS!\] 🧹 YASM purging paths matching segment "\/tabs\/1"$/
    );
});
