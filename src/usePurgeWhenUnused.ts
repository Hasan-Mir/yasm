import { YasmContext } from './Context';
import { useCallback, useContext } from 'react';
import { PurgeOptions } from './purge';

/**
 * Returns a stable `purgeWhenUnused(pathPrefix, options?)` function bound to
 * the store found in context — the lifecycle-safe counterpart of
 * `usePurgeYasmState`.
 *
 * The scheduled purge executes after the last subscriber of every matching
 * path unsubscribes (or immediately when nothing is subscribed at call
 * time), re-verifying live subscribers at fire time so revived paths with
 * mounted readers are never wiped. The destructive pass runs on the next
 * task after that last unsubscription (with a second live-subscriber check),
 * so React flushes that synchronously detach/reattach subtrees — StrictMode
 * double effects, concurrent transitions — cannot lose state in between.
 *
 * ⚠️ Detection is subscription-based: a path recreated purely through
 * write-only hooks (`useYasmStateUpdater`) between scheduling and firing is
 * invisible to the re-verification. Pending purges are persisted and
 * re-scheduled on the next hydration.
 * See `Store['purgeWhenUnused']` and the README's purging chapter for the
 * full contract.
 */
const usePurgeWhenUnused = () => {
    const store = useContext(YasmContext);

    if (store === undefined) {
        throw new Error(
            'YASM: no store was found in the React context. Wrap your component tree in <YasmContext.Provider value={store}>.'
        );
    }

    return useCallback(
        (pathPrefix: string | string[], options?: PurgeOptions) =>
            store.purgeWhenUnused(pathPrefix, options),
        [store]
    );
};

export { usePurgeWhenUnused };
