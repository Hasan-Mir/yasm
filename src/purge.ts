import { isPathWithinPrefix, snapshot } from './util';
import { Name, Path, Store } from './createStore';

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
 * This is a pure (non-hook) function so it can be called from anywhere:
 * event handlers, effects, timeouts, or tests. Inside React components you
 * can use the `usePurgeYasmState` hook, which simply binds this function to
 * the store in context.
 */
const purgeYasmState = (
    store: Store,
    pathPrefix: string,
    options?: PurgeOptions
): void => {
    const matches = (path: Path) =>
        options?.match === 'startsWith'
            ? path.startsWith(pathPrefix)
            : isPathWithinPrefix(path, pathPrefix, store.pathBoundaryChars);

    const shouldLog =
        process.env.NODE_ENV !== 'production' &&
        store.debugOptions.logStateUpdates === true;

    const purgeScope = store.debugOptions.purgeSnapshotScope || 'none';

    if (shouldLog) {
        console.debug(`purging paths matching "${pathPrefix}"`);

        if (purgeScope === 'full') {
            console.debug('before purge:');
            snapshot(store.state, store.debugOptions);
        }
    }

    // NOTE: every section access below is guarded, because a store that was
    // (partially) restored from persistence can contain section names that no
    // longer exist in the current section map (state without matching
    // subscribers/memo records). Unguarded accesses used to crash with
    // "cannot read/delete property of undefined".
    for (const name of Object.keys(store.state) as Name[]) {
        const sectionState = store.state[name] as
            Record<Path, unknown> | undefined;

        if (sectionState === undefined) {
            continue;
        }

        for (const path of Object.keys(sectionState)) {
            if (matches(path)) {
                delete sectionState[path];
            }
        }
    }

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

            const activeCount = Object.keys(sectionSubscribers[path]).length;

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
        }
    }

    for (const name of Object.keys(store.memo) as Name[]) {
        const sectionMemo = store.memo[name] as
            Record<Path, unknown> | undefined;

        if (sectionMemo === undefined) {
            continue;
        }

        for (const path of Object.keys(sectionMemo)) {
            if (matches(path)) {
                delete sectionMemo[path];
            }
        }
    }

    for (const name of Object.keys(store.pathRegistry)) {
        const registeredPaths = store.pathRegistry[name];

        if (registeredPaths === undefined) {
            continue;
        }

        store.pathRegistry[name] = registeredPaths.filter(
            path => !matches(path)
        );
    }

    if (shouldLog) {
        if (purgeScope === 'full') {
            console.debug('after purge:');
            snapshot(store.state, store.debugOptions);
        } else {
            console.debug('purge completed.');
        }
        console.debug('--------');
    }
};

export { purgeYasmState, type PurgeOptions };
