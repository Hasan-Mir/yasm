import { isPathWithinPrefix, snapshot } from './util';
import {
    SYMBOL_NOTIFY_CHANGE,
    SYMBOL_NOTIFY_FORCED_UNSUBSCRIBE,
    Name,
    Path,
    Store,
    Section
} from './createStore';

type PurgeOptions = {
    /**
     * How `pathPrefix` is matched against stored paths:
     *
     * - `'segment'` (default): `'/tabs/1'` matches `'/tabs/1'`, `'/tabs/1/x'`
     *   and `'/tabs/1[0]'` but NOT `'/tabs/10'`.
     * - `'startsWith'`: raw `String.prototype.startsWith` matching (the
     *   pre-0.1.0 behavior). `'/tabs/1'` also matches `'/tabs/10'`.
     */
    match?: 'segment' | 'startsWith';
};

/**
 * Removes every state, subscriber record, memoized hook plumbing and path
 * registration whose path matches `pathPrefix`.
 *
 * Accepts a single prefix or an array of prefixes (each is processed
 * independently, in order).
 *
 * This is a pure (non-hook) function so it can be called from anywhere:
 * event handlers, effects, timeouts, or tests. Inside React components you
 * can use the `usePurgeYasmState` hook, which simply binds this function to
 * the store in context.
 */
const purgeYasmState = <SM extends Record<Name, Section>>(
    store: Store<SM>,
    pathPrefix: string | string[],
    options?: PurgeOptions
): void => {
    const prefixes = Array.isArray(pathPrefix) ? pathPrefix : [pathPrefix];

    for (const prefix of prefixes) {
        purgePathsWithinPrefix(store, prefix, options);
    }
};

const purgePathsWithinPrefix = <SM extends Record<Name, Section>>(
    store: Store<SM>,
    pathPrefix: string,
    options?: PurgeOptions
): void => {
    const matches = (path: Path) =>
        options?.match === 'startsWith'
            ? path.startsWith(pathPrefix)
            : isPathWithinPrefix(path, pathPrefix, store.pathBoundaryChars);

    let shouldLog = false;
    if (
        process.env.NODE_ENV !== 'production' &&
        store.debugOptions.logStateUpdates
    ) {
        if (typeof store.debugOptions.logStateUpdates === 'function') {
            shouldLog = store.debugOptions.logStateUpdates({
                type: 'purge',
                pathPrefix: pathPrefix
            });
        } else {
            shouldLog = store.debugOptions.logStateUpdates === true;
        }
    }

    let isStateChanged = false;
    const purgeScope = store.debugOptions.purgeSnapshotScope || 'none';
    const purgedPaths = shouldLog ? new Set<string>() : null;
    const isFilteredLog =
        typeof store.debugOptions.logStateUpdates === 'function';

    if (shouldLog) {
        const matchTypeStr =
            options?.match === 'startsWith'
                ? 'starting with'
                : 'matching segment';

        if (isFilteredLog) {
            console.debug(
                `%cYASM (Filtered)%c purging paths ${matchTypeStr} "${pathPrefix}"`,
                'background: #0d9488; color: white; padding: 2px 6px; border-radius: 4px; font-weight: bold;',
                'color: inherit;'
            );
        } else {
            console.debug(
                `YASM: purging paths ${matchTypeStr} "${pathPrefix}"`
            );
        }

        if (purgeScope === 'full') {
            console.debug('before purge:');
            snapshot(store.state, store);
        }
    }

    // NOTE: every section access below is guarded, because a store that was
    // (partially) restored from persistence can contain section names that no
    // longer exist in the current section map (state without matching
    // subscribers/memo records). Unguarded accesses used to crash with
    // "cannot read/delete property of undefined".

    // 1. Remove the actual data values from the state
    for (const name of Object.keys(store.state) as Name[]) {
        const sectionState = store.state[name] as
            Record<Path, unknown> | undefined;

        if (sectionState === undefined) {
            continue;
        }

        for (const path of Object.keys(sectionState)) {
            if (matches(path)) {
                delete sectionState[path];
                purgedPaths?.add(path);
                isStateChanged = true;
            }
        }
    }

    // 2. Remove active subscriptions and warn if components are still mounted
    for (const name of Object.keys(store.subscribers) as Name[]) {
        const sectionSubscribers = store.subscribers[name] as
            Record<Path, Record<number, () => void>> | undefined;

        if (sectionSubscribers === undefined) {
            continue;
        }

        for (const path of Object.keys(sectionSubscribers)) {
            if (!matches(path)) {
                continue;
            }

            // Re-read the record defensively: a pending purge fired by the
            // forced-unsubscribe notification below can run a nested purge
            // that already deleted this record mid-loop.
            const record = sectionSubscribers[path];
            if (record === undefined) {
                continue;
            }

            const activeCount = Object.keys(record).length;

            if (activeCount > 0) {
                console.warn(
                    [
                        `YASM [Warning]: The state of "${name}" at path "${path}" is being purged while ${activeCount} subscriber(s) (components reading this state) are still mounted!`,
                        'Their state will be re-initialized on their next render, which may cause unexpected UI resets.',
                        'Ensure that the purge occurs after all dependent components are unmounted (e.g. by scheduling it with "useEffect" + "setTimeout"), and check your purge path prefixes for accidental overlaps.'
                    ].join('\n')
                );
            }

            delete sectionSubscribers[path];
            purgedPaths?.add(path);

            // 🧹 The record was removed without a normal unsubscribe — let
            // any deferred `purgeWhenUnused` waiting on this path reconcile
            // its bookkeeping (and fire if it was the last tracked key).
            store[SYMBOL_NOTIFY_FORCED_UNSUBSCRIBE](name, path);
        }
    }

    // 3. Remove memoized hook configurations and cached plumbing
    for (const name of Object.keys(store.memo) as Name[]) {
        const sectionMemo = store.memo[name] as
            Record<Path, unknown> | undefined;

        if (sectionMemo === undefined) {
            continue;
        }

        for (const path of Object.keys(sectionMemo)) {
            if (matches(path)) {
                delete sectionMemo[path];
                purgedPaths?.add(path);
            }
        }
    }

    // 4. Remove the matched paths from the internal tracking registry
    for (const name of Object.keys(store.pathRegistry)) {
        const registeredPaths = store.pathRegistry[name];

        if (registeredPaths === undefined) {
            continue;
        }

        store.pathRegistry[name] = registeredPaths.filter(path => {
            if (matches(path)) {
                purgedPaths?.add(path);
                isStateChanged = true;
                return false;
            }
            return true;
        });
    }

    // 🔒 Notify the store to trigger persistence and listeners if data was actually purged
    if (isStateChanged) {
        store[SYMBOL_NOTIFY_CHANGE]();
    }

    if (shouldLog) {
        console.debug(
            `purge completed. Removed ${purgedPaths?.size} paths:`,
            Array.from(purgedPaths || [])
        );

        if (purgeScope === 'full') {
            console.debug('after purge:');
            snapshot(store.state, store);
        }

        console.debug('--------');
    }
};

export { purgeYasmState, type PurgeOptions };
