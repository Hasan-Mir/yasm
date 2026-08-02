import { YasmContext } from './Context';
import { deepFreeze, immer, isPathWithinPrefix, snapshot } from './util';
import { useContext, useSyncExternalStore } from 'react';
import {
    Name,
    Path,
    PayloadAndPayloadCreator,
    Section,
    Store
} from './createStore';

type OverrideInitialState<
    SM extends Record<Name, Section>,
    N extends keyof SM
> =
    | Partial<SM[N]['initialState']>
    | ((initialState: SM[N]['initialState']) => Partial<SM[N]['initialState']>);

// Overload 1: Basic use (no selector) or use with a selector
function useYasmState<SM extends Record<Name, Section>, N extends keyof SM, S>(
    name: N,
    path: Path,
    selector?: (state: SM[N]['initialState']) => S
): [
    unknown extends S ? SM[N]['initialState'] : S,
    (payload: PayloadAndPayloadCreator<SM, N>) => SM[N]['initialState'] | void
];

// Overload 2: Use with options object (selector and/or overrideInitialState)
function useYasmState<SM extends Record<Name, Section>, N extends keyof SM, S>(
    name: N,
    path: Path,
    options: {
        selector?: (state: SM[N]['initialState']) => S;
        overrideInitialState?: OverrideInitialState<SM, N>;
    }
): [
    unknown extends S ? SM[N]['initialState'] : S,
    (payload: PayloadAndPayloadCreator<SM, N>) => SM[N]['initialState'] | void
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
    (payload: PayloadAndPayloadCreator<SM, N>) => SM[N]['initialState'] | void
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

    const selectedState = useSyncExternalStore(
        subscribe,
        selector === undefined ? getState : () => selector(getState())
    );

    return [selectedState, updater];
}

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
} => {
    const memo = store.memo[name] as
        | Record<
              Path,
              {
                  subscribe: (callback: () => void) => () => void;
                  getState: () => any;
                  updater: (payload: any) => void;
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

    const state = store.state as Record<Name, Record<Path, any>>;

    const {
        routedName,
        routedPath,
        getState: routedGetState,
        applyPayload
    } = route(store, name as Name, path);

    if (name === routedName) {
        // The state is stored directly (not routed into a parent section).
        if (state[routedName][routedPath] === undefined) {
            const initialState = store.sectionMap[name].initialState;

            const override =
                typeof overrideInitialState === 'function'
                    ? (
                          overrideInitialState as (
                              initialState: SM[N]['initialState']
                          ) => Partial<SM[N]['initialState']>
                      )(initialState)
                    : overrideInitialState;

            let finalInitialState =
                override === undefined
                    ? initialState
                    : { ...initialState, ...override };

            if (process.env.NODE_ENV !== 'production') {
                deepFreeze(finalInitialState);
            }

            state[routedName][routedPath] = finalInitialState;
        }

        if (
            store.sectionMap[name].routing !== undefined &&
            store.pathRegistry[name as Name].indexOf(path) === -1
        ) {
            store.pathRegistry[name as Name].push(path);
        }
    }

    const getState = () => routedGetState();

    const updater = (payload: PayloadAndPayloadCreator<SM, N>) => {
        // These guards make the updater a safe no-op when it fires
        // asynchronously (in a `setTimeout`, a resolved promise, a stale
        // event handler, ...) after the state has been purged, or after a
        // routed element (e.g. an ArraySection row) has been removed.
        if (state[routedName]?.[routedPath] === undefined) {
            return;
        }
        let currentState: any;
        try {
            currentState = getState();
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

        const shouldLog =
            process.env.NODE_ENV !== 'production' &&
            store.debugOptions.logStateUpdates === true;

        const snapshotScope = store.debugOptions?.snapshotScope || 'local';

        if (shouldLog) {
            console.debug(
                `YASM: updating "${routedName}" at path "${routedPath}"`,
                resolvedPayload
            );
            console.debug('before:');

            snapshot(
                snapshotScope === 'full'
                    ? store.state
                    : state[routedName][routedPath],
                store.debugOptions
            );
        }

        state[routedName][routedPath] = applyPayload(resolvedPayload);

        if (shouldLog) {
            console.debug('after:');
            snapshot(
                snapshotScope === 'full'
                    ? store.state
                    : state[routedName][routedPath],
                store.debugOptions
            );
            console.debug('--------');
        }

        const pathSubscribers = (
            store.subscribers as Record<
                Name,
                Record<Path, Record<number, () => void>>
            >
        )[routedName]?.[routedPath];

        if (pathSubscribers !== undefined) {
            // Iterate over a snapshot: callbacks may subscribe/unsubscribe.
            for (const id of Object.keys(pathSubscribers)) {
                const callback = pathSubscribers[id as unknown as number];
                if (callback !== undefined) {
                    callback();
                }
            }
        }
    };

    const record = {
        subscribe: (callback: () => void) =>
            store.subscribe(callback, routedName as keyof SM, routedPath),
        getState,
        updater
    };
    memo[path] = record;
    return record;
};

type RouteStep = { name: Name; path: Path };

/**
 * Computes where the state of `(name, path)` actually lives and returns
 * accessors that read/update it through the routing chain.
 */
const route = (
    store: Store<any>,
    name: Name,
    path: Path
): {
    routedName: Name;
    routedPath: Path;
    getState: () => any;
    applyPayload: (payload: any) => any;
} => {
    const state = store.state as Record<Name, Record<Path, any>>;
    const chain = getExtraRoutes(store, [name], path);

    if (chain === undefined) {
        return {
            routedName: name,
            routedPath: path,
            getState: () => state[name][path],
            applyPayload: payload =>
                immer.produce(state[name][path], (draft: any) =>
                    store.sectionMap[name].updater(draft, payload)
                )
        };
    }

    const steps: RouteStep[] = [...chain, { name, path }];
    const routedName = steps[0].name;
    const routedPath = steps[0].path;

    const getState = () => {
        let currentState: any = state[routedName][routedPath];
        for (let i = 0; i < steps.length - 1; i++) {
            const pathQuery = steps[i + 1].path.slice(steps[i].path.length);
            [currentState] = store.sectionMap[steps[i].name].routing![
                steps[i + 1].name
            ].selectByPathQuery(currentState, pathQuery);
        }
        return currentState;
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

    return { routedName, routedPath, getState, applyPayload };
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
const getExtraRoutes = (
    store: Store<any>,
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
    const parent = candidates[0];
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

export { useYasmState, init, route, getExtraRoutes };
export type { OverrideInitialState };
