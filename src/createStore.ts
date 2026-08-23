type Name = string;
type Path = string;

/**
 * A mini-reducer for one section: receives the current state (an Immer
 * draft) and the payload, and either mutates the draft or returns a new
 * state. Returning the exact same reference (or leaving the draft untouched)
 * makes the update a silent no-op — no notifications, no re-renders, no
 * autosave.
 */
type Updater<S = any, P = any> = (state: S, payload: P) => S | void;

/**
 * Either a raw payload for the section updater, or a payload creator — a
 * callback that receives the *latest* state at dispatch time and returns
 * the payload (avoids stale closures).
 */
type PayloadAndPayloadCreator<
    SM extends Record<Name, Section>,
    N extends keyof SM
> =
    | Parameters<SM[N]['updater']>[1]
    | ((state: SM[N]['initialState']) => Parameters<SM[N]['updater']>[1]);

/**
 * Routes a child section's reads/writes into a parent section's state.
 *
 * - `selectByPathQuery`: resolves the child state for a relative path
 *   query (e.g. `'[7]'`), returning the child state and the remaining query.
 * - `updateByPathQuery`: applies `getValue` to the child state addressed by
 *   the query and returns the new *parent* state immutably. Returning the
 *   unchanged parent state aborts the whole update (reference-equality
 *   fast path).
 *
 * Any remaining query returned by `selectByPathQuery` is passed on to the
 * child section's own routing — so routers compose recursively and
 * multi-level nesting works.
 */
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

/** Maps a child section name to the `Router` that addresses it inside this section. */
type Routing<S = any> = Record<Name, Router<S>>;

/** The full store state grid: `state[sectionName][path]` holds one instance's value. */
type StateBySectionMap<SM extends Record<Name, Section>> = {
    [name in keyof SM]: Record<Path, SM[name]['initialState']>;
};

/** Listener callbacks per `(section, path)`, keyed by subscription id. */
type SubscribersBySectionMap<SM extends Record<Name, Section>> = {
    [name in keyof SM]: Record<Path, Record<number, () => void>>;
};

/** Maps a child section name to the parent sections that route into it. */
type RoutingPlan<SM extends Record<Name, Section>> = {
    [name in keyof SM]: Name[];
};

/** Memoized `{ subscribe, getState, updater }` plumbing per `(section, path)`. */
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

/**
 * Passed to a section's `normalize` hook during hydration, so composed
 * structures can normalize their children consistently with the global
 * normalization config (`defaultNormalize` applies the same transient and
 * pruning rules to any child value).
 */
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

    /**
     * Declares this section as a routing parent: other ("child") sections
     * can store their state *inside* this section's state and address it
     * through path queries (e.g. `useYasmState('UserRow', '/users[7]')`
     * reads/writes row 7 stored inside the `UserTable` section).
     *
     * Each entry maps a child section name to a `Router` providing:
     * - `selectByPathQuery(state, pathQuery)` — resolves the child state.
     * - `updateByPathQuery(state, pathQuery, getValue)` — updates the child
     *   immutably and returns the new parent state.
     *
     * You rarely define this by hand — `arraySectionGenerator` and
     * `objectSectionGenerator` build routing parents for you.
     *
     * ⚠️ Registered parent paths must not be nested within each other
     * (one path cannot be a segment-prefix of another); YASM reports
     * violations in development.
     */
    routing?: Routing<S>;

    /**
     * An optional hook to perform deep normalization for composed structures.
     * It is executed automatically during store hydration to ensure restored
     * data matches the current schema. Generators like `arraySectionGenerator`
     * use this to normalize their nested child elements.
     */
    normalize?: (storedValue: any, context: NormalizationContext) => S;

    /**
     * Determines whether this section should be persisted to storage.
     * When `false`, all data of this section and its path registry entries
     * are excluded from the persistence process.
     * @default true
     */
    persist?: boolean;
};

/**
 * Describes a state change, passed to the `logStateUpdates` filter callback.
 *
 * - `update`: the section path was updated with `payload` (already resolved
 *   when a payload creator was used).
 * - `purge`: every path matching `pathPrefix` is being purged.
 */
type LogEvent<SM extends Record<Name, Section> = Record<Name, Section>> =
    | { type: 'update'; sectionName: keyof SM; path: Path; payload: unknown }
    | { type: 'purge'; pathPrefix: string };

type DebugOptions<SM extends Record<Name, Section> = Record<Name, Section>> = {
    /**
     * Controls console logging for state mutations and purges in development.
     *
     * - `true`: Logs every update and purge.
     * - `false`: Disables logging.
     * - `(event) => boolean`: A filter callback to narrow down logs to specific
     *   sections, paths, or event types (highly recommended for busy apps).
     *
     * Note: Depending on your `snapshotScope` and `purgeSnapshotScope` settings,
     * logging can serialize large parts of the store, causing performance overhead.
     *
     * @default false
     */
    logStateUpdates?: boolean | ((event: LogEvent<SM>) => boolean);

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

/**
 * A minimal key-value storage engine. Every method may be synchronous or
 * asynchronous (YASM awaits results where needed) — `localStorage`,
 * `localforage`, `AsyncStorage`, or a custom adapter all fit this shape.
 */
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

/**
 * A one-time schema transformation for one section, executed per stored
 * path value during hydration (before `onBeforeHydrate` and normalization).
 *
 * When you need a migration:
 * - ✅ Renaming a field of a section — you MUST write a migration.
 * - ✅ Changing the type of a field — you MUST write a migration.
 * - ❌ Adding or removing a field — no migration needed; normalization
 *   fills added fields from `initialState` and prunes removed ones.
 *
 * Migrations must be idempotent — they may re-run if the bookkeeping
 * metadata is ever lost.
 *
 * @example
 * const APP_STATE_MIGRATIONS = {
 *     TransactionManage: [
 *         {
 *             id: '2026-04-27T13:02:00.000Z',
 *             migrate: storedValue => {
 *                 // Rename `loading` → `isLoading`
 *                 if ('loading' in storedValue) {
 *                     storedValue.isLoading = storedValue.loading;
 *                     delete storedValue.loading;
 *                 }
 *
 *                 // Change the type of `date` from `string` to `Date`
 *                 if (typeof storedValue.date === 'string') {
 *                     storedValue.date = new Date(storedValue.date);
 *                 }
 *             }
 *         }
 *     ]
 * };
 */
type StateMigration<S = Record<string, unknown>> = {
    /**
     * A unique identifier: the ISO date string of the change, optionally
     * prefixed with a short description for context.
     *
     * @example
     * '2026-04-27T13:02:00.000Z'
     * 'delete-legacy-loading/2026-04-27T13:02:00.000Z'
     */
    id: string;

    /**
     * A mutative callback receiving one stored path value of the section —
     * mutate it in place; the return value is ignored.
     *
     * 💡 By default `storedValue` is typed `Record<string, unknown>` (via
     * the generic default). This is intentional: the stored data was written
     * by an *older* schema, so treat it as an opaque record and guard field
     * accesses with `in` / `typeof`. Only instantiate `StateMigration<S>`
     * with your section's current type when you knowingly want that shape.
     */
    migrate: (storedValue: S) => void | Promise<void>;
};

/**
 * The exact shape YASM writes to (and reads from) storage: the per-section
 * state grid, the routing path registry, and bookkeeping metadata.
 */
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
     * 💡 Tip: For statically omitting a section, it is often cleaner to simply
     * set `persist: false` directly on the `Section` definition itself!
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
     *
     * ⚠️ WARNING: The objects inside `snapshot.state` are references shared with
     * the live React store. Treat this snapshot as STRICTLY READ-ONLY. Mutating
     * it here will cause severe UI bugs.
     */
    onBeforeSave?: (snapshot: PersistedSnapshot<SM>) => void | Promise<void>;

    /**
     * Managed schema migrations engine.
     * Executed automatically on hydration before `onBeforeHydrate` and normalization.
     *
     * 💡 Migrations receive the stored value typed as `Record<string, unknown>`
     * (the default `StateMigration`). The stored data predates the current
     * schema — that is why the migration exists — so typing it as the current
     * `initialState` would be a lie and breaks rename flows at compile time.
     * Opt into a concrete type with `StateMigration<MySectionState>` only when
     * you knowingly want the current shape.
     */
    migrations?: Partial<{
        [K in keyof SM]: StateMigration[];
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
    /** Dev-only diagnostics: state logging and snapshot scopes (see `DebugOptions`). */
    debugOptions?: DebugOptions<SM>;

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

/**
 * The store instance returned by `createStore`.
 *
 * `state`, `pathRegistry`, `hydrate()`, and `save()` are the supported
 * public surface. `subscribers`, `memo`, and `routingPlan` are internal
 * plumbing, exposed for advanced/manual usage and tests — avoid relying on
 * them in application code.
 */
type Store<SM extends Record<Name, Section> = Record<Name, Section>> = {
    /** The live state grid: `state[sectionName][path]` → instance value. */
    state: StateBySectionMap<SM>;

    /** Active listener callbacks per `(section, path)`, keyed by id. */
    subscribers: SubscribersBySectionMap<SM>;

    /** The section map this store was created with. */
    sectionMap: SM;

    /** Low-level subscription used by `useSyncExternalStore` (via `init`). */
    subscribe: (callback: () => void, name: keyof SM, path: Path) => () => void;

    /** Registered parent paths per routing section; persisted with the store so hydration can restore routing. */
    pathRegistry: Record<Name, Path[]>;

    /** Derived once from section `routing` declarations: child name → parent section names. */
    routingPlan: RoutingPlan<SM>;

    /** Memoized `{ subscribe, getState, updater }` plumbing per `(section, path)`. */
    memo: Memo<SM>;

    /** Characters that mark the start of a new path segment (default `'/'`, `'['`, `'.'`). */
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
    Pick<StoreOptions<SM>, 'serializer' | 'deserializer' | 'debugOptions'>
>;

/** The default path segment boundaries: `'/'`, `'['` and `'.'`. */
const DEFAULT_PATH_BOUNDARY_CHARS = ['/', '[', '.'];

/**
 * Creates a YASM store from a section map.
 *
 * @param sectionMap - Section definitions keyed by name. Composition/routing
 *   parents (e.g. from `arraySectionGenerator`) *and* their children must
 *   all be registered here.
 * @param options - Persistence, debugging, path boundaries, serialization,
 *   and change-callback configuration.
 * @returns The store. Provide it via `YasmContext.Provider`; when
 *   persistence is configured, call `store.hydrate()` once before mounting
 *   any consumers.
 */
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

    // 🛡️ Executed migrations are tracked by `${sectionName}/${id}`, so a
    // duplicate id would make every migration after the first one with that
    // id be silently skipped during hydration (the metadata already marks it
    // as executed). Fail fast at store creation instead of corrupting data.
    const migrationsConfig = options?.persist?.migrations;
    if (migrationsConfig !== undefined) {
        for (const [sectionName, sectionMigrations] of Object.entries(
            migrationsConfig
        )) {
            const seenIds = new Set<string>();
            for (const migration of sectionMigrations ?? []) {
                if (seenIds.has(migration.id)) {
                    throw new Error(
                        `YASM: duplicate migration id "${migration.id}" in section "${sectionName}". Migration ids must be unique within a section — duplicates would be silently skipped during hydration.`
                    );
                }
                seenIds.add(migration.id);
            }
        }
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

            Object.entries(this.sectionMap).forEach(([key, section]) => {
                if (
                    section.persist === false &&
                    !omittedSections.includes(key as keyof SM)
                ) {
                    omittedSections.push(key as keyof SM);
                }
            });

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
