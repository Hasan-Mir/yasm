import { YasmContext } from './Context';
import {
    composeDebugLogArgs,
    deepFreeze,
    immer,
    isPathWithinPrefix,
    snapshot,
    snapshotByPrefix
} from './util';
import { useContext, useSyncExternalStore } from 'react';
import {
    Name,
    Path,
    PayloadAndPayloadCreator,
    Section,
    Store,
    SYMBOL_NOTIFY_CHANGE
} from './createStore';

// Dev-only diagnostics: warn ONCE per store when a hook initializes state
// before persistence hydration has finished (see `init`).
const warnedNotHydratedStores = new WeakSet<object>();

/**
 * Overrides applied on top of `initialState` when a path is initialized:
 * either an object merged over the initial state, or a callback receiving
 * the initial state and returning a partial override. Applied only on the
 * *first* initialization of that path — later mounts reuse the memoized
 * record and ignore it.
 */
type OverrideInitialState<
    SM extends Record<Name, Section>,
    N extends keyof SM
> =
    | Partial<SM[N]['initialState']>
    | ((initialState: SM[N]['initialState']) => Partial<SM[N]['initialState']>);

/**
 * Subscribes to the state of section `name` at `path` and returns
 * `[stateOrSelection, updater]`.
 *
 * The state instance is created lazily on first use from the section's
 * `initialState` (optionally amended by `overrideInitialState`). The
 * updater accepts a payload or a payload creator and dispatches through
 * the section's updater with Immer; a no-op update (unchanged reference)
 * skips notifications entirely. Routed paths (e.g. `/users[7]`) read and
 * write inside their parent section's state.
 *
 * ⚠️ Selectors must return stable values for unchanged state — a selector
 * that builds a new object/array on every call re-renders forever under
 * `useSyncExternalStore`. For write-only access use
 * `useYasmStateUpdater(name, path)` instead.
 */
// Overload 1: Basic use (no selector) or use with a selector
function useYasmState<SM extends Record<Name, Section>, N extends keyof SM, S>(
    name: N,
    path: Path,
    selector?: (state: SM[N]['initialState']) => S
): [
    unknown extends S ? SM[N]['initialState'] : S,
    (payload: PayloadAndPayloadCreator<SM, N>) => void
];

// Overload 2: Use with options object (selector and/or overrideInitialState)
function useYasmState<SM extends Record<Name, Section>, N extends keyof SM, S>(
    name: N,
    path: Path,
    options: {
        selector?: (state: SM[N]['initialState']) => S;
        /**
         * Overrides applied on top of `initialState` when the path is
         * initialized (object or callback form; first init only).
         *
         * ⚠️ IMPORTANT — enable `exactOptionalPropertyTypes` in your
         * tsconfig! The object form is a partial override, and under
         * TypeScript's default settings optional properties also accept
         * an *explicit* `undefined`. That means
         * `overrideInitialState: { age: undefined }` compiles even when
         * `age: number`, silently initializing the state with `undefined`.
         * With the flag enabled it becomes a compile-time error, while
         * genuinely nullable fields (`age: number | undefined`) remain
         * assignable.
         */
        overrideInitialState?: OverrideInitialState<SM, N>;
    }
): [
    unknown extends S ? SM[N]['initialState'] : S,
    (payload: PayloadAndPayloadCreator<SM, N>) => void
];

function useYasmState<SM extends Record<Name, Section>, N extends keyof SM, S>(
    name: N,
    path: Path,
    thirdParam?:
        | ((state: SM[N]['initialState']) => S)
        | {
              selector?: (state: SM[N]['initialState']) => S;
              overrideInitialState?: OverrideInitialState<SM, N>;
          }
): [
    unknown extends S ? SM[N]['initialState'] : S,
    (payload: PayloadAndPayloadCreator<SM, N>) => void
] {
    const store = useContext(YasmContext) as Store<SM> | undefined;

    if (store === undefined) {
        throw new Error(
            'YASM: no store was found in the React context. Wrap your component tree in <YasmContext.Provider value={store}>.'
        );
    }

    let selector: ((state: SM[N]['initialState']) => S) | undefined;
    let overrideInitialState: OverrideInitialState<SM, N> | undefined;

    if (typeof thirdParam === 'function') {
        selector = thirdParam;
    } else if (thirdParam && typeof thirdParam === 'object') {
        selector = thirdParam.selector;
        overrideInitialState = thirdParam.overrideInitialState;
    }

    const { subscribe, getState, updater } = init(
        store,
        name,
        path,
        overrideInitialState
    );

    const getSnapshot =
        selector === undefined ? getState : () => selector(getState());

    const selectedState = useSyncExternalStore(
        subscribe,
        getSnapshot,
        getSnapshot
    );

    return [selectedState, updater];
}

/**
 * A specialized hook that returns only the updater function for the state
 * at `(name, path)` without subscribing the calling component to it.
 *
 * Unlike `useYasmState(name, path, () => null)` — which stays subscribed and
 * merely bails out of re-rendering — this creates no subscription at all:
 * the store's notification loop never touches the component, so it never
 * re-renders. Ideal for components that only dispatch (buttons, submit
 * handlers, background savers).
 */
function useYasmStateUpdater<
    SM extends Record<Name, Section>,
    N extends keyof SM
>(name: N, path: Path): (payload: PayloadAndPayloadCreator<SM, N>) => void {
    const store = useContext(YasmContext) as Store<SM> | undefined;

    if (store === undefined) {
        throw new Error(
            'YASM: no store was found in the React context. Wrap your component tree in <YasmContext.Provider value={store}>.'
        );
    }

    return init(store, name, path).updater;
}

type RebindRoutingResult = {
    oldRoutedName: Name;
    oldRoutedPath: Path;
    newRoutedName: Name;
    newRoutedPath: Path;
};

/**
 * Initializes the state of `(name, path)` (when needed) and returns the
 * memoized `{ subscribe, getState, updater }` record for it.
 *
 * Exported for advanced/manual usage and tests; components should normally
 * use the `useYasmState` hook.
 */
const init = <SM extends Record<Name, Section>, N extends keyof SM>(
    store: Store<SM>,
    name: N,
    path: Path,
    overrideInitialState?: OverrideInitialState<SM, N>
): {
    subscribe: (callback: () => void) => () => void;
    getState: () => SM[N]['initialState'];
    updater: (payload: PayloadAndPayloadCreator<SM, N>) => void;
    rebindRouting: () => RebindRoutingResult | undefined;
} => {
    const memo = store.memo[name] as
        | Record<
              Path,
              {
                  subscribe: (callback: () => void) => () => void;
                  getState: () => any;
                  updater: (payload: any) => void;
                  rebindRouting: () => RebindRoutingResult | undefined;
              }
          >
        | undefined;

    if (memo === undefined) {
        throw new Error(
            `YASM: unknown section "${name.toString()}". Make sure it is registered in createStore().`
        );
    }

    const existingRecord = memo[path];
    if (existingRecord !== undefined) {
        return existingRecord;
    }

    // 🛡️ Dev-time diagnostics: a hook ran while persistence hydration was
    // still in flight. This is SAFE (a post-hydration notification pass
    // pushes merged values into mounted components), but it means the
    // component first renders default state, `overrideInitialState` is
    // clobbered by persisted data, and an extra render happens. Gating the
    // tree on `store.isHydrated()` avoids all of that. Warn once per store.
    if (
        process.env.NODE_ENV !== 'production' &&
        !warnedNotHydratedStores.has(store) &&
        !store.isHydrated()
    ) {
        warnedNotHydratedStores.add(store);
        console.warn(
            [
                'YASM [Warning]: a hook initialized state BEFORE store.hydrate() finished.',
                'This works (persisted values are merged into mounted components when hydration lands), but:',
                '  1. the component first renders the default initialState, then re-renders with hydrated data,',
                '  2. overrideInitialState applied now is discarded in favor of persisted data,',
                '  3. updates dispatched before hydration cannot trigger autosave.',
                'Prefer gating your tree on hydration: await store.hydrate() and render children only afterwards',
                '(store.isHydrated() tells you when it is safe).'
            ].join('\n')
        );
    }

    const state = store.state as Record<Name, Record<Path, any>>;

    const initialRoute = route(store, name as Name, path);

    if (name === initialRoute.routedName) {
        // The state is stored directly (not routed into a parent section).
        if (
            state[initialRoute.routedName][initialRoute.routedPath] ===
            undefined
        ) {
            const initialState = store.sectionMap[name].initialState;

            const override =
                typeof overrideInitialState === 'function'
                    ? (
                          overrideInitialState as (
                              initialState: SM[N]['initialState']
                          ) => Partial<SM[N]['initialState']>
                      )(initialState)
                    : overrideInitialState;

            const finalInitialState =
                override === undefined
                    ? initialState
                    : Array.isArray(initialState)
                      ? Array.isArray(override)
                          ? [...override]
                          : [...initialState]
                      : typeof initialState === 'object' &&
                          initialState !== null
                        ? { ...initialState, ...override }
                        : override;

            if (process.env.NODE_ENV !== 'production') {
                deepFreeze(finalInitialState);
            }

            state[initialRoute.routedName][initialRoute.routedPath] =
                finalInitialState;
        }
    }

    // Register every routing section instance, including sections routed
    // through another routing parent. The registry is required for resolving
    // deeper multi-level composition chains (e.g. Table → Row → Profile).
    if (
        store.sectionMap[name].routing !== undefined &&
        store.pathRegistry[name as Name].indexOf(path) === -1
    ) {
        store.pathRegistry[name as Name].push(path);
    }

    // `activeRoute` is the memo's current physical route.
    // Any routing-topology change that can affect this memo must go through
    // `rebindRouting()` so `activeRoute` and its active subscriptions stay in sync.
    let activeRoute = initialRoute;

    const getState = () => activeRoute.getState();

    const updater = (payload: PayloadAndPayloadCreator<SM, N>) => {
        const {
            routedName,
            routedPath,
            getStateUnsafe: routedGetStateUnsafe,
            applyPayload
        } = activeRoute;

        // These guards make the updater a safe no-op when it fires
        // asynchronously (in a `setTimeout`, a resolved promise, a stale
        // event handler, ...) after the state has been purged, or after a
        // routed element (e.g. an ArraySection row) has been removed.
        if (state[routedName]?.[routedPath] === undefined) {
            return;
        }
        let currentState: any;
        try {
            // Use the RAW (throwing) resolver here: a vanished routed element
            // must turn the whole update into a no-op, not proceed against
            // the reader's stale last-known snapshot.
            currentState = routedGetStateUnsafe();
        } catch {
            return;
        }
        if (currentState === undefined) {
            return;
        }

        const resolvedPayload =
            typeof payload === 'function'
                ? (payload as (state: any) => any)(currentState)
                : payload;

        const nextState = applyPayload(resolvedPayload);

        // Reference equality check: If immer returns the exact same object,
        // it means no mutations occurred. We should abort to prevent notification/save churn.
        if (nextState === state[routedName][routedPath]) {
            return;
        }

        let shouldLog = false;
        if (
            process.env.NODE_ENV !== 'production' &&
            store.debugOptions.logStateUpdates
        ) {
            if (typeof store.debugOptions.logStateUpdates === 'function') {
                shouldLog = store.debugOptions.logStateUpdates({
                    type: 'update',
                    sectionName: routedName as keyof SM,
                    path: routedPath,
                    payload: resolvedPayload
                });
            } else {
                shouldLog = store.debugOptions.logStateUpdates === true;
            }
        }

        const snapshotScope = store.debugOptions?.snapshotScope || 'local';
        const isFilteredLog =
            typeof store.debugOptions.logStateUpdates === 'function';

        // When `debugOptions.snapshotFilter` is configured, full-store debug
        // snapshots are scoped down to the matching subtree/sections instead
        // of serializing the entire `store.state` (see `snapshotByPrefix`).
        // 'local' snapshots are already tiny and stay untouched.
        const resolveLoggedState = () => {
            const { snapshotFilter } = store.debugOptions;

            if (
                snapshotScope === 'full' &&
                snapshotFilter !== undefined &&
                (snapshotFilter.pathFilter !== undefined ||
                    snapshotFilter.sectionFilter !== undefined)
            ) {
                // Conditional spread — see the note in purge.ts about
                // `exactOptionalPropertyTypes` and the `sectionFilter`
                // widening/cast rationale (runtime-safe: the filter is only
                // compared against `Object.keys(store.state)`).
                return snapshotByPrefix(
                    store,
                    snapshotFilter.pathFilter ?? '',
                    {
                        ...(snapshotFilter.mode !== undefined
                            ? { mode: snapshotFilter.mode }
                            : {}),
                        ...(snapshotFilter.match !== undefined
                            ? { match: snapshotFilter.match }
                            : {}),
                        ...(snapshotFilter.sectionFilter !== undefined
                            ? {
                                  sectionFilter:
                                      snapshotFilter.sectionFilter as
                                          keyof SM | (keyof SM)[]
                              }
                            : {})
                    }
                );
            }
            return snapshotScope === 'full'
                ? store.state
                : state[routedName][routedPath];
        };

        if (shouldLog) {
            const badgeStyle =
                'background: #0d9488; color: white; padding: 2px 6px; border-radius: 4px; font-weight: bold;';

            if (isFilteredLog) {
                console.debug(
                    ...composeDebugLogArgs(store, [
                        { text: 'YASM (Filtered)', style: badgeStyle },
                        {
                            text: ` updating "${String(routedName)}" at path "${routedPath}"`
                        }
                    ])
                );
                console.debug(resolvedPayload);
            } else {
                console.debug(
                    ...composeDebugLogArgs(store, [
                        {
                            text: `YASM: updating "${String(routedName)}" at path "${routedPath}"`
                        }
                    ])
                );
                console.debug(resolvedPayload);
            }

            console.debug(...composeDebugLogArgs(store, [{ text: 'Before:' }]));

            snapshot(resolveLoggedState(), store);
        }

        state[routedName][routedPath] = nextState;

        // 🔒 Trigger internal notifications (auto-save and change listeners)
        store[SYMBOL_NOTIFY_CHANGE]();

        if (shouldLog) {
            console.debug(...composeDebugLogArgs(store, [{ text: 'After:' }]));
            snapshot(resolveLoggedState(), store);
            console.debug('--------');
        }

        const pathSubscribers = (
            store.subscribers as Record<
                Name,
                Record<Path, Record<number, () => void>>
            >
        )[routedName]?.[routedPath];

        if (pathSubscribers !== undefined) {
            for (const id of Object.keys(pathSubscribers)) {
                const callback = pathSubscribers[id as unknown as number];
                if (callback !== undefined) {
                    // 🔒 Isolate subscriber exceptions: one throwing callback
                    // must not abort notification of the remaining ones.
                    // This loop also reaches raw `store.subscribe` callbacks,
                    // whose errors would otherwise silently break the update
                    // fan-out for everyone else on this path.
                    try {
                        callback();
                    } catch (error) {
                        console.error(
                            'YASM: a subscriber callback threw an exception. The error is isolated so other subscribers are still notified.',
                            error
                        );
                    }
                }
            }
        }
    };

    type ActiveSubscription = {
        callback: () => void;
        unsubscribe: () => void;
    };

    const activeSubscriptions = new Set<ActiveSubscription>();

    const subscribe = (callback: () => void) => {
        const subscription: ActiveSubscription = {
            callback,
            unsubscribe: store.subscribe(
                callback,
                activeRoute.routedName as keyof SM,
                activeRoute.routedPath
            )
        };

        activeSubscriptions.add(subscription);

        return () => {
            if (!activeSubscriptions.delete(subscription)) {
                return;
            }

            subscription.unsubscribe();
        };
    };

    /**
     * Re-resolves this memo's physical route after routing topology changes.
     * Updates `activeRoute`, rebinds active subscriptions, and removes stale
     * direct-storage fallback state when the memo becomes routed.
     */
    const rebindRouting = () => {
        const nextRoute = route(store, name as Name, path);

        if (
            nextRoute.routedName === activeRoute.routedName &&
            nextRoute.routedPath === activeRoute.routedPath
        ) {
            return undefined;
        }

        const oldRoutedName = activeRoute.routedName;
        const oldRoutedPath = activeRoute.routedPath;

        for (const subscription of Array.from(activeSubscriptions)) {
            subscription.unsubscribe();

            subscription.unsubscribe = store.subscribe(
                subscription.callback,
                nextRoute.routedName as keyof SM,
                nextRoute.routedPath
            );
        }

        activeRoute = nextRoute;

        // A direct-storage fallback entry that becomes routed is no longer a
        // physical state slot. Remove that stale fallback copy.
        if (
            oldRoutedName === name &&
            oldRoutedPath === path &&
            (nextRoute.routedName !== name || nextRoute.routedPath !== path)
        ) {
            delete state[oldRoutedName]?.[oldRoutedPath];
        }

        return {
            oldRoutedName,
            oldRoutedPath,
            newRoutedName: nextRoute.routedName,
            newRoutedPath: nextRoute.routedPath
        };
    };

    const record = {
        subscribe,
        getState,
        updater,
        rebindRouting
    };
    memo[path] = record;
    return record;
};

/**
 * Scans active memo records within an affected path prefix and rebinds their
 * routing accessors and subscriptions to newly registered parent routes.
 *
 * This handles the edge case where a routed child hook (e.g. `Row` at `/table[5]`)
 * initialized before its routing parent (`Table` at `/table`) was registered,
 * causing the child to fall back to direct unrouted storage.
 *
 * When an operation (such as `cloneSubtree`) registers missing parent paths:
 * 1. Evaluates each matching memo record against the latest routing plan.
 * 2. If a new parent route is discovered, migrates active listeners to the
 *    new physical storage location in `store.subscribers`.
 * 3. Removes stale fallback state from direct storage to prevent ghost copies.
 * 4. Switches the memo's active route reference so subsequent reads (`getState`)
 *    and writes (`updater`) dispatch directly through the parent section.
 */
const rebindRoutedMemos = <SM extends Record<Name, Section>>(
    store: Store<SM>,
    targetPrefix?: string
): RebindRoutingResult[] => {
    const changes: RebindRoutingResult[] = [];

    const memoByName = store.memo;

    for (const sectionName of Object.keys(memoByName) as Name[]) {
        const records = memoByName[sectionName];

        for (const path of Object.keys(records)) {
            if (
                targetPrefix !== undefined &&
                !isPathWithinPrefix(path, targetPrefix, store.pathBoundaryChars)
            ) {
                continue;
            }

            const rebindRouting = records[path]?.rebindRouting;

            if (rebindRouting === undefined) {
                continue;
            }

            const change = rebindRouting();

            if (change !== undefined) {
                changes.push(change);
            }
        }
    }

    return changes;
};

type RouteStep = { name: Name; path: Path };

/**
 * Computes where the state of `(name, path)` actually lives and returns
 * accessors that read/update it through the routing chain.
 */
const route = <SM extends Record<Name, Section>>(
    store: Store<SM>,
    name: Name,
    path: Path
): {
    routedName: Name;
    routedPath: Path;
    getState: () => any;
    /** Raw (throwing) resolver used by the updater's own guard. */
    getStateUnsafe: () => any;
    applyPayload: (payload: any) => any;
    applyReplacement: (replacement: any) => any;
} => {
    const state = store.state as Record<Name, Record<Path, any>>;
    const chain = getExtraRoutes(store, [name], path);

    if (chain === undefined) {
        return {
            routedName: name,
            routedPath: path,
            getState: () => state[name][path],
            getStateUnsafe: () => state[name][path],
            applyPayload: payload =>
                immer.produce(state[name][path], (draft: any) =>
                    store.sectionMap[name].updater(draft, payload)
                ),
            applyReplacement: (replacement: any) => replacement
        };
    }

    const steps: RouteStep[] = [...chain, { name, path }];
    const routedName = steps[0].name;
    const routedPath = steps[0].path;

    const resolveRoutedState = (): any => {
        let currentState: any = state[routedName][routedPath];
        for (let i = 0; i < steps.length - 1; i++) {
            const pathQuery = steps[i + 1].path.slice(steps[i].path.length);
            [currentState] = store.sectionMap[steps[i].name].routing![
                steps[i + 1].name
            ].selectByPathQuery(currentState, pathQuery);
        }
        return currentState;
    };

    // Lifecycle safety for READERS: a routed element can disappear while a
    // component is still subscribed to it (e.g. an ArraySection row removed
    // through its parent). The generators' `selectByPathQuery` throws in that
    // case, and `useSyncExternalStore` calls this getter during render — an
    // unguarded throw there crashes the React tree.
    //
    // Semantics (deliberately asymmetric with the raw resolver below):
    //  - A record that HAS resolved successfully before returns its LAST KNOWN
    //    value when resolution starts failing (stable reference → no
    //    getSnapshot churn; stale-until-unmount, matching the updater's
    //    "safe no-op" philosophy).
    //  - A record that NEVER resolved keeps the historical fail-fast behavior
    //    so genuine routing misconfigurations (malformed or never-existing
    //    paths) surface immediately instead of being masked by defaults.
    let lastKnownState: any;

    const getState = (): any => {
        try {
            const resolved = resolveRoutedState();
            if (resolved !== undefined) {
                lastKnownState = resolved;
            }
            return resolved;
        } catch (error) {
            if (lastKnownState !== undefined) {
                return lastKnownState;
            }
            throw error;
        }
    };

    const applyPayload = (payload: any) => {
        const update = (stepIndex: number, subState: any): any => {
            if (stepIndex === steps.length - 1) {
                return immer.produce(subState, (draft: any) =>
                    store.sectionMap[steps[stepIndex].name].updater(
                        draft,
                        payload
                    )
                );
            }
            const pathQuery = steps[stepIndex + 1].path.slice(
                steps[stepIndex].path.length
            );
            return store.sectionMap[steps[stepIndex].name].routing![
                steps[stepIndex + 1].name
            ].updateByPathQuery(subState, pathQuery, (innerState: any) =>
                update(stepIndex + 1, innerState)
            );
        };
        return update(0, state[routedName][routedPath]);
    };

    const applyReplacement = (replacement: any): any => {
        if (chain === undefined) {
            return replacement;
        }
        const update = (stepIndex: number, subState: any): any => {
            if (stepIndex === steps.length - 1) {
                return replacement;
            }
            const pathQuery = steps[stepIndex + 1].path.slice(
                steps[stepIndex].path.length
            );
            return store.sectionMap[steps[stepIndex].name].routing![
                steps[stepIndex + 1].name
            ].updateByPathQuery(subState, pathQuery, (innerState: any) =>
                update(stepIndex + 1, innerState)
            );
        };
        return update(0, state[routedName][routedPath]);
    };

    return {
        routedName,
        routedPath,
        getState,
        // Raw (throwing) resolver — used by the updater, whose own try/catch
        // turns resolution failures into safe no-ops.
        getStateUnsafe: resolveRoutedState,
        applyPayload,
        applyReplacement
    };
};

/**
 * Resolves the chain of parent sections that a routed `path` belongs to.
 *
 * Returns the chain from the outermost (actually stored) section down to the
 * immediate parent of the requested path, or `undefined` when the path is
 * stored directly (not routed).
 *
 * `allNames[0]` is the section currently being resolved; the rest of the
 * array is only used as a circular-routing guard.
 *
 * NOTE: matching between the requested path and registered parent paths is
 * segment-aware (`isPathWithinPrefix`). A plain `startsWith` check used to
 * hijack routing between sibling paths such as `/t` and `/t2`, or `/tabs/1`
 * and `/tabs/10`.
 */
const getExtraRoutes = <SM extends Record<Name, Section>>(
    store: Store<SM>,
    allNames: Name[],
    path: Path
): RouteStep[] | undefined => {
    const currentName = allNames[0];
    const parentNames = (store.routingPlan as Record<Name, Name[]>)[
        currentName
    ];
    if (parentNames === undefined) {
        return undefined;
    }
    const candidates: RouteStep[] = [];
    for (const parentName of parentNames) {
        const registeredPaths = store.pathRegistry[parentName] ?? [];
        for (const registeredPath of registeredPaths) {
            if (
                registeredPath !== path &&
                isPathWithinPrefix(
                    path,
                    registeredPath,
                    store.pathBoundaryChars
                )
            ) {
                candidates.push({ name: parentName, path: registeredPath });
            }
        }
    }
    if (candidates.length === 0) {
        return undefined;
    }
    if (process.env.NODE_ENV !== 'production' && candidates.length > 1) {
        console.error(
            [
                'YASM: multiple routing candidates found. Registered routing paths must not be nested within each other (one path cannot be a segment-prefix of another).',
                `section: "${currentName}", path: "${path}"`,
                `candidates: ${JSON.stringify(candidates)}`
            ].join('\n')
        );
    }
    // Pick the CLOSEST registered ancestor (the longest matching prefix)
    // rather than whichever happened to be registered first. `pathRegistry`
    // ordering is not stable across sessions — after hydration live entries
    // precede restored ones — so `candidates[0]` could resolve the same routed
    // path through a different parent before and after a reload whenever two
    // matching parent paths are nested. Ties keep the first candidate.
    let parent = candidates[0];
    for (const candidate of candidates) {
        if (candidate.path.length > parent.path.length) {
            parent = candidate;
        }
    }
    if (allNames.indexOf(parent.name) !== -1) {
        // Circular routing guard: stop resolving instead of recursing forever.
        return [parent];
    }
    const parentChain = getExtraRoutes(
        store,
        [parent.name, ...allNames],
        parent.path
    );
    return parentChain === undefined ? [parent] : [...parentChain, parent];
};

export {
    useYasmState,
    useYasmStateUpdater,
    init,
    route,
    getExtraRoutes,
    rebindRoutedMemos
};
export type { OverrideInitialState, RebindRoutingResult };
