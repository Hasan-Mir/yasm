import { useContext, useSyncExternalStore } from 'react';
import { YasmContext } from './Context';
import { Name, Section, Store, type HydrationResult } from './createStore';

/**
 * Reads the observable hydration lifecycle of the YASM store found in the
 * React context (or an explicitly passed store) and returns a stable
 * `HydrationResult` snapshot.
 *
 * Integrates with `useSyncExternalStore`: the component re-renders the moment
 * the hydration status transitions (`'idle' → 'hydrating' → 'hydrated'`,
 * `'quarantined'`, or `'failed'`), so gating a splash screen on hydration
 * needs no `useEffect` + `store.hydrate().finally(...)` boilerplate.
 *
 * @example
 * const { status } = useHydration();
 * return status === 'hydrated' ? children : <Splash />;
 */
const useHydration = <SM extends Record<Name, Section> = Record<Name, Section>>(
    store?: Store<SM>
): HydrationResult => {
    const contextStore = useContext(YasmContext) as Store<SM> | undefined;
    const storeFromContext = store ?? contextStore;

    if (storeFromContext === undefined) {
        throw new Error(
            'YASM: no store was found in the React context. Wrap your component tree in <YasmContext.Provider value={store}> or pass the store explicitly to useHydration(store).'
        );
    }

    return useSyncExternalStore(
        storeFromContext.subscribeHydration,
        storeFromContext.getHydrationSnapshot,
        storeFromContext.getHydrationSnapshot
    );
};

export { useHydration };
