import { Immer } from 'immer';
import {
    Name,
    Path,
    Section,
    Store,
    StoreOptions,
    Updater
} from './createStore';

const immer = new Immer();

/**
 * Segment-aware prefix matching.
 *
 * ```
 * isPathWithinPrefix('/tabs/1', '/tabs/1')       // true
 * isPathWithinPrefix('/tabs/1/child', '/tabs/1') // true
 * isPathWithinPrefix('/tabs/1[3]', '/tabs/1')    // true
 * isPathWithinPrefix('/tabs/1', '')              // true (e.g., purge('') clears all states)
 * isPathWithinPrefix('/tabs/10', '/tabs/1')      // false (!)
 * ```
 *
 * The last case is the important one: a plain `String.prototype.startsWith`
 * check would match `/tabs/10` too, which caused states of *other* tabs to be
 * purged (and their routing to be hijacked) whenever more than 9 tabs were
 * open.
 *
 * @param path - The path to test.
 * @param prefix - The prefix to test against; `''` matches every path.
 * @param boundaryChars - Characters that mark the start of a new segment.
 */
const isPathWithinPrefix = (
    path: string,
    prefix: string,
    boundaryChars: string[]
): boolean => {
    // An empty prefix matches all paths (e.g., full state wipe)
    if (prefix === '') {
        return true;
    }

    // Exact match
    if (path === prefix) {
        return true;
    }

    // If it doesn't even start with the prefix, it's definitely not a match
    if (!path.startsWith(prefix)) {
        return false;
    }

    // Check segment boundaries to avoid false positives (like '/tabs/1' matching '/tabs/10')
    const lastCharOfPrefix = prefix[prefix.length - 1];
    const firstCharAfterPrefix = path[prefix.length];

    // Handles cases where the prefix itself explicitly ends with a boundary (e.g., prefix: '/tabs/1/').
    // If it does, we already know it's a complete segment, avoiding the '/tabs/1' vs '/tabs/10' issue natively.
    const prefixEndsWithBoundaryChar = boundaryChars.includes(lastCharOfPrefix);

    const pathContinuesWithBoundaryChar =
        boundaryChars.includes(firstCharAfterPrefix);

    return prefixEndsWithBoundaryChar || pathContinuesWithBoundaryChar;
};

// updaters
/**
 * A strict `{ key, value }` pair for one property of `T` — the payload
 * shape consumed by `propertyUpdaterGenerator`.
 */
type UpdatingKeyAndValue<T extends Record<string, unknown>> = {
    [key in keyof T]: {
        key: key;
        value: T[key];
    };
}[keyof T];

/**
 * Creates an updater that sets a single property via a `{ key, value }`
 * payload. Setting an unchanged value returns the same state reference,
 * making the update a no-op (no notifications, no autosave).
 */
const propertyUpdaterGenerator =
    <S extends Record<string, unknown>>() =>
    (state: S, { key, value }: UpdatingKeyAndValue<S>) =>
        state[key] === value
            ? state
            : {
                  ...state,
                  [key]: value
              };

/**
 * Creates an updater that shallow-merges a `Partial<S>` payload into the
 * state. A payload whose every value is already current returns the same
 * state reference, making the update a no-op (no notifications, no
 * autosave).
 *
 * ⚠️ IMPORTANT — enable `exactOptionalPropertyTypes` in your tsconfig! The
 * payload is `Partial<S>`, and under TypeScript's default settings optional
 * properties also accept an *explicit* `undefined`. That means
 * `updateState({ age: undefined })` compiles even when `age: number`,
 * silently corrupting your state at runtime. With the flag enabled it
 * becomes a compile-time error, while genuinely nullable fields
 * (`age: number | undefined`) remain assignable.
 */
const mergeUpdaterGenerator =
    <S extends Record<string, unknown>>() =>
    (state: S, payload: Partial<S>) =>
        Object.keys(payload).every(key => state[key] === payload[key])
            ? state
            : {
                  ...state,
                  ...payload
              };

// Array composition
/**
 * The section signature built by `arraySectionGenerator`: a parent whose
 * state is an ordered map (`{ order, map }`) of child instances, with
 * add/edit/remove/order payload operations and `[id]` child routing.
 */
type ArraySection<S, P> = Section<
    {
        order: number[];
        map: Record<number, S>;
    },
    {
        order?: number[];
        addingItems?: { id: number; partialState?: Partial<S> }[];
        editingItems?: { id: number; itemPayload: P }[];
        removingIDs?: number[];
    }
>;

/**
 * Parses the leading `[index]` of an ArraySection path query and returns
 * `[index, remainedPathQuery]`, or an error string when the query is
 * malformed (missing brackets, empty `[]`, negative or non-integer index).
 */
const extractArrayIndexAndRemainedPathQuery = (
    pathQuery: string
): [index: number, remainedPathQuery: string] | string => {
    if (pathQuery[0] === '[') {
        const closeBracketIndex = pathQuery.indexOf(']');
        // `closeBracketIndex > 1` also rejects an empty index (`[]`), which
        // `Number('')` would otherwise silently coerce to `0`.
        if (closeBracketIndex > 1) {
            const rawIndex = pathQuery.slice(1, closeBracketIndex);
            const index = Number(rawIndex);
            if (Number.isInteger(index) && index >= 0) {
                return [index, pathQuery.slice(closeBracketIndex + 1)];
            }
        }
    }
    return 'invalid ArraySection path!';
};

/**
 * Builds a composed parent section whose state is an ordered map of child
 * states: `{ order: number[]; map: Record<number, S> }`.
 *
 * The parent updater payload supports `order`, `removingIDs`, `addingItems`
 * and `editingItems` (applied in that order), and the generated `routing`
 * lets child hooks address single rows through `[id]` path queries (e.g.
 * `useYasmState('UserRow', '/users[7]')`). The generated `normalize` hook
 * heals corrupted persisted data and applies child-level transient rules
 * during hydration.
 *
 * @param sectionName - The child section name; must be registered in
 *   `createStore` under the same name.
 * @param baseSection - The child section definition used for each row.
 */
const arraySectionGenerator = <S, P>(
    sectionName: Name,
    baseSection: Section<S, P>
): ArraySection<S, P> => ({
    initialState: { order: [], map: {} },
    updater: (state, { order, addingItems, editingItems, removingIDs }) => {
        if (order !== undefined) {
            state.order = order;
        }
        if (removingIDs !== undefined) {
            for (const removingID of removingIDs) {
                delete state.map[removingID];
            }
        }
        // Additions are applied before edits, so a payload may add an item and
        // edit it in the same update.
        if (addingItems !== undefined) {
            for (const { id, partialState } of addingItems) {
                state.map[id] = {
                    ...baseSection.initialState,
                    ...partialState
                };
            }
        }
        if (editingItems !== undefined) {
            for (const { id, itemPayload } of editingItems) {
                const itemState = state.map[id];
                if (itemState === undefined) {
                    if (process.env.NODE_ENV !== 'production') {
                        console.warn(
                            `YASM [Warning]: ArraySection "${sectionName.toString()}" received an editing payload for id "${id}" which does not exist in the map. The edit was skipped.`
                        );
                    }
                    continue;
                }
                const newValue = baseSection.updater(itemState, itemPayload);
                if (newValue !== undefined) {
                    state.map[id] = newValue;
                }
            }
        }
    },
    routing: {
        [sectionName]: {
            selectByPathQuery: (state, pathQuery) => {
                const indexAndRemainedPathQuery =
                    extractArrayIndexAndRemainedPathQuery(pathQuery);
                if (typeof indexAndRemainedPathQuery === 'string') {
                    throw new Error(
                        `YASM: ${indexAndRemainedPathQuery} (ArraySection of "${sectionName.toString()}", pathQuery: "${pathQuery}")`
                    );
                }
                const [index, remainedPathQuery] = indexAndRemainedPathQuery;
                const subState = state.map[index];
                if (subState === undefined) {
                    throw new Error(
                        `YASM: this path refers to an element (index ${index}) that has not been initialized (ArraySection of "${sectionName.toString()}").`
                    );
                }
                return [subState, remainedPathQuery];
            },
            updateByPathQuery: (state, pathQuery, getNewState) => {
                const indexAndRemainedPathQuery =
                    extractArrayIndexAndRemainedPathQuery(pathQuery);
                if (typeof indexAndRemainedPathQuery === 'string') {
                    throw new Error(
                        `YASM: ${indexAndRemainedPathQuery} (ArraySection of "${sectionName.toString()}", pathQuery: "${pathQuery}")`
                    );
                }
                const [index, remainedPathQuery] = indexAndRemainedPathQuery;
                const subState = state.map[index];
                if (subState === undefined) {
                    throw new Error(
                        `YASM: this path refers to an element (index ${index}) that has not been initialized (ArraySection of "${sectionName.toString()}").`
                    );
                }

                const newSubState = getNewState(subState, remainedPathQuery);

                // 🔒 Preserve reference equality if child state hasn't mutated
                if (newSubState === subState) {
                    return state;
                }

                return {
                    order: state.order,
                    map: {
                        ...state.map,
                        [index]: newSubState
                    }
                };
            }
        }
    },
    normalize: (storedValue, { defaultNormalize }) => {
        if (!storedValue || typeof storedValue !== 'object') {
            return { order: [], map: {} };
        }

        const newMap: Record<number, any> = {};

        if (storedValue.map && typeof storedValue.map === 'object') {
            for (const id in storedValue.map) {
                const numericId = Number(id);
                // An empty/whitespace key would coerce via Number('') === 0
                // and masquerade as a real row id.
                if (id.trim() !== '' && !Number.isNaN(numericId)) {
                    newMap[numericId] = defaultNormalize(
                        storedValue.map[id],
                        baseSection.initialState,
                        sectionName
                    );
                }
            }
        }

        // Drop order entries whose item did not survive normalization so
        // consumers never iterate over ids missing from the map.
        const rawOrder: unknown[] = Array.isArray(storedValue.order)
            ? storedValue.order
            : [];

        // 🛡️ Heal corrupted order data: coerce stringified ids to numbers,
        // drop non-numeric garbage (Number(null) === 0 and Number(true) === 1
        // would otherwise validate it as real ids), drop ids missing from
        // the map, and deduplicate (duplicates would surface as React
        // duplicate-key warnings downstream).
        const seenIds = new Set<number>();
        const order: number[] = [];
        for (const id of rawOrder) {
            let numericId = NaN;
            if (typeof id === 'number') {
                numericId = id;
            } else if (typeof id === 'string' && id.trim() !== '') {
                numericId = Number(id);
            }

            if (
                Number.isNaN(numericId) ||
                newMap[numericId] === undefined ||
                seenIds.has(numericId)
            ) {
                continue;
            }

            seenIds.add(numericId);
            order.push(numericId);
        }

        return {
            order,
            map: newMap
        };
    }
});

// Object composition
/** The child definition shape accepted by `objectSectionGenerator` per entry. */
type SectionWithName = { name: Name; state: any; updater: Updater };

/** Maps each child definition of an `objectSectionGenerator` map to its state type. */
type ObjectSectionState<SM extends Record<string, SectionWithName>> = {
    [key in keyof SM]: SM[key]['state'];
};

/**
 * The section signature built by `objectSectionGenerator`: a parent composed
 * of named child sections, addressable through `[childKey]` routing.
 */
type ObjectSection<SM extends Record<string, SectionWithName>> = Section<
    ObjectSectionState<SM>,
    { [key in keyof SM]?: Parameters<SM[key]['updater']>[1] }
>;

/**
 * Parses the leading `[key]` of an ObjectSection path query and returns
 * `[key, remainedPathQuery]`, or an error string when the query is
 * malformed (missing brackets or empty `[]`).
 */
const extractObjectIndexAndRemainedPathQuery = (
    pathQuery: string
): [index: string, remainedPathQuery: string] | string => {
    if (pathQuery[0] === '[') {
        const closeBracketIndex = pathQuery.indexOf(']');

        // `closeBracketIndex > 1` rejects an empty index (`[]`), ensuring
        // we don't accidentally extract an empty string `""` as a valid object key.
        if (closeBracketIndex > 1) {
            const index = pathQuery.slice(1, closeBracketIndex);
            return [index, pathQuery.slice(closeBracketIndex + 1)];
        }
    }
    return 'invalid ObjectSection path!';
};

/**
 * Builds a composed parent section from named child definitions (one
 * `{ name, state, updater }` entry per child key). Children are addressed
 * through `[childKey]` path queries (e.g.
 * `useYasmState('Profile', '/form[profile]')`) and update immutably inside
 * the parent state. Each child must also be registered in `createStore`
 * under the same name used in the map.
 *
 * @param sectionMap - Local key → child definition. The child `name` of
 *   each entry must match its registered section name.
 */
const objectSectionGenerator = <SM extends Record<string, SectionWithName>>(
    sectionMap: SM
): ObjectSection<SM> => ({
    initialState: Object.fromEntries(
        Object.entries(sectionMap).map(([key, { state }]) => [key, state])
    ) as ObjectSectionState<SM>,
    updater: (state, payload) => {
        for (const key in payload) {
            state[key] = immer.produce(state[key], (draft: any) =>
                sectionMap[key].updater(draft, payload[key])
            );
        }
    },
    routing: Object.fromEntries(
        Object.entries(sectionMap).map(([, { name }]) => [
            name,
            {
                selectByPathQuery: (state, pathQuery) => {
                    const indexAndRemainedPathQuery =
                        extractObjectIndexAndRemainedPathQuery(pathQuery);
                    if (typeof indexAndRemainedPathQuery === 'string') {
                        throw new Error(
                            `YASM: ${indexAndRemainedPathQuery} (ObjectSection of "${name.toString()}", pathQuery: "${pathQuery}")`
                        );
                    }
                    const [index, remainedPathQuery] =
                        indexAndRemainedPathQuery;
                    const subState = state[index];
                    if (subState === undefined) {
                        throw new Error(
                            `YASM: this path refers to a key ("${index}") that has not been initialized (ObjectSection of "${name.toString()}").`
                        );
                    }
                    return [subState, remainedPathQuery];
                },
                updateByPathQuery: (state, pathQuery, getNewState) => {
                    const indexAndRemainedPathQuery =
                        extractObjectIndexAndRemainedPathQuery(pathQuery);
                    if (typeof indexAndRemainedPathQuery === 'string') {
                        throw new Error(
                            `YASM: ${indexAndRemainedPathQuery} (ObjectSection of "${name.toString()}", pathQuery: "${pathQuery}")`
                        );
                    }
                    const [index, remainedPathQuery] =
                        indexAndRemainedPathQuery;
                    const subState = state[index];
                    if (subState === undefined) {
                        throw new Error(
                            `YASM: this path refers to a key ("${index}") that has not been initialized (ObjectSection of "${name.toString()}").`
                        );
                    }

                    const newSubState = getNewState(
                        subState,
                        remainedPathQuery
                    );

                    // 🔒 Preserve reference equality if child state hasn't mutated
                    if (newSubState === subState) {
                        return state;
                    }

                    return {
                        ...state,
                        [index]: newSubState
                    };
                }
            }
        ])
    ),
    normalize: (storedValue, { defaultNormalize }) => {
        const initial = Object.fromEntries(
            Object.entries(sectionMap).map(([key, { state }]) => [key, state])
        ) as ObjectSectionState<SM>;

        if (!storedValue || typeof storedValue !== 'object') {
            return { ...initial };
        }

        const newState: any = {};

        for (const key in sectionMap) {
            const childDef = sectionMap[key];
            newState[key] = defaultNormalize(
                storedValue[key],
                childDef.state,
                childDef.name
            );
        }

        return newState;
    }
});

const fieldSettersCache = new WeakMap<
    (
        payload: Partial<unknown> | ((state: unknown) => Partial<unknown>)
    ) => void | unknown, // The updateState function as the key
    Map<
        string | number | symbol,
        (valueOrCallback: unknown | ((prev: unknown) => unknown)) => void
    >
>();

/**
 * Returns a cached setter for one field of a section, built on top of its
 * updater. The setter accepts a value or a `(prev) => next` callback, and
 * the cache keeps the function reference stable per `(updateState, field)`
 * pair — safe for React dependency arrays.
 */
function getFieldSetter<TSection, TField extends keyof TSection>(
    updateState: (
        payload: Partial<TSection> | ((state: TSection) => Partial<TSection>)
    ) => void | TSection,
    field: TField
) {
    if (!fieldSettersCache.has(updateState)) {
        fieldSettersCache.set(updateState, new Map());
    }

    const fieldsCache = fieldSettersCache.get(updateState)!;

    if (!fieldsCache.has(field)) {
        const setterFunction = (
            valueOrCallback:
                | TSection[TField]
                | ((prev: TSection[TField]) => TSection[TField])
        ) => {
            updateState(
                prev =>
                    ({
                        [field]:
                            typeof valueOrCallback === 'function'
                                ? (
                                      valueOrCallback as (
                                          prevValue: TSection[TField]
                                      ) => TSection[TField]
                                  )(prev[field])
                                : valueOrCallback
                    }) as unknown as Partial<TSection>
            );
        };

        fieldsCache.set(
            field,
            setterFunction as (
                valueOrCallback: unknown | ((prev: unknown) => unknown)
            ) => void
        );
    }

    return fieldsCache.get(field) as (
        valueOrCallback:
            TSection[TField] | ((prev: TSection[TField]) => TSection[TField])
    ) => void;
}

const UNDEFINED_PLACEHOLDER_KEY = '__YASM_SNAP_UNDEF__';

const UNDEFINED_PLACEHOLDER = { [UNDEFINED_PLACEHOLDER_KEY]: true };

function isRawObject(value: unknown): value is Record<PropertyKey, unknown> {
    return (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        value.constructor === Object
    );
}

// Replaces `undefined` values with a placeholder so they survive the JSON
// round-trip inside debug snapshots (persistence drops them naturally and
// re-fills them from `initialState` during normalization).
function preEncode(value: unknown): unknown {
    if (value === undefined) {
        return UNDEFINED_PLACEHOLDER;
    }

    if (Array.isArray(value)) {
        return value.map(preEncode);
    }

    if (isRawObject(value)) {
        const res: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) {
            res[k] = preEncode(v);
        }
        return res;
    }

    return value;
}

// Restores placeholder objects produced by `preEncode` back into real`undefined` values.
function postDecode(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(postDecode);
    }

    if (isRawObject(value)) {
        if ((value as Record<string, unknown>)[UNDEFINED_PLACEHOLDER_KEY]) {
            return undefined;
        }

        const res: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) {
            res[k] = postDecode(v);
        }
        return res;
    }

    return value;
}

/**
 * Round-trips `obj` through the store's serializer/deserializer (preserving
 * `undefined` values via a placeholder) so the returned copy matches what
 * persistence would store. Pure — no console output.
 */
const serializeForSnapshot = <T>(
    obj: T,
    storeOptions: StoreOptions<any>
): T => {
    const encoded = preEncode(obj);

    const json = JSON.stringify(encoded, function (key, value) {
        return storeOptions.serializer
            ? storeOptions.serializer(
                  this as Record<string, unknown>,
                  key,
                  value
              )
            : value;
    });

    const parsed = JSON.parse(json, storeOptions.deserializer);
    return postDecode(parsed) as T;
};

/**
 * `serializeForSnapshot` with a safety net: debug tooling must NEVER crash
 * the update/purge it is logging. A throwing app serializer/deserializer
 * degrades the dump to the raw live value (warned once).
 */
const safeSerializeForSnapshot = <T>(
    value: T,
    storeOptions: StoreOptions<any>
): unknown => {
    try {
        return serializeForSnapshot(value, storeOptions);
    } catch (error) {
        console.error(
            'YASM [Error]: serializing a debug snapshot threw — dumping the raw live value instead. Check your serializer/deserializer: it should CONSTRUCT new instances (e.g. new Decimal(…)) and never mutate its inputs.\n',
            error
        );

        return value;
    }
};

/**
 * Logs a debug snapshot of `obj` to the console, round-tripping it through
 * the store's serializer/deserializer and preserving `undefined` values (via
 * a placeholder) so the logged copy matches what persistence would store.
 */
const snapshot = (
    obj: Record<string, unknown>,
    storeOptions: StoreOptions<any>
) => {
    console.debug(safeSerializeForSnapshot(obj, storeOptions));
};

/**
 * Builds a scoped debug/introspection snapshot containing the state entries
 * whose path matches `pathPrefix` (segment-aware by default). Overloaded for
 * every call shape:
 *
 * - `snapshotByPrefix(store, pathPrefix, options?)` — one subtree (or an
 *   array of subtrees).
 * - `snapshotByPrefix(store, options?)` — the ENTIRE store.
 *
 * This is the imperative primitive behind `debugOptions.snapshotFilter`:
 * it never logs by itself — pass the result to `console.debug`, stringify it,
 * diff two calls around an update, or assert on it in tests.
 *
 * Matching uses the same `isPathWithinPrefix` semantics as purge (including
 * custom `pathBoundaryChars`), so `/tabs/1` can never accidentally match
 * `/tabs/10`. An empty prefix matches everything.
 *
 * @example
 * snapshotByPrefix(store, '/tabs/12');                    // flat subtree
 * snapshotByPrefix(store, '/tabs/12', { mode: 'tree' });  // nested subtree
 * snapshotByPrefix(store, ['/a', '/b']);                  // several subtrees
 * snapshotByPrefix(store);                                // ENTIRE store, flat
 * snapshotByPrefix(store, { mode: 'tree' });              // ENTIRE store as tree
 */
function snapshotByPrefix<SM extends Record<Name, Section>>(
    store: Store<SM>,
    pathPrefix: string | string[],
    options?: SnapshotByPrefixOptions<SM>
): Record<string, any>;
function snapshotByPrefix<SM extends Record<Name, Section>>(
    store: Store<SM>,
    options?: SnapshotByPrefixOptions<SM>
): Record<string, any>;
function snapshotByPrefix<SM extends Record<Name, Section>>(
    store: Store<SM>,
    pathPrefixOrOptions?: string | string[] | SnapshotByPrefixOptions<SM>,
    maybeOptions?: SnapshotByPrefixOptions<SM>
): Record<string, any> {
    const hasExplicitPrefix =
        typeof pathPrefixOrOptions === 'string' ||
        Array.isArray(pathPrefixOrOptions);

    const prefixesInput: string | string[] = hasExplicitPrefix
        ? (pathPrefixOrOptions as string | string[])
        : '';

    const options: SnapshotByPrefixOptions<SM> | undefined =
        !hasExplicitPrefix && pathPrefixOrOptions !== undefined
            ? (pathPrefixOrOptions as SnapshotByPrefixOptions<SM>)
            : maybeOptions;

    const mode = options?.mode ?? 'flat';
    const match = options?.match ?? 'segment';
    const shouldSerialize = options?.serialize ?? true;
    const boundaryChars = store.pathBoundaryChars;

    const sectionFilters =
        options?.sectionFilter === undefined
            ? undefined
            : Array.isArray(options.sectionFilter)
              ? options.sectionFilter
              : [options.sectionFilter];

    const prefixes = Array.isArray(prefixesInput)
        ? prefixesInput
        : [prefixesInput];

    const matches = (path: string) =>
        prefixes.some(prefix =>
            match === 'startsWith'
                ? path.startsWith(prefix)
                : match === 'exact'
                  ? path === prefix
                  : isPathWithinPrefix(path, prefix, boundaryChars)
        );

    type Entry = { section: Name; path: Path; value: unknown };
    const entries: Entry[] = [];

    for (const sectionKey of Object.keys(store.state) as Name[]) {
        if (
            sectionFilters !== undefined &&
            !sectionFilters.includes(sectionKey)
        ) {
            continue;
        }

        const sectionState = store.state[sectionKey];
        if (sectionState === undefined) {
            continue;
        }
        for (const path of Object.keys(sectionState)) {
            if (!matches(path)) {
                continue;
            }
            entries.push({
                section: sectionKey,
                path,
                value: shouldSerialize
                    ? safeSerializeForSnapshot(sectionState[path], store)
                    : sectionState[path]
            });
        }
    }

    if (mode === 'flat') {
        const result: Record<string, Record<string, unknown>> = {};
        for (const entry of entries) {
            const sectionBucket = (result[entry.section as string] ??= {});
            sectionBucket[entry.path] = entry.value;
        }
        return result;
    }

    // ---- tree mode -------------------------------------------------------
    // Group by physical path first: multiple sections may own the exact same
    // path (routed/composed setups). Then nest each path under its CLOSEST
    // collected ancestor (longest matching proper prefix), processing paths
    // shortest-first so parents are always created before their children.
    const sectionsByPath = new Map<string, Record<string, unknown>>();
    for (const entry of entries) {
        let bucket = sectionsByPath.get(entry.path);
        if (bucket === undefined) {
            bucket = {};
            sectionsByPath.set(entry.path, bucket);
        }
        bucket[entry.section as string] = entry.value;
    }

    type TreeNode = {
        __state__: Record<string, unknown>;
        __children__: Record<string, unknown>;
        __subscribers__?: number;
    };

    const nodes = new Map<string, TreeNode>();
    const nodeFor = (path: string): TreeNode => {
        let node = nodes.get(path);
        if (node === undefined) {
            node = { __state__: {}, __children__: {} };
            nodes.set(path, node);
        }
        return node;
    };

    const subscriberCount = (path: string): number => {
        let count = 0;
        for (const sectionName of Object.keys(sectionsByPath.get(path) ?? {})) {
            const record = (store.subscribers as any)[sectionName]?.[path];
            if (record !== undefined) {
                count += Object.keys(record).length;
            }
        }
        return count;
    };

    const tree: Record<string, unknown> = {};

    const sortedPaths = Array.from(sectionsByPath.keys()).sort(
        (a, b) => a.length - b.length
    );
    for (const path of sortedPaths) {
        const node = nodeFor(path);
        node.__state__ = sectionsByPath.get(path)!;
        if (options?.includeSubscribers === true) {
            node.__subscribers__ = subscriberCount(path);
        }

        // Closest collected ancestor = longest other path that is a valid
        // segment-aware proper prefix of this one. Paths were inserted
        // shortest-first, so every candidate already exists in `nodes`.
        let closestAncestor: TreeNode | undefined;
        let ancestorLength = 0;
        for (const [candidatePath, candidateNode] of Array.from(nodes)) {
            if (
                candidatePath !== path &&
                candidatePath.length > ancestorLength &&
                candidatePath.length < path.length &&
                isPathWithinPrefix(path, candidatePath, boundaryChars)
            ) {
                closestAncestor = candidateNode;
                ancestorLength = candidatePath.length;
            }
        }

        if (closestAncestor !== undefined) {
            closestAncestor.__children__[path] = node;
        } else {
            tree[path] = node;
        }
    }

    return tree;
}

type MemoryStorage = {
    getItem: (key: string) => Promise<string | null>;
    setItem: (key: string, value: string) => Promise<void>;
    removeItem: (key: string) => Promise<void>;
    clear: () => Promise<void>;
    /** Direct access for test assertions. */
    readonly data: Map<string, string>;
};

/**
 * Creates an in-memory `YasmPersistenceAdapter` for tests, stories and SSR —
 * the same shape `createStore({ persist: { storage } })` expects. Removes the
 * need to hand-roll a mock storage in every persistence test.
 *
 * @example
 * const storage = createMemoryStorage();
 * const store = createStore(APP_SECTIONS, {
 *     persist: { key: 'test-state', storage }
 * });
 *
 * // Assert directly on the backing Map in tests:
 * await store.save();
 * assert.ok(storage.data.get('test-state'));
 */
const createMemoryStorage = (): MemoryStorage => {
    const data = new Map<string, string>();
    return {
        getItem: async key => data.get(key) ?? null,
        setItem: async (key, value) => {
            data.set(key, value);
        },
        removeItem: async key => {
            data.delete(key);
        },
        clear: async () => {
            data.clear();
        },
        data
    };
};

const padNumber = (value: number, length = 2): string =>
    String(value).padStart(length, '0');

/** Default dimmed dev-log timestamp: local `HH:MM:SS.mmm`. */
const DEFAULT_DEBUG_TIMESTAMP_FORMAT = (date: Date): string =>
    `${padNumber(date.getHours())}:${padNumber(date.getMinutes())}:${padNumber(
        date.getSeconds()
    )}.${padNumber(date.getMilliseconds(), 3)}`;

/** A styled/unstyled text segment of a development log line. */
type DebugLogPart = { text: string; style?: string };

/** Dimmed gray used for the default dev-log timestamp. */
const DEBUG_TIMESTAMP_STYLE = 'color: #6b7280;';

/**
 * Resolves the conditional dimmed-timestamp segment prefixed to development
 * log lines (`YASM: updating…`, `🧹 YASM purging…`, `Before:`, `After:` …).
 *
 * Controlled by `debugOptions.timestampFormatter`:
 * - `undefined` (default): dimmed local `HH:MM:SS.mmm`.
 * - `(date) => string`: full control (e.g. `d => d.toLocaleTimeString()`).
 * - `false`: disabled entirely (also when a custom formatter returns '').
 *
 * Internal helper — consumed by `composeDebugLogArgs`; do not spread its
 * result into `console.debug(...)` directly or `%c` ordering can drift.
 */
const debugTimestampPart = (debugOptions: {
    timestampFormatter?: ((date: Date) => string) | false;
}): DebugLogPart | undefined => {
    if (debugOptions.timestampFormatter === false) {
        return undefined;
    }
    const date = new Date();
    const text = debugOptions.timestampFormatter
        ? debugOptions.timestampFormatter(date)
        : DEFAULT_DEBUG_TIMESTAMP_FORMAT(date);
    if (!text) {
        return undefined;
    }
    return { text: `${text} `, style: DEBUG_TIMESTAMP_STYLE };
};

/**
 * Legacy shape of the timestamp segment (`[`%c… `, style]`). Kept for
 * backward compatibility with external imports — new code should go through
 * `composeDebugLogArgs` / `debugTimestampPart`.
 */
const debugTimestampArgs = (store: {
    debugOptions?: {
        timestampFormatter?: ((date: Date) => string) | false;
    };
}): unknown[] => {
    const part = debugTimestampPart(store.debugOptions ?? {});
    return part ? [`%c${part.text}`, part.style] : [];
};

/** Matches a letter, number, or underscore (ASCII + Latin-1 supplement). */
const LOG_WORD_CHAR = /[A-Za-z0-9_\u00C0-\u024F]/;

/**
 * Dev-only readability guard for development log lines: the text parts render
 * ADJACENT to each other, so when one part ends with a word character and the
 * next begins with one they mash together — e.g. `"YASM purging"` +
 * `"paths matching…"` → `"purgingpaths"`. Warns once per offending seam with
 * enough context to fix the call site.
 */
const warnAboutUnreadableLogSeams = (texts: string[]): void => {
    if (process.env.NODE_ENV === 'production') {
        return;
    }

    for (let i = 1; i < texts.length; i++) {
        // ⚠️ Use the RAW boundary characters — a trailing/leading space at
        // the seam IS the separator, so trimming here would flag healthy
        // parts ("…purging " + "Filtered…" renders as "purging Filtered").
        const prevEnd = texts[i - 1].slice(-1);
        const nextStart = texts[i].slice(0, 1);

        if (
            prevEnd !== '' &&
            nextStart !== '' &&
            LOG_WORD_CHAR.test(prevEnd) &&
            LOG_WORD_CHAR.test(nextStart)
        ) {
            console.warn(
                `YASM [Warning]: dev-log parts "${texts[
                    i - 1
                ].trim()}" and "${texts[i].trim()}" render mashed together as "...${prevEnd}${nextStart}..." — add a separator space at that seam.`
            );
        }
    }
};

/**
 * Composes a full `console.debug` argument list for development logs,
 * guaranteeing `%c`/style-argument parity:
 *
 * - a conditional dimmed timestamp segment (see `debugTimestampPart`);
 * - one entry per styled/unstyled text part;
 * - trailing raw values (payloads, path arrays…).
 *
 * Styled lines are emitted as ONE format string in which every `%c` is
 * immediately followed by `%s` (`'%c%s %c%s …'` + interleaved style/text
 * arguments) instead of adjacent bare `%c…` string arguments. Some console
 * wrappers only honor the FIRST `%c` of adjacent bare `%c` arguments and
 * print the remaining ones literally (raw `%c` markers + CSS in the output),
 * while chained `%c`/`%s` specifiers inside a single format string render
 * correctly everywhere.
 *
 * All dev-log call sites MUST go through this composer — hand-assembling
 * `%c` arguments is how style counts drift out of sync and consoles end up
 * printing literal `%c` and raw CSS.
 */
const composeDebugLogArgs = (
    store: {
        debugOptions?: {
            timestampFormatter?: ((date: Date) => string) | false;
            disableLogStyling?: boolean;
        };
    },
    parts: DebugLogPart[],
    ...tail: unknown[]
): unknown[] => {
    const debugOptions = store.debugOptions ?? {};

    // Dev-only readability check — must run for BOTH output modes BEFORE any
    // early return: the parts render adjacent in either mode, so a missing
    // separator would silently produce e.g. "YASM purgingpaths".
    if (process.env.NODE_ENV !== 'production') {
        warnAboutUnreadableLogSeams([
            debugTimestampPart(debugOptions)?.text ?? '',
            ...parts.map(part => part.text)
        ]);
    }

    // Plain mode (`disableLogStyling: true`): ONE pre-joined string, zero %c —
    // safe in consoles that don't support chained %c styling (Node/SSR,
    // vConsole/eruda, logger wrappers).
    if (debugOptions.disableLogStyling === true) {
        const date = new Date();
        const ts =
            debugOptions.timestampFormatter === false
                ? ''
                : debugOptions.timestampFormatter
                  ? debugOptions.timestampFormatter(date)
                  : DEFAULT_DEBUG_TIMESTAMP_FORMAT(date);
        const line = `${ts ? `[${ts}] ` : ''}${parts
            .map(part => part.text)
            .join('')}`;
        return tail.length > 0 ? [line, ...tail] : [line];
    }

    const tsPart = debugTimestampPart(debugOptions);

    // Fast path: nothing styled anywhere (timestamps off + unstyled parts) —
    // emit plain arguments with no format string at all.
    if (!tsPart && parts.every(part => part.style === undefined)) {
        const text = parts.map(part => part.text).join('');
        return tail.length > 0 ? [text, ...tail] : [text];
    }

    // Styled mode: single format string, every %c paired with %s.
    //
    // ⚠️ %c styling PERSISTS until the next %c — without an explicit reset
    // (`%c` + empty style argument), the dimmed timestamp / badge colors
    // would bleed into every following text segment. A reset is emitted
    // right before any unstyled content that follows a styled segment.
    const specifiers: string[] = [];
    const substitutions: unknown[] = [];
    let styleOpen = false;
    const closeStyle = () => {
        if (styleOpen) {
            specifiers.push('%c');
            substitutions.push('');
            styleOpen = false;
        }
    };
    for (const part of tsPart ? [tsPart, ...parts] : parts) {
        if (part.style !== undefined) {
            specifiers.push('%c%s');
            substitutions.push(part.style, part.text);
            styleOpen = true;
        } else {
            closeStyle();
            specifiers.push('%s');
            substitutions.push(part.text);
        }
    }
    if (tail.length > 0) {
        closeStyle();
    }

    const args: unknown[] = [specifiers.join(''), ...substitutions];
    if (tail.length > 0) {
        args.push(...tail);
    }
    return args;
};

type SnapshotMode = 'flat' | 'tree';

type SnapshotByPrefixOptions<
    SM extends Record<Name, Section> = Record<Name, Section>
> = {
    /**
     * - `'flat'` (default): section → path → state. Best for scanning/searching.
     * - `'tree'`: paths nested by segment-aware containment, closest physical
     *   ancestor first. Sections owning the exact path are grouped under
     *   `__state__`; children under `__children__`.
     */
    mode?: SnapshotMode;

    /**
     * How `pathPrefix` is matched against stored paths:
     *
     * - `'segment'` (default): subtree semantics — `/tabs/1` matches
     *   `/tabs/1` itself plus every descendant (`/tabs/1/x`, `/tabs/1[0]`)
     *   but never `/tabs/10`.
     * - `'exact'`: only paths EQUAL to a given prefix are included — ideal
     *   for watching a single state slot without its whole subtree.
     * - `'startsWith'`: raw `String.prototype.startsWith` matching (legacy).
     */
    match?: 'segment' | 'startsWith' | 'exact';

    /**
     * When true (default), values are round-tripped through the store's
     * serializer/deserializer so BigInt/Decimal/Date render exactly like
     * persistence would write them. Set false for a cheap live-reference dump.
     *
     * @default true
     */
    serialize?: boolean;

    /**
     * Include only state entries from these sections — hide unrelated or
     * noisy sections from the snapshot dump. Autocompleted from the
     * sections of the store.
     */
    sectionFilter?: keyof SM | (keyof SM)[];
    /**
     * Tree mode only: attach the live subscriber count per path node
     * (`__subscribers__`) so leak/purge debugging doesn't need internals.
     *
     * @default false
     */
    includeSubscribers?: boolean;
};

/**
 * Deeply freezes a plain object/array tree to prevent mutation in development
 * environments. Handles circular references, avoids invoking getters, and
 * includes symbols.
 *
 * ⚠️ ONLY plain objects and arrays are frozen — class instances (e.g.,
 * Decimal) are left COMPLETELY untouched on purpose: they often carry an own
 * `constructor` property pointing at the shared class function, and freezing
 * that would freeze the class itself and its prototype, breaking ALL future
 * constructions of it (`x.constructor = …` throws "Cannot assign to read
 * only property 'constructor'") — as seen with decimal.js clones.
 */
const deepFreeze = <T>(
    obj: T,
    seen: WeakSet<object> = new WeakSet<object>()
): T => {
    // Base case: primitives, null, functions, and CLASS INSTANCES are skipped
    // entirely — only arrays and plain objects are frozen/traversed.
    if (!Array.isArray(obj) && !isRawObject(obj)) {
        return obj;
    }

    // Prevent infinite recursion on circular references
    if (seen.has(obj)) {
        return obj;
    }
    seen.add(obj);

    // Use descriptors to safely traverse properties without invoking getters
    const descriptors = Object.getOwnPropertyDescriptors(obj);

    for (const key of Reflect.ownKeys(descriptors)) {
        const descriptor = descriptors[key as keyof typeof descriptors];

        // Only recurse into standard value properties (not getter/setter)
        // that are themselves plain objects or arrays.
        if ('value' in descriptor) {
            const value = descriptor.value;

            if (Array.isArray(value) || isRawObject(value)) {
                deepFreeze(value, seen);
            }
        }
    }

    return Object.freeze(obj);
};

export {
    arraySectionGenerator,
    composeDebugLogArgs,
    createMemoryStorage,
    debugTimestampArgs,
    deepFreeze,
    extractArrayIndexAndRemainedPathQuery,
    extractObjectIndexAndRemainedPathQuery,
    getFieldSetter,
    immer,
    isPathWithinPrefix,
    mergeUpdaterGenerator,
    objectSectionGenerator,
    propertyUpdaterGenerator,
    serializeForSnapshot,
    snapshot,
    snapshotByPrefix,
    type ArraySection,
    type MemoryStorage,
    type ObjectSection,
    type ObjectSectionState,
    type SectionWithName,
    type SnapshotByPrefixOptions,
    type SnapshotMode,
    type UpdatingKeyAndValue
};
