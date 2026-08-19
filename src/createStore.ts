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

type NormalizationContext = {
    pruneStaleFields: boolean;
    defaultNormalize: (
        storedValue: any,
        initialState: any,
        sectionName: string
    ) => any;
};

type Section<S = any, P = any> = {
    initialState: S;
    updater: Updater<S, P>;
    routing?: Routing<S>;
    /**
     * An optional hook to perform deep normalization for composed structures.
     * Generators like `arraySectionGenerator` use this to normalize child elements.
     */
    normalize?: (storedValue: any, context: NormalizationContext) => S;
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
};

type YasmPersistenceAdapter = {
    getItem: (key: string) => Promise<string | null> | string | null;
    setItem: (key: string, value: string) => Promise<void> | void;
    removeItem: (key: string) => Promise<void> | void;
    clear?: () => Promise<void> | void;
};

type NormalizationConfig<SM extends Record<Name, Section>> = {
    /**
     * Automatically removes fields from the persisted state that are no longer present in the `initialState`.
     * Set this to `false` if your section states are dynamic dictionaries/maps.
     *
     * @default true
     */
    pruneStaleFields?: boolean;

    /**
     * Regular expressions matching field names that should always reset to their initial value.
     *
     * @example
     * transientPatterns: [/loading/i, /submitting/i]
     */
    transientPatterns?: RegExp[];

    /**
     * Exact field names per section that should always reset to their initial value.
     * Deeply integrated with `ArraySection` and `ObjectSection` via the `normalize` hook.
     *
     * @example
     * transientExact: { UserTable: ['selectedRowId'], Row: ['isLoading'] }
     */
    transientExact?: Partial<{
        [K in keyof SM]: (keyof SM[K]['initialState'])[];
    }>;

    /**
     * Custom evaluator for transient fields.
     *
     * @example
     * isTransient: (sectionName, fieldName) => sectionName === 'UserManage' && fieldName === 'draftToken'
     */
    isTransient?: (sectionName: keyof SM, fieldName: string) => boolean;
};

type StateMigration<S = Record<string, unknown>> = {
    id: string;
    migrate: (state: S) => void | Promise<void>;
};

type PersistedSnapshot<SM extends Record<Name, Section>> = {
    state: Partial<StateBySectionMap<SM>>;
    pathRegistry: Partial<Record<Name, Path[]>>;
    metadata?: {
        executedMigrations?: string[];
    };
};

type PersistConfig<SM extends Record<Name, Section>> = {
    /** The key under which the store data is saved in the storage. */
    key?: string;

    /** The storage engine (e.g., localforage, localStorage, AsyncStorage). */
    storage?: YasmPersistenceAdapter;

    /**
     * Section names to explicitly exclude from persistence.
     * Can be a static array or a callback that returns an array based on the current state.
     *
     * @example
     * omitSections: ['BaseInfo', 'TemporaryUI']
     *
     * @example
     * omitSections: state => state.Credential['/credential']?.rememberMe ? [] : ['Credential']
     */
    omitSections?:
        (keyof SM)[] | ((state: StateBySectionMap<SM>) => (keyof SM)[]);

    /**
     * Whether to automatically save the store after each state mutation.
     * Can be a boolean or a callback returning a boolean.
     * @default false
     */
    autoSave?: boolean | (() => boolean);

    /**
     * The debounce delay in milliseconds before an auto-save triggers.
     * Can be a static number or a dynamic callback (useful for conditional delays).
     * @default 1000
     */
    persistDebounceMS?: number | (() => number);

    /**
     * Hook triggered right before the state is serialized and saved.
     * Provides the snapshot (omissions applied) that is about to be saved.
     */
    onBeforeSave?: (snapshot: PersistedSnapshot<SM>) => void | Promise<void>;

    /**
     * Managed schema migrations engine.
     * Executed automatically on hydration before `onBeforeHydrate` and normalization.
     */
    migrations?: Partial<{
        [K in keyof SM]: StateMigration<SM[K]['initialState']>[];
    }>;

    /**
     * Hook triggered AFTER managed migrations, but BEFORE the parsed state is normalized and merged.
     * Perfect place for arbitrary final snapshot transformations.
     * You can directly mutate the `snapshot` object.
     */
    onBeforeHydrate?: (snapshot: PersistedSnapshot<SM>) => void | Promise<void>;

    /** Hook triggered after the state is successfully loaded and merged from storage. */
    onHydrated?: () => void;

    /**
     * Options for normalizing the restored state against the `initialState` of each section.
     * Handles missing fields (added to schema), stale fields (removed from schema), and transient UI states.
     * Pass `false` to disable entirely.
     * @default true
     */
    normalization?: boolean | NormalizationConfig<SM>;

    /**
     * A custom callback for full manual control over persistence.
     * If provided alongside `storage` and `key`, it will execute AFTER the built-in storage logic.
     * Passes the prepared snapshot (with omissions applied).
     */
    customPersistCallback?: (
        snapshot: PersistedSnapshot<SM>
    ) => void | Promise<void>;
};

type StoreOptions<SM extends Record<Name, Section>> = {
    debugOptions?: DebugOptions;

    /**
     * Characters that mark the start of a new segment inside a YASM path,
     * e.g. `/tabs/1` (`/`), `/table[3]` (`[`), `/form.field` (`.`).
     */
    pathBoundaryChars?:
        string[] | ((defaultPathBoundaryChars: string[]) => string[]);

    /**
     * Callback triggered immediately after any state update or successful purge.
     * Useful for reacting to changes outside the React component tree.
     */
    onStateChange?: () => void;

    /** Configuration for persisting the store state to an external storage. */
    persist?: PersistConfig<SM>;

    /**
     * A custom serializer function used when stringifying the state for
     * persistence (Storage) and generating state snapshots for logging (Console Logs).
     * Useful for handling data types that do not natively serialize well (e.g., Maps, Sets, Dates).
     */
    serializer?: (
        object: Record<string, unknown>,
        key: string,
        value: unknown
    ) => any;

    /**
     * A custom deserializer function used when parsing state from
     * persistence (Storage) or snapshot logs.
     * Pairs with the `serializer` to reconstruct complex data types.
     */
    deserializer?: (key: string, value: unknown) => any;
};

const SYMBOL_NOTIFY_CHANGE = Symbol('YASM_NOTIFY_CHANGE');

type Store<SM extends Record<Name, Section> = Record<Name, Section>> = {
    state: StateBySectionMap<SM>;
    subscribers: SubscribersBySectionMap<SM>;
    sectionMap: SM;
    subscribe: (callback: () => void, name: keyof SM, path: Path) => () => void;
    pathRegistry: Record<Name, Path[]>;
    routingPlan: RoutingPlan<SM>;
    memo: Memo<SM>;
    pathBoundaryChars: string[];

    /**
     * Loads the persisted state from storage and merges it into the current store.
     * Must be called once during the initial app load (e.g., in a top-level Provider).
     */
    hydrate: () => Promise<void>;

    /**
     * Manually triggers the persistence logic to save the current state.
     * Normally called automatically if `autoSave: true` is configured.
     */
    save: () => Promise<void>;

    /**
     * Internal method used to trigger change listeners and persistence mechanisms
     * immediately after a state mutation or purge. Hidden via Symbol.
     */
    [SYMBOL_NOTIFY_CHANGE]: () => void;
} & Required<
    Pick<StoreOptions<any>, 'serializer' | 'deserializer' | 'debugOptions'>
>;

const DEFAULT_PATH_BOUNDARY_CHARS = ['/', '[', '.'];

const createStore = <SM extends Record<Name, Section>>(
    sectionMap: SM,
    options?: StoreOptions<SM>
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

    // Store references for persistence lifecycle and concurrency
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    let saveQueue: Promise<void> = Promise.resolve();
    let hydrationPromise: Promise<void> | undefined;
    let isHydrated = false;
    let hydrationSuccess = false;

    // Maintain executed migrations metadata in memory (not in state)
    let executedMigrations = new Set<string>();

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
        serializer: options?.serializer ?? ((_, __, value) => value),
        deserializer: options?.deserializer ?? ((_, value) => value),
        debugOptions: options?.debugOptions ?? {},

        async save() {
            const p = options?.persist;
            if (!p) {
                return;
            }

            // 🛡️ Prevent saving a fresh state over the DB before hydration finishes
            if (!isHydrated) {
                if (hydrationPromise) {
                    await hydrationPromise;
                    if (!hydrationSuccess) return; // Abort if hydration explicitly failed
                } else {
                    return;
                }
            } else if (!hydrationSuccess) {
                return; // Protect corrupted DBs from being overwritten in this session
            }

            // 🔒 Build the snapshot SYNCHRONOUSLY at the moment save() is
            // called. Section records and registry arrays are shallow-copied
            // so path-level changes made after this point cannot leak into
            // the captured snapshot while the async queue is backed up.
            // NOTE: value objects are still shared with the live store —
            // persistence hooks must treat them as read-only.
            const omittedSections =
                typeof p.omitSections === 'function'
                    ? p.omitSections(this.state)
                    : p.omitSections || [];

            const stateToSave: Partial<StateBySectionMap<SM>> = {};
            const pathRegistryToSave: Partial<Record<Name, Path[]>> = {};

            Object.keys(this.state).forEach(sectionKey => {
                const key = sectionKey as keyof SM;
                if (!omittedSections.includes(key)) {
                    stateToSave[key] = { ...this.state[key] };
                }
            });

            Object.keys(this.pathRegistry).forEach(sectionKey => {
                const key = sectionKey as Name;
                if (!omittedSections.includes(key as keyof SM)) {
                    // Copy the array too: `init()` pushes new paths onto the
                    // live registry, which must not leak into this snapshot.
                    pathRegistryToSave[key] = [...this.pathRegistry[key]];
                }
            });

            const snapshotToSave: PersistedSnapshot<SM> = {
                state: stateToSave,
                pathRegistry: pathRegistryToSave,
                metadata: {
                    executedMigrations: Array.from(executedMigrations)
                }
            };

            // 🔒 Serialize save calls to prevent race conditions in async storage
            saveQueue = saveQueue.then(async () => {
                try {
                    if (p.onBeforeSave) {
                        await p.onBeforeSave(snapshotToSave);
                    }

                    // 1. Declarative Storage
                    if (p.key && p.storage) {
                        const payload = JSON.stringify(
                            snapshotToSave,
                            function (key, value) {
                                return options?.serializer
                                    ? options.serializer(
                                          this as Record<string, unknown>,
                                          key,
                                          value
                                      )
                                    : value;
                            }
                        );

                        await p.storage.setItem(p.key, payload);
                    }

                    // 2. Custom Manual Callback
                    if (p.customPersistCallback) {
                        await p.customPersistCallback(snapshotToSave);
                    }
                } catch (error) {
                    console.error(
                        'YASM: Failed to execute save queue task.',
                        error
                    );
                }
            });

            return saveQueue;
        },

        hydrate() {
            // Return existing promise if already hydrating (Single-flight / Idempotency)
            if (hydrationPromise) {
                return hydrationPromise;
            }

            hydrationPromise = (async () => {
                const p = options?.persist;
                let isStateChangedDuringHydration = false;

                if (!p || !p.key || !p.storage) {
                    isHydrated = true;
                    hydrationSuccess = true;
                    return;
                }

                let rawData: string | null | unknown = null;

                try {
                    rawData = await p.storage.getItem(p.key);
                    if (rawData) {
                        const parsed =
                            typeof rawData === 'string'
                                ? JSON.parse(rawData, options?.deserializer)
                                : rawData;

                        // A valid storage read may still contain a JSON
                        // primitive (for example, an old or corrupted
                        // snapshot containing `null`). Treat it as an empty
                        // snapshot, but continue through the lifecycle so the
                        // store becomes hydrated and `onHydrated` is called.
                        if (!parsed || typeof parsed !== 'object') {
                            isStateChangedDuringHydration = false;
                        } else {
                            if (parsed.state === undefined) {
                                parsed.state = {};
                            }

                            if (parsed.pathRegistry === undefined) {
                                parsed.pathRegistry = {};
                            }

                            // Initialize metadata and executed migrations tracking
                            executedMigrations = new Set<string>(
                                parsed.metadata?.executedMigrations || []
                            );

                            // 1. Run Managed Schema Migrations
                            if (p.migrations) {
                                for (const [
                                    sectionName,
                                    sectionMigrations
                                ] of Object.entries(p.migrations)) {
                                    const storedSection =
                                        parsed.state[sectionName];
                                    const pendingMigrations = (
                                        sectionMigrations as StateMigration[]
                                    ).filter(
                                        migration =>
                                            !executedMigrations.has(
                                                `${sectionName}/${migration.id}`
                                            )
                                    );

                                    if (pendingMigrations.length === 0) {
                                        continue;
                                    }

                                    if (storedSection !== undefined) {
                                        for (const stateValue of Object.values(
                                            storedSection
                                        )) {
                                            for (const migration of pendingMigrations) {
                                                await migration.migrate(
                                                    stateValue as Record<
                                                        string,
                                                        unknown
                                                    >
                                                );
                                            }
                                        }
                                    }

                                    // Mark as executed even if section didn't exist in state
                                    // to prevent migrations from running again if the section is created later
                                    for (const migration of pendingMigrations) {
                                        executedMigrations.add(
                                            `${sectionName}/${migration.id}`
                                        );
                                    }

                                    isStateChangedDuringHydration = true;
                                }
                            }

                            // 2. Hook for arbitrary snapshot transformations
                            if (p.onBeforeHydrate) {
                                await p.onBeforeHydrate(parsed);
                                isStateChangedDuringHydration = true; // Assume changes were made
                            }

                            // 3. Remove stale sections natively
                            Object.keys(parsed.state).forEach(sectionName => {
                                if (!(sectionName in this.sectionMap)) {
                                    delete parsed.state[sectionName];
                                    isStateChangedDuringHydration = true;
                                }
                            });

                            Object.keys(parsed.pathRegistry).forEach(
                                sectionName => {
                                    if (!(sectionName in this.pathRegistry)) {
                                        delete parsed.pathRegistry[sectionName];
                                        isStateChangedDuringHydration = true;
                                    }
                                }
                            );

                            // 4. Validate Path Registry against parsed State
                            Object.keys(parsed.pathRegistry).forEach(
                                sectionName => {
                                    const originalLength =
                                        parsed.pathRegistry[sectionName].length;
                                    parsed.pathRegistry[sectionName] =
                                        parsed.pathRegistry[sectionName].filter(
                                            (path: string) =>
                                                parsed.state[sectionName]?.[
                                                    path
                                                ] !== undefined
                                        );

                                    if (
                                        parsed.pathRegistry[sectionName]
                                            .length !== originalLength
                                    ) {
                                        isStateChangedDuringHydration = true;
                                    }
                                }
                            );

                            // 5. Normalize state and clear transient fields
                            const norm = p.normalization;
                            const shouldNormalize = norm !== false;
                            const pruneStale =
                                typeof norm === 'object'
                                    ? (norm.pruneStaleFields ?? true)
                                    : true;

                            if (shouldNormalize) {
                                // Extract the core normalization logic for reuse in nested sections
                                const defaultNormalize = (
                                    storedVal: any,
                                    initialVal: any,
                                    secName: string
                                ) => {
                                    if (
                                        storedVal === null ||
                                        typeof storedVal !== 'object' ||
                                        Array.isArray(storedVal)
                                    ) {
                                        return { ...initialVal };
                                    }

                                    const merged: any = {
                                        ...initialVal,
                                        ...storedVal
                                    };

                                    if (pruneStale) {
                                        Object.keys(merged).forEach(key => {
                                            if (!(key in initialVal)) {
                                                delete merged[key];
                                                isStateChangedDuringHydration = true;
                                            }
                                        });
                                    }

                                    if (typeof norm === 'object') {
                                        Object.keys(merged).forEach(key => {
                                            let isTrans = false;

                                            if (
                                                norm.transientPatterns?.some(
                                                    regex => regex.test(key)
                                                )
                                            ) {
                                                isTrans = true;
                                            }

                                            if (
                                                norm.transientExact?.[
                                                    secName as keyof SM
                                                ]?.includes(key as any)
                                            ) {
                                                isTrans = true;
                                            }

                                            if (
                                                norm.isTransient?.(
                                                    secName as keyof SM,
                                                    key
                                                )
                                            ) {
                                                isTrans = true;
                                            }

                                            if (isTrans) {
                                                if (
                                                    merged[key] !==
                                                    initialVal[key]
                                                ) {
                                                    merged[key] =
                                                        initialVal[key];
                                                    isStateChangedDuringHydration = true;
                                                }
                                            }
                                        });
                                    }

                                    return merged;
                                };

                                const context: NormalizationContext = {
                                    pruneStaleFields: pruneStale,
                                    defaultNormalize
                                };

                                Object.keys(parsed.state).forEach(
                                    sectionName => {
                                        const section =
                                            this.sectionMap[sectionName];
                                        const storedSection =
                                            parsed.state[sectionName];
                                        const initial = section.initialState;

                                        if (
                                            initial === null ||
                                            typeof initial !== 'object' ||
                                            Array.isArray(initial)
                                        ) {
                                            return;
                                        }

                                        Object.keys(storedSection).forEach(
                                            path => {
                                                const storedValue =
                                                    storedSection[path];

                                                // Delegate to the section's own normalizer when available (such as ArraySection)
                                                if (section.normalize) {
                                                    storedSection[path] =
                                                        section.normalize(
                                                            storedValue,
                                                            context
                                                        );
                                                    // Assume dynamic structures changed so they are persisted when necessary
                                                    isStateChangedDuringHydration = true;
                                                } else {
                                                    // Otherwise, use the default normalizer
                                                    storedSection[path] =
                                                        defaultNormalize(
                                                            storedValue,
                                                            initial,
                                                            sectionName
                                                        );
                                                }
                                            }
                                        );
                                    }
                                );
                            }

                            // 6. Merge safely into current state
                            // 🔒 (Deep merge paths to prevent overwriting paths created natively during hydration)
                            Object.keys(parsed.state).forEach(sectionName => {
                                const key = sectionName as keyof SM;
                                this.state[key] = {
                                    ...this.state[key],
                                    ...(parsed.state as any)[key]
                                };
                            });

                            Object.keys(parsed.pathRegistry).forEach(
                                sectionName => {
                                    const key = sectionName as Name;
                                    // 🔒 Ensure uniqueness when merging path registries
                                    const existingPaths = new Set(
                                        this.pathRegistry[key] || []
                                    );
                                    (parsed.pathRegistry as any)[key].forEach(
                                        (p: string) => existingPaths.add(p)
                                    );
                                    this.pathRegistry[key] =
                                        Array.from(existingPaths);
                                }
                            );
                        }
                    } else if (p.migrations) {
                        // 🛡️ Fresh install (empty storage): natively created
                        // state already matches the current schema, so every
                        // configured migration counts as executed. Otherwise
                        // the first saved snapshot would carry empty
                        // bookkeeping and migrations would re-run on
                        // current-schema data after the next reload.
                        const migrationEntries = Object.entries(
                            p.migrations
                        ) as [string, StateMigration[]][];
                        for (const [
                            sectionName,
                            sectionMigrations
                        ] of migrationEntries) {
                            for (const migration of sectionMigrations) {
                                executedMigrations.add(
                                    `${sectionName}/${migration.id}`
                                );
                            }
                        }
                    }

                    hydrationSuccess = true;
                } catch (error) {
                    console.error(
                        'YASM: Failed to hydrate state from storage. The data is corrupted.',
                        error
                    );

                    // 🛡️ Quarantine Strategy: Backing up corrupted data
                    if (rawData !== null && p.key && p.storage) {
                        try {
                            const timestamp = new Date()
                                .toISOString()
                                .replace(/[:.]/g, '-');

                            const backupKey = `${p.key}_corrupted_backup_${timestamp}`;
                            const dataToBackup =
                                typeof rawData === 'string'
                                    ? rawData
                                    : JSON.stringify(rawData);

                            await p.storage.setItem(backupKey, dataToBackup);
                            console.warn(
                                `YASM: Corrupted state backed up to "${backupKey}". Starting fresh.`
                            );
                        } catch (backupError) {
                            console.error(
                                'YASM: Failed to create backup of corrupted state.',
                                backupError
                            );
                        }
                    }

                    // 1. Unlock so the user can save new information in the future
                    hydrationSuccess = true;

                    // 2. Tell YASM that the state has "changed" so it immediately
                    // overwrites the main database with a completely empty and clean state,
                    // thereby removing the corrupted data from the primary key.
                    isStateChangedDuringHydration = true;
                }

                isHydrated = true;

                // 7. If state was modified during hydration, persist it back to storage
                if (isStateChangedDuringHydration) {
                    await this.save();
                }

                if (p.onHydrated) {
                    try {
                        p.onHydrated();
                    } catch (error) {
                        console.error('YASM: onHydrated hook failed.', error);
                    }
                }
            })();

            return hydrationPromise;
        },

        [SYMBOL_NOTIFY_CHANGE]: async function () {
            if (options?.onStateChange) {
                try {
                    options.onStateChange();
                } catch (error) {
                    console.error(
                        'YASM: onStateChange callback failed.',
                        error
                    );
                }
            }

            const p = options?.persist;

            if (!p) {
                return;
            }

            // Do not schedule auto-saves if the store has not finished hydrating
            if (!isHydrated) {
                return;
            }

            const isAutoSave =
                typeof p.autoSave === 'function' ? p.autoSave() : p.autoSave;

            if (!isAutoSave) {
                return;
            }

            const msRaw = p.persistDebounceMS;
            const ms = typeof msRaw === 'function' ? msRaw() : (msRaw ?? 1000);

            if (debounceTimer) {
                clearTimeout(debounceTimer);
            }

            debounceTimer = setTimeout(() => {
                const task = async () => {
                    try {
                        await this.save();
                    } catch (error) {
                        console.error(
                            'YASM: Background auto-save failed.',
                            error
                        );
                    }
                };

                // Use requestIdleCallback to prevent blocking the main UI thread during heavy stringification
                if (
                    typeof window !== 'undefined' &&
                    'requestIdleCallback' in window
                ) {
                    window.requestIdleCallback(() => task(), {
                        timeout: 2000
                    });
                } else {
                    setTimeout(task, 0); // Fallback for Safari/unsupported environments
                }
            }, ms);
        }
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
    DebugOptions,
    StoreOptions,
    PersistConfig,
    StateMigration,
    PersistedSnapshot,
    YasmPersistenceAdapter
};
export { createStore, SYMBOL_NOTIFY_CHANGE, DEFAULT_PATH_BOUNDARY_CHARS };
