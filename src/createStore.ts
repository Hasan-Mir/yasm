import {
    isPathWithinPrefix,
    snapshotByPrefix,
    type SnapshotByPrefixOptions,
    type SnapshotMode
} from './util';
import { purgeYasmState, type PurgeOptions } from './purge';
import { init, RebindRoutingResult, route } from './useYasmState';
import { cloneYasmSubtree, type CloneSubtreeOptions } from './clone';

type Name = string;
type Path = string;

/**
 * Observable hydration lifecycle of a store, consumed through
 * `store.subscribeHydration()` / `store.getHydrationSnapshot()` and the
 * `useHydration` hook.
 *
 * - `'idle'`        — persistence is configured but `hydrate()` was not called yet.
 * - `'hydrating'`   — `hydrate()` is in flight (storage read + merge).
 * - `'hydrated'`    — hydration succeeded normally.
 * - `'quarantined'` — corrupted persisted data was backed up and the session
 *                     booted fresh (see `onQuarantine`).
 * - `'failed'`      — hydration hit an unrecoverable error (e.g. the repair
 *                     save could not even write storage).
 */
type HydrationStatus =
    'idle' | 'hydrating' | 'hydrated' | 'failed' | 'quarantined';

/** Stable snapshot returned by `store.getHydrationSnapshot()` / `useHydration()`. */
type HydrationResult = {
    status: HydrationStatus;
    /** Convenience flag: `true` when consumers may mount safely. */
    isHydrated: boolean;
    /** Set when the last transition was `'quarantined'` or `'failed'`. */
    error?: unknown;
};

/** Structured payload handed to `PersistConfig.onQuarantine`. */
type QuarantineInfo = {
    /** The primary storage key whose payload was corrupted. */
    key: string;
    /**
     * The quarantine backup key (`<key>_corrupted_backup_<timestamp>`), or
     * `null` when the backup itself could not be written.
     */
    backupKey: string | null;
    /** The raw payload read from storage, untouched. */
    rawData: unknown;
    /** The error that triggered the quarantine flow. */
    error: unknown;
};

/**
 * Equality strategy used by selector-aware subscriptions to decide whether a
 * notification actually changed the selection:
 *
 * - `'shallow'` (default): `Object.is` on primitives, or a top-level
 *   key-by-key comparison for objects/arrays (a selector that rebuilds its
 *   result object on every call does not re-fire when every top-level value
 *   is unchanged).
 * - `'strict'`: `Object.is` — only reference/primitive identity wins.
 * - custom: your own comparator.
 */
type SelectorEquality<Selected> =
    | 'strict'
    | 'shallow'
    | ((prevSelected: Selected, nextSelected: Selected) => boolean);

/** Options accepted by the selector-aware `store.subscribe` overload. */
type SubscribeSelectorOptions<Selected> = {
    /**
     * The strategy used to decide whether the selected value has actually changed.
     *
     * - `'shallow'` (default): Compares top-level keys using `Object.is`.
     * - `'strict'`: Reference equality only via `Object.is`.
     * - `(prevSelected, nextSelected) => boolean`: A custom comparator receiving
     *   the last-known value (`prevSelected`) and the freshly computed selection
     *   (`nextSelected`). Return `true` to mark them equal and skip notifying
     *   the listener, or `false` to fire the listener.
     *
     * @default 'shallow'
     */
    equality?: SelectorEquality<Selected>;

    /**
     * When `true`, invoke the listener once synchronously at subscription
     * time with `(currentSelected, undefined)`.
     *
     * @default false
     */
    fireImmediately?: boolean;
};

/** One `(section, path)` address watched by `store.subscribeMany`. */
type SubscribeManyTarget<SM extends Record<Name, Section>> = {
    [N in keyof SM]: { name: N; path: Path };
}[keyof SM];

/**
 * One change reported by `store.subscribeMany`.
 *
 * The union is discriminated by `name`, so narrowing on it
 * (`if (change.name === 'BaseInfo')`) also narrows `current` / `previous` to
 * that section's state type — consumers never need a cast.
 */
type SubscribeManyChange<SM extends Record<Name, Section>> = {
    [N in keyof SM]: {
        name: N;
        path: Path;
        /** The value AFTER the change (never raw `undefined`). */
        current: SM[N]['initialState'];
        /**
         * The value that was last reported to this listener, or `undefined`
         * for the very first report of that address (including the
         * `fireImmediately` batch).
         */
        previous: SM[N]['initialState'] | undefined;
    };
}[keyof SM];

/** Options accepted by `store.subscribeMany`. */
type SubscribeManyOptions = {
    /**
     * How changes are delivered to the listener:
     *
     * - `'microtask'` (default): every change produced inside the same
     *   synchronous flush is coalesced into ONE listener call on the next
     *   microtask, at most one entry per `(name, path)` (the newest value
     *   wins). A target that changes and changes back within the same flush
     *   is dropped entirely. This is what turns the post-hydration
     *   notification pass into a single call instead of one per path.
     * - `'sync'`: the listener is invoked immediately, inside the dispatch
     *   that produced the change, with a single-entry batch.
     *
     * @default 'microtask'
     */
    batch?: 'microtask' | 'sync';

    /**
     * When `true`, invoke the listener once SYNCHRONOUSLY at subscription
     * time with one entry per target (`previous: undefined`).
     *
     * @default false
     */
    fireImmediately?: boolean;
};

/**
 * The default selector equality strategy (`'shallow'`): reference identity
 * via `Object.is`, falling back to a shallow key-by-key comparison for
 * objects/arrays, with Date parity, prototype checks, and own-property guards.
 */
const shallowEqual = (a: unknown, b: unknown): boolean => {
    if (Object.is(a, b)) {
        return true;
    }
    if (
        typeof a !== 'object' ||
        typeof b !== 'object' ||
        a === null ||
        b === null
    ) {
        return false;
    }

    // 🛡️ Handles Date instances by timestamp value, and prevents Date vs {} false matches
    if (a instanceof Date || b instanceof Date) {
        return (
            a instanceof Date &&
            b instanceof Date &&
            Object.is(a.getTime(), b.getTime())
        );
    }

    if (a instanceof Set || b instanceof Set) {
        if (!(a instanceof Set) || !(b instanceof Set)) {
            return false;
        }

        if (a.size !== b.size) {
            return false;
        }

        for (const value of Array.from(a)) {
            if (!b.has(value)) {
                return false;
            }
        }

        return true;
    }

    if (a instanceof Map || b instanceof Map) {
        if (!(a instanceof Map) || !(b instanceof Map)) {
            return false;
        }

        if (a.size !== b.size) {
            return false;
        }

        for (const entry of Array.from(a)) {
            const key = entry[0];
            const value = entry[1];
            if (!b.has(key) || !Object.is(b.get(key), value)) {
                return false;
            }
        }

        return true;
    }

    if (a instanceof RegExp || b instanceof RegExp) {
        if (!(a instanceof RegExp) || !(b instanceof RegExp)) {
            return false;
        }

        return (
            a.source === b.source &&
            a.flags === b.flags &&
            Object.is(a.lastIndex, b.lastIndex)
        );
    }

    // 🛡️ Guarantees identical prototype inheritance (separates [] vs {}, Map vs {}, etc.)
    if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) {
        return false;
    }

    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) {
        return false;
    }

    for (const key of keysA) {
        // 🔒 Prevents prototype-chain resolution leak and verifies own property
        if (!Object.prototype.hasOwnProperty.call(b, key)) {
            return false;
        }

        if (
            !Object.is(
                (a as Record<string, unknown>)[key],
                (b as Record<string, unknown>)[key]
            )
        ) {
            return false;
        }
    }
    return true;
};

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
 * ⚠️ NOTE on composition mechanics: although `selectByPathQuery` returns a
 * `[state, remainedPathQuery]` tuple, the engine currently DISCARDS the
 * returned remainder. Instead, the child query for each hop is derived by
 * slicing the registered routing paths against each other
 * (`childPath.slice(parentPath.length)`), which relies on every intermediate
 * route being present in `pathRegistry`. The built-in Array/Object section
 * generators always return an empty remainder, so they compose correctly.
 * A custom router that returns a NON-empty remainder and expects it to be
 * forwarded to the next hop will NOT have it forwarded — address nested
 * levels through registry-registered parent paths instead.
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
            rebindRouting?: () => RebindRoutingResult | undefined;
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
 * - `clone`: every path matching `sourcePrefix` is being cloned into
 *   `targetPrefix`.
 */
type LogEvent<SM extends Record<Name, Section> = Record<Name, Section>> =
    | { type: 'update'; sectionName: keyof SM; path: Path; payload: unknown }
    | { type: 'purge'; pathPrefix: string }
    | { type: 'clone'; sourcePrefix: string; targetPrefix: string };

/**
 * Filters and shaping for the FULL development snapshots (the before/after
 * dumps logged around updates and purges). Only consulted when
 * `snapshotScope` / `purgeSnapshotScope` are `'full'`; every field is
 * optional — set only what you need.
 */
type SnapshotFilter<SM extends Record<Name, Section> = Record<Name, Section>> =
    {
        /**
         * Include only state entries whose path matches one of these prefixes.
         * Segment-aware (same semantics as purge): `/tabs/1` will NOT match
         * `/tabs/10`. An empty string matches everything. Omit to include all
         * paths.
         */
        pathFilter?: string | string[];
        /**
         * Include only these sections — ideal for hiding unrelated or noisy
         * sections from the before/after dump. Omit to include all sections.
         */
        sectionFilter?: keyof SM | (keyof SM)[];
        /**
         * How `pathFilter` entries are matched against stored paths:
         *
         * - `'segment'` (default): subtree semantics — `/tabs/1` matches the path
         *   itself plus every descendant, but never `/tabs/10`.
         * - `'exact'`: only paths EQUAL to a `pathFilter` entry are included —
         *   ideal for watching a single state slot without its whole subtree.
         * - `'startsWith'`: raw `String.prototype.startsWith` matching.
         *
         * @default 'segment'
         */
        match?: 'segment' | 'startsWith' | 'exact';
        /**
         * Output structure of the snapshot dump.
         *
         * - `'flat'` (default): section → path → state. Easiest to scan/search.
         * - `'tree'`: paths nested under their closest matching physical ancestor,
         *   mirroring how routed/composed children relate to their parents.
         *
         * @default 'flat'
         */
        mode?: SnapshotMode;
    };

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
     * @example
     * debugOptions: {
     *     logStateUpdates: true // log EVERY update and purge
     * }
     *
     * @example
     * // Filter callback (recommended for busy apps) — only log updates of
     * // section "Cart" and every purge:
     * debugOptions: {
     *     logStateUpdates: event =>
     *         event.type === 'purge' ||
     *         (event.type === 'update' && event.sectionName === 'Cart')
     * }
     *
     * @example
     * // Turn logging off entirely:
     * debugOptions: { logStateUpdates: false }
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

    /**
     * Filters and shaping applied to the FULL before/after debug snapshots.
     * Only relevant when `snapshotScope` / `purgeSnapshotScope` are `'full'`
     * (`'local'` / `'none'` snapshots are already tiny and stay untouched).
     * Every field is optional — set only what you need.
     *
     * The standalone `snapshotByPrefix()` / `store.snapshotByPrefix()`
     * accept the same controls imperatively.
     *
     * @example
     * debugOptions: {
     *     logStateUpdates: true,
     *     snapshotScope: 'full',
     *     purgeSnapshotScope: 'full',
     *     snapshotFilter: {
     *         pathFilter: '/tabs/1',   // segment-aware: won't match '/tabs/10'
     *         sectionFilter: 'Tab',    // hide unrelated sections from the dump
     *         mode: 'tree'             // 🌳 nested hierarchy output
     *     }
     * }
     */
    snapshotFilter?: SnapshotFilter<SM>;

    /**
     * Custom formatting for the dimmed timestamp prefixed to every
     * development log line (`YASM: updating…`, `🧹 YASM purging…`,
     * `Before:`, `After:` …).
     *
     * - `undefined` (default): dimmed local `HH:MM:SS.mmm`.
     * - `(date) => string`: full control — e.g. `d => d.toLocaleTimeString()`
     *   for system-timezone output, or an ISO string.
     * - `false`: disables timestamps entirely (also when the formatter
     *   returns an empty string).
     *
     * @example
     * debugOptions: {
     *     logStateUpdates: true,
     *     timestampFormatter: date => date.toLocaleTimeString() // e.g. "5:08:49 PM"
     *     // timestampFormatter: date => date.toISOString()    // full ISO stamp
     *     // timestampFormatter: false                         // timestamps OFF
     * }
     */
    timestampFormatter?: ((date: Date) => string) | false;

    /**
     * When true, all development logs are emitted as a SINGLE plain string —
     * no `%c` styling segments at all (timestamp still included, inline).
     *
     * Use this in consoles that don't fully support chained `%c` styling
     * (Node/SSR output, vConsole/eruda on mobile webviews, some logger
     * wrappers) where styled logs would otherwise print literal `%c` markers
     * and raw CSS.
     *
     * @example
     * debugOptions: {
     *     logStateUpdates: true,
     *     disableLogStyling: true
     *     // every line becomes plain text, e.g.:
     *     // "[16:10:37.877] 🧹 YASM purging paths matching segment \"/tabs/1\""
     * }
     *
     * @default false
     */
    disableLogStyling?: boolean;
};

/**
 * Variance-safe shape of {@link DebugOptions} as stored on a
 * {@link Store} instance.
 *
 * ⚠️ INTERNAL — user-facing options stay fully generic (`DebugOptions<SM>`,
 * `SnapshotFilter<SM>`), so `sectionName` / `sectionFilter` autocomplete is
 * inferred from the section map at the `createStore(...)` call site. The
 * STORED copy, however, must not depend on a specific `SM`: callback
 * parameters make generic types invariant, which would break assigning a
 * concrete `Store<{ Tab: …; Cell: … }>` to the general `Store` type (React
 * context, helpers, purge internals). Widening the event/filter types with
 * `any` restores that assignability without weakening any public input type.
 */
type ResolvedDebugOptions = {
    logStateUpdates?: boolean | ((event: LogEvent<any>) => boolean);
    snapshotScope?: 'full' | 'local';
    purgeSnapshotScope?: 'none' | 'full';
    snapshotFilter?: SnapshotFilter<any>;
    timestampFormatter?: ((date: Date) => string) | false;
    disableLogStyling?: boolean;
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
        /**
         * Deferred purges that were decided but still waiting for their last
         * subscriber when the snapshot was written. Re-scheduled (and, with
         * no consumers mounted, executed immediately) during the next
         * hydration — so a refresh inside a pending window can never leave
         * orphaned state behind.
         */
        pendingPurges?: {
            pathPrefix: string;
            match?: 'segment' | 'startsWith' | undefined;
        }[];
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
     * Hook triggered when persisted data was corrupted (invalid JSON, a
     * failing migration, a throwing `onBeforeHydrate` …) and YASM quarantined
     * it: the raw payload was backed up under `<key>_corrupted_backup_<timestamp>`
     * and the primary key is being reset to a clean snapshot. The session
     * continues unlocked afterwards — hydration always resolves.
     *
     * Perfect for alerting error-tracking services (Sentry, …). The callback
     * is isolated: if it throws, YASM logs it and still completes the
     * quarantine reset and hydration. May be synchronous or asynchronous.
     */
    onQuarantine?: (info: QuarantineInfo) => void | Promise<void>;

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

/**
 * Internal notification dispatched by YASM whenever something meaningful
 * happened to the store data:
 *
 * - a state update produced a **new** state reference (no-op updates skip it),
 * - a raw `purge()` actually removed state or registry entries,
 * - a deferred `purgeWhenUnused` fired.
 *
 * The store uses it to trigger two side effects, in order:
 *
 * 1. the user-facing `onStateChange` callback,
 * 2. the debounced autosave (only after hydration finished).
 *
 * It deliberately does NOT notify React subscribers — those are notified per
 * `(section, path)` directly by the updater/purge code paths. Hidden via
 * Symbol so application code cannot call it accidentally.
 */
const SYMBOL_NOTIFY_CHANGE = Symbol('YASM_NOTIFY_CHANGE');

/**
 * Internal notification used by `purgeYasmState`: a matched path's subscriber
 * record was removed directly (without a normal unsubscribe), so deferred
 * purges waiting on that path must reconcile their bookkeeping instead of
 * leaking forever.
 */
const SYMBOL_NOTIFY_FORCED_UNSUBSCRIBE = Symbol(
    'YASM_NOTIFY_FORCED_UNSUBSCRIBE'
);

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

    /**
     * Low-level subscription used by `useSyncExternalStore` (via `init`).
     *
     * Registers `callback` against the raw `(name, path)` pair and returns
     * the unsubscribe function. Exactly one overload — fully backward
     * compatible.
     */
    subscribe(callback: () => void, name: keyof SM, path: Path): () => void;

    /**
     * Selector-aware subscription: evaluates `selector` against the state at
     * `(name, path)` whenever that path is UPDATED and invokes `listener` —
     * but only when the selected value actually changed according to
     * `options.equality` (default `'shallow'`).
     *
     * ⚠️ A purge does NOT notify: `purgeYasmState` removes the subscriber
     * record outright, so the listener is detached silently and never fires
     * for the destruction itself. Re-subscribe after a purge if you need to
     * keep observing that path.
     *
     * The selector NEVER receives raw `undefined` for a valid section: a
     * lazily-uninitialized or purged path is evaluated against the section's
     * `initialState` instead (a fresh subscription re-initializes the path
     * from `initialState`). The listener is isolated — a throwing listener is
     * logged and never aborts other subscribers or the store dispatch.
     *
     * @example
     * store.subscribe(
     *     'UserRow',
     *     '/users[7]',
     *     row => row.name,
     *     (name, prevName) => console.info(`${prevName} → ${name}`)
     * );
     */
    subscribe<N extends keyof SM, Selected>(
        name: N,
        path: Path,
        selector: (state: SM[N]['initialState']) => Selected,
        listener: (
            selected: Selected,
            prevSelected: Selected | undefined
        ) => void,
        options?: SubscribeSelectorOptions<Selected>
    ): () => void;

    /**
     * Watches SEVERAL `(section, path)` addresses with ONE listener and ONE
     * unsubscribe function — the multi-path counterpart of `subscribe`.
     *
     * The listener receives an array of changes. Entries are discriminated by
     * `name`, so narrowing on it also narrows `current` / `previous` to that
     * section's state type — no casts.
     *
     * By default changes are coalesced per microtask (see
     * `SubscribeManyOptions.batch`): everything that happened in one
     * synchronous flush arrives as a single call, with at most one entry per
     * address. A change that is reverted inside the same flush is dropped.
     *
     * Semantics shared with the selector-aware `subscribe`:
     * - the listener NEVER sees raw `undefined` for a valid section — a
     *   lazily-uninitialized, purged, or unresolvable routed address is read
     *   as the section's `initialState`;
     * - subscribing lazily initializes each direct (non-routed) address, just
     *   like a hook would;
     * - routed children subscribe on their PHYSICAL parent path;
     * - the listener is isolated: a throw is logged and never aborts other
     *   subscribers or the store dispatch;
     * - duplicate `(name, path)` targets are wired once (first wins);
     * - the returned unsubscribe is idempotent and detaches every target.
     *
     * ⚠️ These are real subscriptions, so the watched paths count as "in use"
     * and will defer a matching `purgeWhenUnused` until you unsubscribe.
     *
     * @example
     * const unsubscribeAll = store.subscribeMany(
     *     [
     *         { name: 'BaseInfo', path: '/baseInfo' },
     *         { name: 'Credential', path: '/credential' }
     *     ],
     *     changes => {
     *         for (const change of changes) {
     *             if (change.name === 'BaseInfo') {
     *                 // change.current is typed as BaseInfo's state here
     *             }
     *         }
     *     },
     *     { fireImmediately: true }
     * );
     */
    subscribeMany(
        targets: readonly SubscribeManyTarget<SM>[],
        listener: (changes: SubscribeManyChange<SM>[]) => void,
        options?: SubscribeManyOptions
    ): () => void;

    /**
     * Snapshots the state at `(name, path)` (resolved through routing) and
     * returns a `rollback()` function that restores it. Restoring an
     * unchanged value is a no-op (no notifications, no autosave); paths that
     * were purged after capture are safely ignored; repeated `rollback()`
     * calls are idempotent.
     */
    captureRollback<N extends keyof SM>(name: N, path: Path): () => void;

    /**
     * Snapshots every state entry whose path matches `pathPrefix`
     * (segment-aware, same semantics as `snapshotByPrefix`) and returns a
     * `rollback()` function that restores all of them at once.
     */
    captureRollback(pathPrefix: string): () => void;

    /**
     * Subscribes to hydration status transitions (see `HydrationStatus`).
     * The callback fires after every transition and alongside normal
     * subscriber isolation. Returns the unsubscribe function.
     */
    subscribeHydration(callback: () => void): () => void;

    /** The current hydration status (see `HydrationStatus`). */
    getHydrationStatus(): HydrationStatus;

    /**
     * A stable, memoized `HydrationResult` — the SAME object reference is
     * returned until the status transitions, so it is safe to feed to
     * `useSyncExternalStore` as a snapshot.
     */
    getHydrationSnapshot(): HydrationResult;

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
     * Whether hydration has settled (safe to stop warning about early init):
     *
     * - `true` once `hydrate()` finished (`'hydrated'`), recovered via
     *   quarantine (`'quarantined'`), hit a terminal failure (`'failed'`),
     *   or when no persistence is configured at all (nothing to wait for).
     * - `false` while `hydrate()` was not called yet (`'idle'`) or is still
     *   in flight (`'hydrating'`).
     *
     * This is the "settled" gate (not the snapshot's "usable data" flag):
     * it stays `true` after terminal `'failed'` so the dev-only early-init
     * warning in `init` fires at most once. For "is the data usable",
     * read `getHydrationSnapshot().isHydrated` (which is `false` on
     * `'failed'`) instead.
     *
     * Useful for gating rendering (`store.isHydrated() ? children : null`)
     * and for diagnostics. YASM also warns once per store, in development,
     * when a hook initializes a state before hydration finished — see
     * `hydrate()` for why mounting consumers first is discouraged (though
     * no longer data-loss-prone: merged persisted values are pushed into
     * mounted components by a post-hydration notification pass).
     */
    isHydrated: () => boolean;

    /**
     * Lifecycle-safe purge: schedules the destruction of every path matching
     * `pathPrefix` for the moment its last subscriber unsubscribes — or
     * executes it immediately when nothing is subscribed at call time.
     *
     * Unlike raw `purgeYasmState`, this never races React's asynchronous
     * unmounting, never warns, and re-verifies live subscribers at fire time
     * so revived or newly created paths (with mounted readers) under the
     * prefix are never wiped. Once the last matching subscriber leaves, the
     * destruction runs on the NEXT task (not inline), and live subscribers
     * are re-verified again right before executing — this bridges React's
     * synchronous detach/reattach windows such as StrictMode's double effect
     * invocation, where subscriptions transiently drop to zero mid-flush.
     *
     * ⚠️ Detection is subscription-based: a path recreated between scheduling
     * and firing purely through write-only hooks (`useYasmStateUpdater`,
     * which never subscribes) is invisible to the re-verification and is
     * destroyed with the rest of the prefix. Unmounting alone never purges —
     * the decision always stays with the caller. Pending purges are persisted
     * in snapshot metadata and re-scheduled (executed immediately, since
     * consumers are not mounted yet) during the next hydration.
     */
    purgeWhenUnused: (
        pathPrefix: string | string[],
        options?: PurgeOptions
    ) => void;

    /**
     * Deeply clones all state entries and routing registrations whose paths
     * match `sourcePrefix` into corresponding paths under `targetPrefix`.
     *
     * The cloned state is fully decoupled from the source (deep, serialized
     * copy) and every matching `pathRegistry` entry is duplicated too, so
     * routed children (`ArraySection` / `ObjectSection`) keep working on the
     * duplicate immediately. Matching is segment-aware by default
     * (`'/tabs/1'` never touches `'/tabs/10'`).
     *
     * @param sourcePrefix - The path prefix to copy from.
     * @param targetPrefix - The new path prefix to clone into.
     * @param options - Options to omit sections or transform cloned values.
     */
    cloneSubtree(
        sourcePrefix: string,
        targetPrefix: string,
        options?: CloneSubtreeOptions<SM>
    ): void;

    /**
     * Convenience wrapper around the exported {@link snapshotByPrefix}()
     * pre-bound to this store: returns a scoped debug/introspection snapshot
     * containing the state entries whose path matches `pathPrefix`
     * (segment-aware by default). Omitting the prefix snapshots the ENTIRE
     * store. Never logs by itself.
     *
     * @example
     * store.snapshotByPrefix('/tabs/12');                   // flat subtree
     * store.snapshotByPrefix('/tabs/12', { mode: 'tree' }); // 🌳 nested subtree
     * store.snapshotByPrefix(['/a', '/b']);                 // several subtrees
     * store.snapshotByPrefix();                             // whole store, flat
     * store.snapshotByPrefix({ mode: 'tree' });             // whole store as tree
     */
    snapshotByPrefix(
        pathPrefix: string | string[],
        options?: SnapshotByPrefixOptions<SM>
    ): Record<string, any>;
    snapshotByPrefix(
        options?: SnapshotByPrefixOptions<SM>
    ): Record<string, any>;

    /**
     * Internal method used to trigger change listeners and persistence mechanisms
     * immediately after a state mutation or purge. Hidden via Symbol.
     */
    [SYMBOL_NOTIFY_CHANGE]: () => void;

    /**
     * Internal method used by `purgeYasmState` to inform the deferred-purge
     * engine that a path's subscriber record was removed without a normal
     * unsubscribe. Hidden via Symbol.
     */
    [SYMBOL_NOTIFY_FORCED_UNSUBSCRIBE]: (name: Name, path: Path) => void;
} & Required<Pick<StoreOptions<SM>, 'serializer' | 'deserializer'>> & {
        debugOptions: Required<ResolvedDebugOptions>;
    };

const DEFAULT_SERIALIZER = (
    _object: Record<string, unknown>,
    _key: string,
    value: unknown
) => value;

const DEFAULT_DESERIALIZER = (_key: string, value: unknown) => value;

/** The default path segment boundaries: `'/'`, `'['` and `'.'`. */
const DEFAULT_PATH_BOUNDARY_CHARS = ['/', '[', '.'];

/** Internal bookkeeping for one deferred `purgeWhenUnused` schedule. */
type PendingPurge = {
    pathPrefix: string;
    match?: 'segment' | 'startsWith' | undefined;
    /**
     * `${name}\u0000${path}` keys of matching paths that still had
     * subscribers when the purge was scheduled (or at the last re-snapshot).
     */
    pendingKeys: Set<string>;
};

/**
 * Validates a persisted routing `pathRegistry` against the persisted state and
 * drops the entries that can no longer be resolved.
 *
 * A registered routing path stays valid when EITHER
 *
 *   (a) the section owns state at that path (a top-level routing parent, e.g.
 *       `Table` at `/table`), OR
 *   (b) the section is itself routed into another surviving registration (a
 *       composed parent nested inside another composed parent owns no state of
 *       its own — e.g. `Row` at `/table[5]` lives inside `Table`'s state).
 *
 * Checking only (a) silently deleted every (b) entry on each boot, so deeper
 * children (`/table[5][profile]`) could not resolve their parent after a reload
 * and fell back to direct storage, orphaning the real data inside the parent.
 *
 * Pruning runs to a fixpoint — a whole pass is evaluated against the set as it
 * was at the START of that pass, then the doomed entries are removed — so a
 * stale parent also invalidates everything registered underneath it, and the
 * result never depends on iteration order.
 *
 * Mutates `pathRegistry` in place and returns `true` when at least one entry
 * was removed (the caller turns that into a repair-save).
 *
 * @throws when a registry entry is not an array (corrupted snapshot); the
 *   caller's try/catch turns that into the documented quarantine flow.
 */
const pruneUnanchoredRegistrations = (
    pathRegistry: Record<string, string[]>,
    state: Record<string, Record<string, unknown> | undefined>,
    routingPlan: Record<string, string[] | undefined>,
    boundaryChars: string[]
): boolean => {
    const sectionNames = Object.keys(pathRegistry);

    const surviving = new Map<string, Set<string>>();
    for (const sectionName of sectionNames) {
        const paths = pathRegistry[sectionName];
        if (!Array.isArray(paths)) {
            throw new Error(
                `YASM: the persisted pathRegistry entry of section "${sectionName}" is not an array.`
            );
        }
        surviving.set(
            sectionName,
            new Set<string>(paths.filter(path => typeof path === 'string'))
        );
    }

    const isAnchored = (sectionName: string, path: string): boolean => {
        if (state[sectionName]?.[path] !== undefined) {
            return true;
        }

        const parentNames = routingPlan[sectionName];
        if (parentNames === undefined) {
            return false;
        }

        for (const parentName of parentNames) {
            const parentPaths = surviving.get(parentName);
            if (parentPaths === undefined) {
                continue;
            }
            for (const parentPath of Array.from(parentPaths)) {
                if (
                    parentPath !== path &&
                    isPathWithinPrefix(path, parentPath, boundaryChars)
                ) {
                    return true;
                }
            }
        }

        return false;
    };

    let removedInPass = true;
    while (removedInPass) {
        removedInPass = false;
        const doomed: [string, string][] = [];

        for (const sectionName of sectionNames) {
            for (const path of Array.from(surviving.get(sectionName)!)) {
                if (!isAnchored(sectionName, path)) {
                    doomed.push([sectionName, path]);
                }
            }
        }

        for (const [sectionName, path] of doomed) {
            surviving.get(sectionName)!.delete(path);
            removedInPass = true;
        }
    }

    let changed = false;
    for (const sectionName of sectionNames) {
        const survivingPaths = surviving.get(sectionName)!;
        const originalLength = pathRegistry[sectionName].length;

        pathRegistry[sectionName] = pathRegistry[sectionName].filter(
            path => typeof path === 'string' && survivingPaths.has(path)
        );

        if (pathRegistry[sectionName].length !== originalLength) {
            changed = true;
        }
    }

    return changed;
};

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
    // ⚠️ "settled" ≠ "hydrated": stays `true` after terminal `'failed'` too
    // (unlike snapshot `isHydrated`, which is `false` on `'failed'`).
    let hydrationSettled = false;
    let hydrationSuccess = false;

    // Observable hydration lifecycle (see `HydrationStatus`). A store without
    // persistence has nothing to wait for, so it boots straight into
    // `'hydrated'` exactly like `isHydrated()` reports.
    let hydrationStatus: HydrationStatus =
        options?.persist !== undefined ? 'idle' : 'hydrated';
    let hydrationError: unknown;
    let hydrationSnapshot: HydrationResult;

    // Maintain executed migrations metadata in memory (not in state)
    let executedMigrations = new Set<string>();

    // 🧹 Deferred purges (`purgeWhenUnused`): the app decides a subtree's
    // state is dead; the library destroys it at the first safe moment — the
    // instant the last subscriber of every matching path unsubscribes.
    let pendingPurges: PendingPurge[] = [];

    const SUBSCRIBER_KEY_SEPARATOR = '\u0000';
    const subscriberKey = (name: string, path: string) =>
        `${name}${SUBSCRIBER_KEY_SEPARATOR}${path}`;

    const pathMatchesEntry = (path: string, entry: PendingPurge) =>
        entry.match === 'startsWith'
            ? path.startsWith(entry.pathPrefix)
            : isPathWithinPrefix(path, entry.pathPrefix, boundaryChars);

    const collectSubscribedKeys = (
        pathPrefix: string,
        match: PurgeOptions['match']
    ) => {
        const keys = new Set<string>();
        for (const name of Object.keys(subscribers)) {
            const sectionSubscribers = (
                subscribers as Record<
                    string,
                    Record<Path, Record<number, () => void>>
                >
            )[name];

            for (const path of Object.keys(sectionSubscribers)) {
                if (Object.keys(sectionSubscribers[path]).length === 0) {
                    continue;
                }
                const isMatch =
                    match === 'startsWith'
                        ? path.startsWith(pathPrefix)
                        : isPathWithinPrefix(path, pathPrefix, boundaryChars);
                if (isMatch) {
                    keys.add(subscriberKey(name, path));
                }
            }
        }
        return keys;
    };

    const firePendingPurge = (store: Store<SM>, entry: PendingPurge) => {
        // 🔒 Re-verify against LIVE subscribers before scheduling destruction:
        // paths that were revived (e.g. a deleted row restored by a refetch) or
        // newly created under the prefix after scheduling must never be wiped —
        // keep the pending purge armed instead.
        const liveKeys = collectSubscribedKeys(entry.pathPrefix, entry.match);

        if (liveKeys.size > 0) {
            entry.pendingKeys = liveKeys;
            return;
        }

        // Keep the pending marker alive during the deferred window so snapshots
        // taken before the purge executes still contain enough information to
        // purge the state after a refresh.
        setTimeout(() => {
            // The entry may have been removed by a raw purge or another lifecycle
            // action while the timeout was pending.
            if (!pendingPurges.includes(entry)) {
                return;
            }

            // Destruction is deferred to the next task and re-verified immediately
            // before execution. React can detach and re-attach a subtree within one
            // synchronous flush (StrictMode double effects, concurrent transitions),
            // so a transient zero-subscriber window must never cause destruction.
            const liveKeysAtFire = collectSubscribedKeys(
                entry.pathPrefix,
                entry.match
            );

            if (liveKeysAtFire.size > 0) {
                entry.pendingKeys = liveKeysAtFire;
                return;
            }

            pendingPurges = pendingPurges.filter(pending => pending !== entry);

            purgeYasmState(
                store,
                entry.pathPrefix,
                entry.match === 'startsWith'
                    ? { match: 'startsWith' }
                    : undefined
            );
        }, 0);
    };

    const handleLastSubscriberLeft = (
        store: Store<SM>,
        name: string,
        path: string
    ) => {
        if (pendingPurges.length === 0) {
            return;
        }

        const key = subscriberKey(name, path);
        for (const entry of [...pendingPurges]) {
            if (!pathMatchesEntry(path, entry)) {
                continue;
            }
            entry.pendingKeys.delete(key);
            if (entry.pendingKeys.size === 0) {
                firePendingPurge(store, entry);
            }
        }
    };

    // 🔔 Notifies every live (section, path) subscriber once. Used after
    // hydration merges persisted data over the store: components that
    // mounted BEFORE `hydrate()` resolved are lazily initialized with the
    // default state, and React's `useSyncExternalStore` has no way to know
    // the snapshot behind it was replaced — without this ping those
    // components keep rendering stale defaults until an unrelated update.
    // Callbacks only trigger re-reads (`getState`), never writes, so a
    // snapshot copy of the records is enough to stay safe against
    // synchronous unsubscriptions mid-loop.
    // 🔒 Subscriber isolation: a callback that throws must never (a) abort
    // notification of the remaining subscribers, nor (b) escape into the
    // hydration error boundary — the post-hydrate notification pass runs
    // inside `hydrate()`'s try/catch, and an escaping error there would
    // misclassify VALID persisted data as "corrupted" and quarantine it.
    // User subscriber exceptions are logged and swallowed instead.
    const safeInvokeSubscriber = (callback: () => void) => {
        try {
            callback();
        } catch (error) {
            console.error(
                'YASM: a subscriber callback threw an exception. The error is isolated so other subscribers are still notified.',
                error
            );
        }
    };

    const buildHydrationSnapshot = (): HydrationResult => ({
        status: hydrationStatus,
        isHydrated:
            hydrationStatus === 'hydrated' ||
            hydrationStatus === 'quarantined' ||
            options?.persist === undefined,
        ...(hydrationError !== undefined ? { error: hydrationError } : {})
    });

    hydrationSnapshot = buildHydrationSnapshot();

    const hydrationSubscribers = new Set<() => void>();

    // 🔔 Publishes a hydration status transition (see `HydrationStatus`) to
    // every `useHydration` / `store.subscribeHydration` subscriber. The
    // snapshot object is replaced only on real transitions so
    // `useSyncExternalStore` sees a stable reference between them.
    const setHydrationStatus = (
        status: HydrationStatus,
        error?: unknown
    ): void => {
        const isChanged =
            hydrationStatus !== status || hydrationError !== error;

        hydrationStatus = status;
        hydrationError = error !== undefined ? error : undefined;

        if (!isChanged) {
            return;
        }

        hydrationSnapshot = buildHydrationSnapshot();

        for (const callback of Array.from(hydrationSubscribers)) {
            safeInvokeSubscriber(callback);
        }
    };

    const notifyAllSubscribers = () => {
        for (const name of Object.keys(subscribers)) {
            const sectionSubscribers = (
                subscribers as Record<
                    string,
                    Record<Path, Record<number, () => void>>
                >
            )[name];
            if (sectionSubscribers === undefined) {
                continue;
            }
            for (const path of Object.keys(sectionSubscribers)) {
                const record = sectionSubscribers[path];
                if (record === undefined) {
                    continue;
                }
                for (const id of Object.keys(record)) {
                    const callback = record[id as unknown as number];
                    if (callback !== undefined) {
                        safeInvokeSubscriber(callback);
                    }
                }
            }
        }
    };

    // 🔄 Restores a PHYSICAL (stored) `(name, path)` slot to a captured value
    // and replicates the exact notification fan-out of the memoized updater
    // (per-path subscribers + `SYMBOL_NOTIFY_CHANGE` → onStateChange/autosave).
    //
    // ⚠️ This bypasses the section updater ON PURPOSE: composed sections
    // (`ArraySection`/`ObjectSection`, custom routers) accept *command* payloads
    // (`{ order, addingItems, … }`), not raw state values — feeding a captured
    // state object into such an updater is silently ignored. Physical slots are
    // therefore restored by assignment, guarded by the same reference-equality
    // fast path the updater uses (an unchanged restore is a true no-op, so no
    // notifications fire and no autosave is scheduled).
    const restorePhysicalState = (
        store: Store<SM>,
        name: keyof SM,
        path: Path,
        value: unknown
    ): void => {
        const sectionState = (
            store.state as Record<Name, Record<Path, unknown>>
        )[name as Name];

        // Path was purged after capture (or never existed) — safely ignore so
        // a rollback never resurrects destroyed state.
        if (sectionState === undefined || sectionState[path] === undefined) {
            return;
        }

        // Reference-equality no-op: nothing changed between capture and
        // rollback → no notifications, no autosave churn.
        if (Object.is(sectionState[path], value)) {
            return;
        }

        sectionState[path] = value;

        store[SYMBOL_NOTIFY_CHANGE]();

        const pathSubscribers = (
            store.subscribers as Record<
                Name,
                Record<Path, Record<number, () => void>>
            >
        )[name as Name]?.[path];

        if (pathSubscribers !== undefined) {
            for (const id of Object.keys(pathSubscribers)) {
                const callback = pathSubscribers[id as unknown as number];
                if (callback !== undefined) {
                    safeInvokeSubscriber(callback);
                }
            }
        }
    };

    const schedulePurgeWhenUnused = (
        store: Store<SM>,
        pathPrefix: string,
        match: PurgeOptions['match']
    ) => {
        const pendingKeys = collectSubscribedKeys(pathPrefix, match);
        if (pendingKeys.size === 0) {
            // Nobody is subscribed right now — safe to destroy immediately.
            purgeYasmState(
                store,
                pathPrefix,
                match === 'startsWith' ? { match: 'startsWith' } : undefined
            );
            return;
        }

        // Replace any previous schedule for the same prefix (fresh snapshot).
        pendingPurges = pendingPurges.filter(
            entry => entry.pathPrefix !== pathPrefix || entry.match !== match
        );
        pendingPurges.push({ pathPrefix, match, pendingKeys });
    };

    const store: Store<SM> = {
        state: names.reduce((pre, name) => {
            pre[name] = {};
            return pre;
        }, {} as StateBySectionMap<SM>),
        subscribers,
        sectionMap,
        subscribe(
            callbackOrName: (() => void) | keyof SM,
            nameOrPath?: keyof SM | Path,
            pathOrSelector?: Path | ((state: any) => unknown),
            listener?: (
                selected: unknown,
                prevSelected: unknown | undefined
            ) => void,
            options: SubscribeSelectorOptions<unknown> | undefined = undefined
        ): () => void {
            // ── Selector-aware subscription ─────────────────────────────────
            if (typeof callbackOrName !== 'function') {
                const name = callbackOrName as keyof SM;
                const path = nameOrPath as Path;
                const selector = pathOrSelector as (state: any) => unknown;
                const onSelected = listener;

                if (
                    typeof selector !== 'function' ||
                    typeof onSelected !== 'function'
                ) {
                    throw new Error(
                        'YASM: selector-aware subscribe requires (name, path, selector, listener).'
                    );
                }

                // `init` lazily initializes the path (direct sections) so the
                // selector never evaluates a raw `undefined` for a valid
                // section.
                const record = init(store, name, path);

                const equality = options?.equality ?? 'shallow';
                const isEqual: (prev: unknown, next: unknown) => boolean =
                    typeof equality === 'function'
                        ? equality
                        : equality === 'strict'
                          ? Object.is
                          : shallowEqual;

                const readSelection = (): unknown => {
                    let state: unknown;
                    try {
                        state = record.getState();
                    } catch {
                        // A routed element that vanished (or never existed)
                        // cannot be read — fall back to the section baseline.
                        state = undefined;
                    }
                    if (state === undefined) {
                        state = store.sectionMap[name].initialState;
                    }
                    return selector(state);
                };

                const invokeIsolated = (
                    selected: unknown,
                    prevSelected: unknown | undefined
                ) => {
                    try {
                        onSelected(selected, prevSelected);
                    } catch (error) {
                        console.error(
                            'YASM: a selector-aware subscriber listener threw an exception. The error is isolated so other subscribers are still notified.',
                            error
                        );
                    }
                };

                // Establish the baseline eagerly: the first notification
                // compares against THIS selection, so an unchanged selection
                // never fires the listener (and `fireImmediately` reports
                // `(currentSelection, undefined)`).
                const initialSelected = readSelection();
                let lastSelected: unknown = initialSelected;
                let hasNotified = false;
                let unsubscribed = false;

                const notify = () => {
                    const selected = readSelection();

                    // Bail out when the selection did not actually change.
                    if (isEqual(lastSelected, selected)) {
                        return;
                    }

                    const prevSelected: unknown | undefined = hasNotified
                        ? lastSelected
                        : undefined;

                    lastSelected = selected;
                    hasNotified = true;

                    invokeIsolated(selected, prevSelected);
                };

                // Subscribe on the ROUTED (physical) path so the updater's
                // per-path fan-out reaches this subscriber.
                const rawUnsubscribe = record.subscribe(notify);

                if (options?.fireImmediately === true) {
                    // The initial selection is already the equality baseline, so notify()
                    // would bail out. Invoke the listener directly and treat this as the
                    // first delivered notification.
                    invokeIsolated(initialSelected, undefined);
                    hasNotified = true;
                }

                return () => {
                    if (unsubscribed) {
                        return;
                    }
                    unsubscribed = true;
                    rawUnsubscribe();
                };
            }

            // ── Low-level subscription (backward compatible) ────────────────
            const callback = callbackOrName as () => void;
            const name = nameOrPath as keyof SM;
            const path = pathOrSelector as Path;

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
                const sectionRecords = subscribers[name] as
                    Record<Path, Record<number, () => void>> | undefined;

                if (sectionRecords === undefined) {
                    return;
                }

                const record = sectionRecords[path];

                if (record !== undefined) {
                    delete record[id];

                    if (Object.keys(record).length === 0) {
                        // 🧹 Drop the emptied record itself: leaving `{}`
                        // behind made `subscribers[name]` grow with every path
                        // ever subscribed, and every subscriber scan
                        // (`collectSubscribedKeys` on each purgeWhenUnused,
                        // `notifyAllSubscribers` after hydration) walks that
                        // whole map.
                        delete sectionRecords[path];

                        // …then give deferred purges waiting on this path a
                        // chance to fire.
                        handleLastSubscriberLeft(store, name.toString(), path);
                    }
                }
            };
        },

        subscribeMany(
            targets: readonly SubscribeManyTarget<SM>[],
            listener: (changes: SubscribeManyChange<SM>[]) => void,
            options?: SubscribeManyOptions
        ): () => void {
            if (typeof listener !== 'function') {
                throw new Error(
                    'YASM: subscribeMany requires (targets, listener).'
                );
            }

            const batch = options?.batch ?? 'microtask';

            // Wire each address exactly once; the first occurrence wins.
            const seenTargetKeys = new Set<string>();
            const uniqueTargets: { name: keyof SM; path: Path }[] = [];
            for (const target of targets) {
                const targetKey = subscriberKey(
                    String(target.name),
                    target.path
                );
                if (seenTargetKeys.has(targetKey)) {
                    continue;
                }
                seenTargetKeys.add(targetKey);
                uniqueTargets.push({ name: target.name, path: target.path });
            }

            type ManyEntry = {
                name: keyof SM;
                path: Path;
                read: () => unknown;
                /** Value last handed to the listener. */
                delivered: unknown;
            };

            let unsubscribed = false;
            let flushScheduled = false;

            const entriesByKey = new Map<string, ManyEntry>();
            const pending = new Map<string, SubscribeManyChange<SM>>();

            const invokeIsolated = (changes: SubscribeManyChange<SM>[]) => {
                try {
                    listener(changes);
                } catch (error) {
                    console.error(
                        'YASM: a subscribeMany listener threw an exception. The error is isolated so other subscribers are still notified.',
                        error
                    );
                }
            };

            // Bookkeeping is settled BEFORE the listener runs, so a listener
            // that dispatches an update cannot observe a stale `previous`.
            const deliver = (
                pairs: [string, SubscribeManyChange<SM>][]
            ): void => {
                for (const [key, change] of pairs) {
                    const entry = entriesByKey.get(key);
                    if (entry !== undefined) {
                        entry.delivered = change.current;
                    }
                }
                invokeIsolated(pairs.map(pair => pair[1]));
            };

            const flush = () => {
                flushScheduled = false;
                if (unsubscribed || pending.size === 0) {
                    pending.clear();
                    return;
                }
                const pairs = Array.from(pending.entries());
                pending.clear();
                deliver(pairs);
            };

            const enqueue = (
                key: string,
                change: SubscribeManyChange<SM>
            ): void => {
                if (batch === 'sync') {
                    deliver([[key, change]]);
                    return;
                }
                pending.set(key, change);
                if (!flushScheduled) {
                    flushScheduled = true;
                    queueMicrotask(flush);
                }
            };

            const unsubscribers = uniqueTargets.map(target => {
                const key = subscriberKey(String(target.name), target.path);

                // `init` lazily initializes direct addresses so the listener
                // never observes a raw `undefined` for a valid section.
                const record = init(store, target.name, target.path);

                const read = (): unknown => {
                    let value: unknown;
                    try {
                        value = record.getState();
                    } catch {
                        // A routed element that vanished (or never existed)
                        // cannot be read — fall back to the section baseline.
                        value = undefined;
                    }
                    return value === undefined
                        ? store.sectionMap[target.name].initialState
                        : value;
                };

                entriesByKey.set(key, {
                    name: target.name,
                    path: target.path,
                    read,
                    delivered: read()
                });

                // Subscribe on the ROUTED (physical) path via the memoized
                // record, so the updater's per-path fan-out reaches us.
                return record.subscribe(() => {
                    if (unsubscribed) {
                        return;
                    }
                    const entry = entriesByKey.get(key);
                    if (entry === undefined) {
                        return;
                    }
                    const current = entry.read();
                    if (Object.is(current, entry.delivered)) {
                        // Reverted inside the same flush (or a no-op ping,
                        // e.g. the post-hydration notification pass).
                        pending.delete(key);
                        return;
                    }
                    // The heterogeneous per-section payload types make the
                    // discriminated union unconstructable without a cast —
                    // the same variance-safe widening `init` performs.
                    enqueue(key, {
                        name: entry.name,
                        path: entry.path,
                        current,
                        previous: entry.delivered
                    } as SubscribeManyChange<SM>);
                });
            });

            if (options?.fireImmediately === true && entriesByKey.size > 0) {
                invokeIsolated(
                    Array.from(entriesByKey.values()).map(
                        entry =>
                            ({
                                name: entry.name,
                                path: entry.path,
                                current: entry.delivered,
                                previous: undefined
                            }) as SubscribeManyChange<SM>
                    )
                );
            }

            return () => {
                if (unsubscribed) {
                    return;
                }
                unsubscribed = true;
                pending.clear();
                for (const unsubscribe of unsubscribers) {
                    unsubscribe();
                }
            };
        },

        captureRollback(nameOrPrefix: keyof SM | string, maybePath?: Path) {
            // ── Single (name, path) capture ─────────────────────────────────
            if (maybePath !== undefined) {
                const name = nameOrPrefix as keyof SM;
                const path = maybePath;

                // The memo record is keyed by path and holds heterogeneous
                // section payload types; the widened `any` payload mirrors the
                // identical variance-safe cast `init` itself performs.
                const record = init(store, name, path) as {
                    getState: () => SM[keyof SM]['initialState'];
                    updater: (payload: any) => void;
                };

                let captured: SM[keyof SM]['initialState'] | undefined;
                try {
                    captured = record.getState();
                } catch {
                    // An unroutable (never-initialized) routed element has no
                    // state to capture — fall back to the section baseline.
                    captured = undefined;
                }
                if (captured === undefined) {
                    captured = store.sectionMap[name].initialState;
                }

                const routeInfo = route(store, name as Name, path);
                const isRouted =
                    name !== routeInfo.routedName ||
                    path !== routeInfo.routedPath;

                if (isRouted) {
                    return () => {
                        try {
                            // 🔒 Re-verify element still exists: throws if vanished mid-session
                            const currentChildState =
                                routeInfo.getStateUnsafe();
                            if (Object.is(currentChildState, captured)) {
                                return;
                            }

                            const nextParentState =
                                routeInfo.applyReplacement(captured);
                            restorePhysicalState(
                                store,
                                routeInfo.routedName as keyof SM,
                                routeInfo.routedPath,
                                nextParentState
                            );
                        } catch {
                            // Backing element vanished since capture — safely ignore (no resurrection)
                            return;
                        }
                    };
                }

                return () => {
                    try {
                        restorePhysicalState(store, name, path, captured);
                    } catch {
                        // Unknown section — safely ignore.
                        return;
                    }
                };
            }

            // ── Path-prefix capture ─────────────────────────────────────────
            // Section names are `Name = string`; the cast narrows the generic
            // `keyof SM` union (which also admits `number | symbol`) to the
            // prefix string `snapshotByPrefix` accepts.
            const captured = snapshotByPrefix(store, nameOrPrefix as string, {
                serialize: false
            });

            // Every entry in a snapshot is a PHYSICAL (stored) slot, so all
            // restores go through `restorePhysicalState`.
            return () => {
                for (const sectionName of Object.keys(captured)) {
                    const paths = captured[sectionName];
                    if (paths === undefined) {
                        continue;
                    }

                    for (const path of Object.keys(paths)) {
                        try {
                            restorePhysicalState(
                                store,
                                sectionName as keyof SM,
                                path,
                                paths[path]
                            );
                        } catch {
                            // Unknown section — safely ignore.
                            continue;
                        }
                    }
                }
            };
        },

        subscribeHydration(callback: () => void) {
            hydrationSubscribers.add(callback);
            return () => {
                hydrationSubscribers.delete(callback);
            };
        },

        getHydrationStatus() {
            return hydrationStatus;
        },

        getHydrationSnapshot() {
            return hydrationSnapshot;
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
        serializer: options?.serializer ?? DEFAULT_SERIALIZER,
        deserializer: options?.deserializer ?? DEFAULT_DESERIALIZER,
        // The stored copy uses the variance-safe `ResolvedDebugOptions`
        // (see its docs): the generic input options are assignable at
        // runtime, and the widened `logStateUpdates`/`snapshotFilter` types
        // are sound because YASM only ever invokes them with events/filters
        // derived from THIS store's own section map.
        debugOptions: (options?.debugOptions ??
            {}) as Required<ResolvedDebugOptions>,

        async save() {
            const p = options?.persist;
            if (!p) {
                return;
            }

            // 🛡️ Prevent saving a fresh state over the DB before hydration finishes
            if (!hydrationSettled) {
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
            const omittedSections = [
                ...(typeof p.omitSections === 'function'
                    ? p.omitSections(store.state)
                    : p.omitSections || [])
            ];

            Object.entries(store.sectionMap).forEach(([key, section]) => {
                if (
                    section.persist === false &&
                    !omittedSections.includes(key as keyof SM)
                ) {
                    omittedSections.push(key as keyof SM);
                }
            });

            const stateToSave: Partial<StateBySectionMap<SM>> = {};
            const pathRegistryToSave: Partial<Record<Name, Path[]>> = {};

            Object.keys(store.state).forEach(sectionKey => {
                const key = sectionKey as keyof SM;
                if (!omittedSections.includes(key)) {
                    stateToSave[key] = { ...store.state[key] };
                }
            });

            Object.keys(store.pathRegistry).forEach(sectionKey => {
                const key = sectionKey as Name;
                if (!omittedSections.includes(key as keyof SM)) {
                    // Copy the array too: `init()` pushes new paths onto the
                    // live registry, which must not leak into this snapshot.
                    pathRegistryToSave[key] = [...store.pathRegistry[key]];
                }
            });

            const snapshotToSave: PersistedSnapshot<SM> = {
                state: stateToSave,
                pathRegistry: pathRegistryToSave,
                metadata: {
                    executedMigrations: Array.from(executedMigrations),
                    // Persist pending deferred purges so a refresh in the
                    // middle of a pending window cannot orphan state — the
                    // next hydration re-schedules (and, with nothing mounted,
                    // immediately executes) them.
                    pendingPurges: pendingPurges.map(entry => ({
                        pathPrefix: entry.pathPrefix,
                        match: entry.match
                    }))
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

        /**
         * Lifecycle-safe purge — see the `Store` type docs. Fires when the
         * last matching subscriber leaves (or immediately when unused).
         * Accepts a single prefix or an array of prefixes (each scheduled
         * independently).
         */
        purgeWhenUnused(pathPrefix: string | string[], options?: PurgeOptions) {
            const prefixes = Array.isArray(pathPrefix)
                ? pathPrefix
                : [pathPrefix];

            for (const prefix of prefixes) {
                schedulePurgeWhenUnused(store, prefix, options?.match);
            }
        },

        /**
         * Deeply clones all state entries and pathRegistry entries matching
         * `sourcePrefix` into corresponding paths under `targetPrefix`.
         */
        cloneSubtree(
            sourcePrefix: string,
            targetPrefix: string,
            options?: CloneSubtreeOptions<SM>
        ) {
            cloneYasmSubtree(store, sourcePrefix, targetPrefix, options);
        },

        /**
         * Pre-bound `snapshotByPrefix` — see the `Store` type docs for the
         * overloaded signatures and examples.
         */
        snapshotByPrefix(
            pathPrefixOrOptions?:
                string | string[] | SnapshotByPrefixOptions<SM>,
            maybeOptions?: SnapshotByPrefixOptions<SM>
        ) {
            if (
                typeof pathPrefixOrOptions === 'string' ||
                Array.isArray(pathPrefixOrOptions)
            ) {
                return snapshotByPrefix(
                    store,
                    pathPrefixOrOptions,
                    maybeOptions
                );
            }

            return snapshotByPrefix(store, pathPrefixOrOptions);
        },

        isHydrated() {
            // A store without persistence has nothing to wait for — it is
            // always "hydrated" from a consumer's point of view.
            // ⚠️ This doubles as the "hydration settled" gate for the
            // dev-only early-init warning in `init` (`useYasmState.ts`),
            // so it stays `true` after terminal `'failed'` (unlike
            // `getHydrationSnapshot().isHydrated`, which is `false` there).
            // Do NOT rewrite this as `this.getHydrationSnapshot().isHydrated`
            // — that both breaks destructured calls
            // (`const { isHydrated } = store`) and changes `'failed'` semantics.
            return hydrationSettled || options?.persist === undefined;
        },

        hydrate() {
            // Return existing promise if already hydrating (Single-flight / Idempotency)
            if (hydrationPromise) {
                return hydrationPromise;
            }

            const p = options?.persist;
            if (!p || !p.key || !p.storage) {
                hydrationSettled = true;
                hydrationSuccess = true;
                setHydrationStatus('hydrated');
                hydrationPromise = Promise.resolve();
                return hydrationPromise;
            }

            const { key, storage } = p;

            // 🔔 Consumers mount only when the status lands on `'hydrated'`,
            // `'quarantined'`, or (for stores without persistence) the
            // initial `'hydrated'` value.
            setHydrationStatus('hydrating');

            hydrationPromise = (async () => {
                let isStateChangedDuringHydration = false;

                let rawData: string | null | unknown = null;
                let persistedPendingPurges: {
                    pathPrefix: string;
                    match?: 'segment' | 'startsWith' | undefined;
                }[] = [];

                try {
                    rawData = await storage.getItem(key);
                } catch (error) {
                    console.error(
                        'YASM: Failed to hydrate state from storage.',
                        error
                    );
                    setHydrationStatus('failed', error);
                    hydrationSettled = true;
                    hydrationSuccess = false;
                    return;
                }

                try {
                    if (rawData) {
                        const parsed =
                            typeof rawData === 'string'
                                ? JSON.parse(rawData, options?.deserializer)
                                : rawData;

                        // A valid storage read may still contain a JSON
                        // primitive (for example, an old or corrupted
                        // snapshot containing `null`, a number or a string).
                        // Per the documented corruption contract, hand it to
                        // the quarantine flow below: the raw payload is backed
                        // up under `<key>_corrupted_backup_<timestamp>` and the
                        // primary key is overwritten with a clean snapshot.
                        // (`rawData` is truthy here, so an empty/fresh storage
                        // never reaches this branch.)
                        if (!parsed || typeof parsed !== 'object') {
                            throw new Error(
                                'YASM: the persisted snapshot root is not an object.'
                            );
                        }

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

                        // Capture deferred purges persisted by the
                        // previous session; re-scheduled after the merge.
                        const metadataPendingPurges =
                            parsed.metadata?.pendingPurges;
                        persistedPendingPurges = (
                            Array.isArray(metadataPendingPurges)
                                ? metadataPendingPurges
                                : []
                        ).filter(
                            entry => typeof entry?.pathPrefix === 'string'
                        );

                        // 1. Run Managed Schema Migrations
                        if (p.migrations) {
                            for (const [
                                sectionName,
                                sectionMigrations
                            ] of Object.entries(p.migrations)) {
                                const storedSection = parsed.state[sectionName];

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
                            if (!(sectionName in store.sectionMap)) {
                                delete parsed.state[sectionName];
                                isStateChangedDuringHydration = true;
                            }
                        });

                        Object.keys(parsed.pathRegistry).forEach(
                            sectionName => {
                                if (!(sectionName in store.pathRegistry)) {
                                    delete parsed.pathRegistry[sectionName];
                                    isStateChangedDuringHydration = true;
                                }
                            }
                        );

                        // 4. Validate Path Registry against parsed State.
                        // Routed composed parents own no state of their own, so
                        // they are anchored by their own surviving parent
                        // registration instead (see the helper's docs).
                        if (
                            pruneUnanchoredRegistrations(
                                parsed.pathRegistry,
                                parsed.state,
                                store.routingPlan as unknown as Record<
                                    string,
                                    string[] | undefined
                                >,
                                boundaryChars
                            )
                        ) {
                            isStateChangedDuringHydration = true;
                        }

                        // 5. Normalize state and clear transient fields
                        const norm = p.normalization;
                        const shouldNormalize = norm !== false;
                        const pruneStale =
                            typeof norm === 'object'
                                ? (norm.pruneStaleFields ?? true)
                                : true;

                        if (shouldNormalize) {
                            // Compares persisted values by their serialized
                            // form (using the store's serializer so custom
                            // types like BigInt/Decimal/Date are tagged
                            // consistently). Returns undefined when
                            // serialization fails — callers treat that as
                            // "changed" (conservative).
                            const serializeForCompare = (value: any) => {
                                try {
                                    return JSON.stringify(
                                        value,
                                        function (key, val) {
                                            return options?.serializer
                                                ? options.serializer(
                                                      this as Record<
                                                          string,
                                                          unknown
                                                      >,
                                                      key,
                                                      val
                                                  )
                                                : val;
                                        }
                                    );
                                } catch {
                                    return undefined;
                                }
                            };

                            // Extract the core normalization logic for reuse in nested sections
                            const defaultNormalize = (
                                storedVal: any,
                                initialVal: any,
                                secName: string
                            ) => {
                                if (initialVal === null) {
                                    if (storedVal !== null) {
                                        isStateChangedDuringHydration = true;
                                    }
                                    return null;
                                }

                                if (typeof initialVal !== 'object') {
                                    if (
                                        typeof storedVal ===
                                            typeof initialVal &&
                                        storedVal !== null
                                    ) {
                                        return storedVal;
                                    }
                                    isStateChangedDuringHydration = true;
                                    return initialVal;
                                }

                                if (Array.isArray(initialVal)) {
                                    if (!Array.isArray(storedVal)) {
                                        isStateChangedDuringHydration = true;
                                    }
                                    return Array.isArray(storedVal)
                                        ? storedVal
                                        : [...initialVal];
                                }

                                if (
                                    storedVal === null ||
                                    typeof storedVal !== 'object' ||
                                    Array.isArray(storedVal)
                                ) {
                                    // The stored shape does not match the
                                    // object-shaped initialState at all —
                                    // the returned replacement differs from
                                    // what is on disk, so persist it back.
                                    isStateChangedDuringHydration = true;
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

                                // Additive healing: keys that exist in the
                                // current initialState but are missing from
                                // the stored snapshot were just backfilled.
                                // The in-memory state is correct now, but it
                                // differs from what is on disk — mark the
                                // hydration as changed so the repair-save
                                // persists the healed value instead of
                                // re-healing it on every launch. (Only
                                // reachable when storedVal was an object;
                                // the primitive branch above replaces the
                                // whole value and is handled by callers.)
                                if (
                                    storedVal &&
                                    typeof storedVal === 'object' &&
                                    !Array.isArray(storedVal)
                                ) {
                                    for (const key of Object.keys(initialVal)) {
                                        if (!(key in storedVal)) {
                                            isStateChangedDuringHydration = true;
                                            break;
                                        }
                                    }
                                }

                                if (typeof norm === 'object') {
                                    Object.keys(merged).forEach(key => {
                                        let isTrans = false;

                                        // ⚠️ `RegExp.prototype.test` advances
                                        // `lastIndex` for /g and /y patterns,
                                        // which would let every second
                                        // matching field slip through.
                                        // `String#search` saves and restores
                                        // `lastIndex`, so matching stays
                                        // stateless and order-independent.
                                        if (
                                            norm.transientPatterns?.some(
                                                regex =>
                                                    key.search(regex) !== -1
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
                                                merged[key] !== initialVal[key]
                                            ) {
                                                merged[key] = initialVal[key];
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

                            Object.keys(parsed.state).forEach(sectionName => {
                                const section = store.sectionMap[sectionName];
                                const storedSection = parsed.state[sectionName];
                                const initial = section.initialState;

                                Object.keys(storedSection).forEach(path => {
                                    const storedValue = storedSection[path];

                                    // Delegate to the section's own normalizer when available (such as ArraySection)
                                    if (section.normalize) {
                                        // Snapshot the persisted
                                        // form BEFORE normalizing:
                                        // a normalize hook may
                                        // mutate `storedValue` in
                                        // place, which would taint
                                        // an afterwards-only
                                        // comparison.
                                        const beforeJson =
                                            serializeForCompare(storedValue);
                                        storedSection[path] = section.normalize(
                                            storedValue,
                                            context
                                        );
                                        // Only mark the hydration as changed when normalization actually
                                        // altered the persisted value — previously this was flagged
                                        // unconditionally, forcing a full repair-save on every boot for
                                        // every generated (Array/Object) section even when nothing changed.
                                        if (
                                            beforeJson === undefined ||
                                            beforeJson !==
                                                serializeForCompare(
                                                    storedSection[path]
                                                )
                                        ) {
                                            isStateChangedDuringHydration = true;
                                        }
                                    } else {
                                        // Otherwise, use the default normalizer
                                        storedSection[path] = defaultNormalize(
                                            storedValue,
                                            initial,
                                            sectionName
                                        );
                                    }
                                });
                            });
                        }

                        // 6. Merge safely into current state
                        // 🔒 (Deep merge paths to prevent overwriting paths created natively during hydration)
                        Object.keys(parsed.state).forEach(sectionName => {
                            const key = sectionName as keyof SM;
                            store.state[key] = {
                                ...store.state[key],
                                ...(parsed.state as any)[key]
                            };
                        });

                        Object.keys(parsed.pathRegistry).forEach(
                            sectionName => {
                                const key = sectionName as Name;
                                // 🔒 Ensure uniqueness when merging path registries
                                const existingPaths = new Set(
                                    store.pathRegistry[key] || []
                                );
                                (parsed.pathRegistry as any)[key].forEach(
                                    (p: string) => existingPaths.add(p)
                                );
                                store.pathRegistry[key] =
                                    Array.from(existingPaths);
                            }
                        );

                        // 7. Re-schedule deferred purges persisted by the
                        // previous session. Consumers are not mounted yet
                        // (hydrate gates rendering), so nothing is
                        // subscribed and they execute immediately — a
                        // refresh inside a pending window can never orphan
                        // state, and pre-purge snapshots self-heal.
                        if (persistedPendingPurges.length > 0) {
                            for (const pending of persistedPendingPurges) {
                                store.purgeWhenUnused(
                                    pending.pathPrefix,
                                    pending.match === 'startsWith'
                                        ? { match: 'startsWith' }
                                        : undefined
                                );
                            }

                            // Persist the purged snapshot (and clear the
                            // pending markers) through the repair-save.
                            isStateChangedDuringHydration = true;
                        }

                        // 8. Wake up any subscriber that mounted before
                        // hydration finished so it re-reads its (possibly
                        // replaced) state instead of showing the lazy
                        // default forever.
                        notifyAllSubscribers();
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

                    // 🔔 Entered the quarantine flow: the persisted payload is
                    // corrupted and will be backed up (if readable) while the
                    // primary key is reset to a clean snapshot.
                    setHydrationStatus('quarantined', error);

                    // 🛡️ Quarantine Strategy: Backing up corrupted data
                    if (rawData !== null && key && storage) {
                        let backupKey: string | null = null;
                        try {
                            const timestamp = new Date()
                                .toISOString()
                                .replace(/[:.]/g, '-');

                            const createdBackupKey = `${key}_corrupted_backup_${timestamp}`;
                            const dataToBackup =
                                typeof rawData === 'string'
                                    ? rawData
                                    : JSON.stringify(rawData);

                            await storage.setItem(
                                createdBackupKey,
                                dataToBackup
                            );
                            backupKey = createdBackupKey;
                            console.warn(
                                `YASM: Corrupted state backed up to "${createdBackupKey}". Starting fresh.`
                            );
                        } catch (backupError) {
                            console.error(
                                'YASM: Failed to create backup of corrupted state.',
                                backupError
                            );
                        }

                        // 🪝 Structured quarantine notification for the host
                        // application (Sentry, analytics, …). Isolated: a
                        // throwing `onQuarantine` must never prevent YASM
                        // from resetting storage and completing hydration.
                        if (p.onQuarantine) {
                            try {
                                await p.onQuarantine({
                                    key,
                                    backupKey,
                                    rawData,
                                    error
                                });
                            } catch (quarantineCallbackError) {
                                console.error(
                                    'YASM: onQuarantine callback failed.',
                                    quarantineCallbackError
                                );
                            }
                        }
                    }

                    // 1. Unlock so the user can save new information in the future
                    hydrationSuccess = true;

                    // 2. Tell YASM that the state has "changed" so it immediately
                    // overwrites the main database with a completely empty and clean state,
                    // thereby removing the corrupted data from the primary key.
                    isStateChangedDuringHydration = true;
                }

                hydrationSettled = true;

                // 7. If state was modified during hydration, persist it back to storage
                if (isStateChangedDuringHydration) {
                    try {
                        await store.save();
                    } catch (error) {
                        console.error(
                            'YASM: hydration failed irrecoverably — the repair-save could not write storage.',
                            error
                        );
                        setHydrationStatus('failed', error);
                        throw error;
                    }
                }

                // Normal completion. The catch block already published
                // `'quarantined'` (or `'failed'` above) — only an in-flight
                // hydration may land on `'hydrated'`.
                if (hydrationStatus === 'hydrating') {
                    setHydrationStatus('hydrated');
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

        [SYMBOL_NOTIFY_FORCED_UNSUBSCRIBE](name: Name, path: Path) {
            // A raw purge removes subscriber records without a normal unsubscribe.
            // Reconcile any pending deferred purge entries that cover the purged path
            // so dead markers are not persisted after the state has been destroyed.
            pendingPurges = pendingPurges.filter(
                entry => !pathMatchesEntry(path, entry)
            );

            handleLastSubscriberLeft(store, name.toString(), path);
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
            if (!hydrationSettled) {
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
                        await store.save();
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

    return store;
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
    SnapshotFilter,
    StoreOptions,
    PersistConfig,
    StateMigration,
    PersistedSnapshot,
    YasmPersistenceAdapter,
    HydrationStatus,
    HydrationResult,
    QuarantineInfo,
    SelectorEquality,
    SubscribeSelectorOptions,
    SubscribeManyTarget,
    SubscribeManyChange,
    SubscribeManyOptions
};
export {
    createStore,
    pruneUnanchoredRegistrations,
    SYMBOL_NOTIFY_CHANGE,
    SYMBOL_NOTIFY_FORCED_UNSUBSCRIBE,
    DEFAULT_PATH_BOUNDARY_CHARS,
    DEFAULT_SERIALIZER,
    DEFAULT_DESERIALIZER
};
