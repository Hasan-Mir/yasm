type Name = string;
type Path = string;

type Updater<S = any, P = any> = (state: S, payload: P) => S | void;

type PayloadAndPayloadCreator<
    SM extends Record<Name, Section>,
    N extends keyof SM
> =
    | Parameters<SM[N]['updater']>[1]
    | ((state: SM[N]['initialState']) => Parameters<SM[N]['updater']>[1]);

type Router<S = any, NS = any> = {
    selectByPathQuery: (
        state: S,
        pathQuery: string
    ) => [state: NS, pathQuery: string];
    updateByPathQuery: (
        state: S,
        pathQuery: string,
        getValue: (state: NS, pathQuery: string) => NS
    ) => S;
};

type Routing<S = any> = Record<Name, Router<S>>;

type StateBySectionMap<SM extends Record<Name, Section>> = {
    [name in keyof SM]: Record<Path, SM[name]['initialState']>;
};

type SubscribersBySectionMap<SM extends Record<Name, Section>> = {
    [name in keyof SM]: Record<Path, Record<number, () => void>>;
};

type RoutingPlan<SM extends Record<Name, Section>> = {
    [name in keyof SM]: Name[];
};

type Memo<SM extends Record<Name, Section>> = {
    [name in keyof SM]: Record<
        Path,
        {
            subscribe: (callback: () => void) => () => void;
            getState: () => SM[name]['initialState'];
            updater: (payload: PayloadAndPayloadCreator<SM, name>) => void;
        }
    >;
};

type Section<S = any, P = any> = {
    initialState: S;
    updater: Updater<S, P>;
    routing?: Routing<S>;
};

type DebugOptions = {
    /**
     * When `true` (and `process.env.NODE_ENV !== 'production'`), YASM logs
     * state changes during updates and purges.
     *
     * Note: Depending on your `snapshotScope` and
     * `purgeSnapshotScope` settings, logging can serialize large parts of
     * the store, which may cause performance overhead in development.
     *
     * @default false
     */
    logStateUpdates?: boolean;

    /**
     * Determines the scope of the state snapshot when `logStateUpdates` is enabled
     * during state updates.
     *
     * - `'local'` (Default): Snapshots only the specific section and path being updated.
     *   Highly recommended for performance, as it minimizes the serialization overhead.
     * - `'full'`: Snapshots the entire global store state. Useful for debugging complex
     *   issues where you need to see the complete application state, but may cause
     *   significant performance overhead in large applications.
     *
     * @default 'local'
     */
    snapshotScope?: 'full' | 'local';

    /**
     * Determines the scope of the state snapshot when a `purge` operation occurs
     * (and `logStateUpdates` is enabled).
     *
     * - `'none'` (Default): Logs a simple text confirmation without taking any
     *   state snapshots. Highly recommended to maintain optimal performance.
     * - `'full'`: Snapshots the entire global store state before and after the purge.
     *   Useful for deep debugging but introduces heavy serialization overhead.
     *
     * @default 'none'
     */
    purgeSnapshotScope?: 'none' | 'full';

    /**
     * A custom serializer function used when generating state snapshots for logging.
     * Useful for handling data types that do not natively serialize well (e.g., Date, BigInt, Decimal).
     */
    serializer?: (
        object: Record<string, unknown>,
        key: string,
        value: unknown
    ) => any;

    /**
     * A custom deserializer function used when parsing state snapshots.
     * Pairs with the `serializer` to reconstruct complex data types from the log output.
     */
    deserializer?: (key: string, value: string) => any;
};

type Store<SM extends Record<Name, Section> = Record<Name, Section>> = {
    state: StateBySectionMap<SM>;
    subscribers: SubscribersBySectionMap<SM>;
    sectionMap: SM;
    subscribe: (callback: () => void, name: keyof SM, path: Path) => () => void;
    pathRegistry: Record<Name, Path[]>;
    routingPlan: RoutingPlan<SM>;
    memo: Memo<SM>;
    debugOptions: DebugOptions;
    /**
     * Characters that mark the start of a new segment inside a YASM path,
     * e.g. `/tabs/1` (`/`), `/table[3]` (`[`), `/form.field` (`.`).
     */
    pathBoundaryChars: string[];
};

const DEFAULT_PATH_BOUNDARY_CHARS = ['/', '[', '.'];

type StoreOptions = {
    debugOptions?: DebugOptions;

    /**
     * Characters that mark the start of a new segment inside a YASM path,
     * e.g. `/tabs/1` (`/`), `/table[3]` (`[`), `/form.field` (`.`).
     */
    pathBoundaryChars?:
        string[] | ((defaultPathBoundaryChars: string[]) => string[]);
};

const createStore = <SM extends Record<Name, Section>>(
    sectionMap: SM,
    options?: StoreOptions
): Store<SM> => {
    let boundaryChars = DEFAULT_PATH_BOUNDARY_CHARS;
    if (typeof options?.pathBoundaryChars === 'function') {
        boundaryChars = options.pathBoundaryChars(DEFAULT_PATH_BOUNDARY_CHARS);
    } else if (Array.isArray(options?.pathBoundaryChars)) {
        boundaryChars = options.pathBoundaryChars;
    }

    let counter = 0;
    const names: (keyof SM)[] = Object.keys(sectionMap);
    const subscribers = names.reduce((pre, name) => {
        pre[name] = {};
        return pre;
    }, {} as SubscribersBySectionMap<SM>);

    return {
        state: names.reduce((pre, name) => {
            pre[name] = {};
            return pre;
        }, {} as StateBySectionMap<SM>),
        subscribers,
        sectionMap,
        subscribe: (callback, name, path) => {
            const sectionSubscribers = subscribers[name] as
                Record<Path, Record<number, () => void>> | undefined;

            if (sectionSubscribers === undefined) {
                throw new Error(
                    `YASM: cannot subscribe to unknown section "${name.toString()}". Make sure it is registered in createStore().`
                );
            }

            const id = counter++;
            if (sectionSubscribers[path] !== undefined) {
                sectionSubscribers[path][id] = callback;
            } else {
                sectionSubscribers[path] = {
                    [id]: callback
                };
            }
            return () => {
                // Tolerant unsubscribe: it must not warn or
                // crash here. The "purged while components are still mounted"
                // warning is emitted by `purgeYasmState` itself, which knows
                // how many subscribers were attached at purge time.
                const record = (
                    subscribers[name] as
                        Record<Path, Record<number, () => void>> | undefined
                )?.[path];

                if (record !== undefined) {
                    delete record[id];
                }
            };
        },
        pathRegistry: names.reduce(
            (pre, name) => {
                if (sectionMap[name].routing !== undefined) {
                    pre[name as Name] = [];
                }
                return pre;
            },
            {} as Record<Name, Path[]>
        ),
        routingPlan: names.reduce((pre, name) => {
            const routing = sectionMap[name].routing;
            if (routing !== undefined) {
                const routingNames = Object.keys(routing);
                for (const routingName of routingNames) {
                    if (process.env.NODE_ENV !== 'production') {
                        if (sectionMap[routingName] === undefined) {
                            console.error(
                                `YASM: there is no "${routingName}" section to have a route on!`
                            );
                        }
                    }
                    if (pre[routingName] === undefined) {
                        pre[routingName as keyof SM] = [name as Name];
                    } else {
                        pre[routingName].push(name as Name);
                    }
                }
            }
            return pre;
        }, {} as RoutingPlan<SM>),
        memo: names.reduce((pre, name) => {
            pre[name] = {};
            return pre;
        }, {} as Memo<SM>),
        pathBoundaryChars: boundaryChars,
        debugOptions: options?.debugOptions ?? {}
    };
};

export type {
    Name,
    Path,
    Updater,
    PayloadAndPayloadCreator,
    Router,
    Routing,
    StateBySectionMap,
    SubscribersBySectionMap,
    RoutingPlan,
    Memo,
    Section,
    Store,
    DebugOptions
};
export { createStore, DEFAULT_PATH_BOUNDARY_CHARS };
