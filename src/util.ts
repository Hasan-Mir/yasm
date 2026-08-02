import { Immer } from 'immer';
import { DebugOptions, Name, Section, Updater } from './createStore';

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
type UpdatingKeyAndValue<T extends Record<string, unknown>> = {
    [key in keyof T]: {
        key: key;
        value: T[key];
    };
}[keyof T];

const propertyUpdaterGenerator =
    <S extends Record<string, unknown>>() =>
    (state: S, { key, value }: UpdatingKeyAndValue<S>) =>
        state[key] === value
            ? state
            : {
                  ...state,
                  [key]: value
              };

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
                return {
                    order: state.order,
                    map: {
                        ...state.map,
                        [index]: getNewState(subState, remainedPathQuery)
                    }
                };
            }
        }
    }
});

// Object composition
type SectionWithName = { name: Name; state: any; updater: Updater };
type ObjectSectionState<SM extends Record<string, SectionWithName>> = {
    [key in keyof SM]: SM[key]['state'];
};
type ObjectSection<SM extends Record<string, SectionWithName>> = Section<
    ObjectSectionState<SM>,
    { [key in keyof SM]?: Parameters<SM[key]['updater']>[1] }
>;

const extractObjectIndexAndRemainedPathQuery = (
    pathQuery: string
): [index: string, remainedPathQuery: string] | string => {
    if (pathQuery[0] === '[') {
        const closeBracketIndex = pathQuery.indexOf(']');
        if (closeBracketIndex !== -1) {
            const index = pathQuery.slice(1, closeBracketIndex);
            return [index, pathQuery.slice(closeBracketIndex + 1)];
        }
    }
    return 'invalid ObjectSection path!';
};

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
                    return {
                        ...state,
                        [index]: getNewState(subState, remainedPathQuery)
                    };
                }
            }
        ])
    )
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
const snapshot = (obj: Record<string, unknown>, debugOptions: DebugOptions) => {
    const encoded = preEncode(obj);

    const json = JSON.stringify(encoded, function (key, value) {
        return debugOptions.serializer
            ? debugOptions.serializer(this, key, value)
            : value;
    });

    const parsed = JSON.parse(json, debugOptions.deserializer);
    const restored = postDecode(parsed);

    console.debug(restored);
};

export {
    immer,
    snapshot,
    isPathWithinPrefix,
    arraySectionGenerator,
    extractArrayIndexAndRemainedPathQuery,
    extractObjectIndexAndRemainedPathQuery,
    getFieldSetter,
    mergeUpdaterGenerator,
    objectSectionGenerator,
    propertyUpdaterGenerator,
    type ArraySection,
    type ObjectSection,
    type ObjectSectionState,
    type SectionWithName,
    type UpdatingKeyAndValue
};
