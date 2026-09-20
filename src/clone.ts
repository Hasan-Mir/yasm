import {
    DEFAULT_DESERIALIZER,
    DEFAULT_SERIALIZER,
    SYMBOL_NOTIFY_CHANGE,
    Name,
    Path,
    Section,
    Store,
    pruneUnanchoredRegistrations
} from './createStore';
import {
    composeDebugLogArgs,
    deepFreeze,
    isPathWithinPrefix,
    serializeForSnapshot
} from './util';

import { rebindRoutedMemos } from './useYasmState';

type CloneSubtreeOptions<
    SM extends Record<Name, Section> = Record<Name, Section>
> = {
    /**
     * How `sourcePrefix` is matched against stored paths:
     *
     * - `'segment'` (default): `'/tabs/1'` matches `'/tabs/1'`, `'/tabs/1/x'`
     *   and `'/tabs/1[0]'` but NOT `'/tabs/10'`.
     * - `'startsWith'`: raw `String.prototype.startsWith` matching.
     *
     * @default 'segment'
     */
    match?: 'segment' | 'startsWith';

    /**
     * Section names to explicitly omit from the clone process.
     * Useful for skipping temporary dialogs or transient view state.
     */
    omitSections?: (keyof SM)[];

    /**
     * Optional transformation callback executed for each cloned value
     * before it is saved at the target path.
     *
     * Declared with method syntax (not an arrow-typed property) on
     * purpose: `sectionName` sits in a contravariant position, and method
     * parameters are compared bivariantly. Without that, a concrete
     * `Store<{ Tab: ... }>` would stop being assignable to the general `Store`
     * type used across React context, helpers, and tests.
     *
     * @param sectionName - The section name being cloned.
     * @param state - The deep-cloned state value.
     * @param sourcePath - The original source path.
     * @param targetPath - The newly computed target path.
     * @returns The transformed state to be stored at `targetPath`.
     */
    transform?(
        sectionName: keyof SM,
        state: unknown,
        sourcePath: Path,
        targetPath: Path
    ): unknown;
};

/**
 * Deeply clones all state entries and pathRegistry entries matching `sourcePrefix`
 * to corresponding paths under `targetPrefix`.
 *
 * The clone is fully independent of the source: values are round-tripped
 * through the store's serializer/deserializer (preserving `BigInt`, `Decimal`,
 * `Date` and `undefined` placeholders), so mutating one side never affects the
 * other. Matching is segment-aware by default, and every matching path
 * registration is duplicated too, so routed children (`ArraySection` /
 * `ObjectSection`) keep working on the duplicate immediately.
 *
 * @param store - The YASM store instance.
 * @param sourcePrefix - The base path prefix to clone from.
 * @param targetPrefix - The base path prefix to clone into.
 * @param options - Match type, omitted sections, and transform hook.
 */
const cloneYasmSubtree = <SM extends Record<Name, Section>>(
    store: Store<SM>,
    sourcePrefix: string,
    targetPrefix: string,
    options?: CloneSubtreeOptions<SM>
): void => {
    const matchMode = options?.match ?? 'segment';

    const normalizePrefix = (prefix: string): string => {
        if (prefix.length > 1 && prefix.endsWith('/')) {
            return prefix.slice(0, -1);
        }
        return prefix;
    };

    const normSource =
        matchMode === 'startsWith'
            ? sourcePrefix
            : normalizePrefix(sourcePrefix);

    const normTarget = normalizePrefix(targetPrefix);

    if (normSource === normTarget) {
        return;
    }

    const boundaryChars = store.pathBoundaryChars;

    const matches = (path: Path): boolean => {
        if (matchMode === 'startsWith') {
            return path.startsWith(normSource);
        }

        return isPathWithinPrefix(path, normSource, boundaryChars);
    };

    const buildTargetPath = (sourcePath: Path): Path => {
        // Slicing uses the normalized source so a raw `startsWith` prefix
        // with a trailing slash still produces slash-joined target paths.
        // A root source prefix maps the exact root entry itself to the
        // empty relative part ('/' → normTarget, never `${normTarget}/`).
        const sliceBase = normalizePrefix(sourcePrefix);
        const relativePath =
            sliceBase === '/'
                ? sourcePath === '/'
                    ? ''
                    : sourcePath
                : sourcePath.slice(sliceBase.length);

        if (normTarget === '/') {
            if (relativePath === '') {
                return '/';
            }

            return relativePath.startsWith('/')
                ? relativePath
                : `/${relativePath}`;
        }

        return `${normTarget}${relativePath}`;
    };

    const omitted = new Set<string>(
        (options?.omitSections ?? []).map(section => String(section))
    );

    let shouldLog = false;
    if (
        process.env.NODE_ENV !== 'production' &&
        store.debugOptions.logStateUpdates
    ) {
        if (typeof store.debugOptions.logStateUpdates === 'function') {
            shouldLog = store.debugOptions.logStateUpdates({
                type: 'clone',
                sourcePrefix: normSource,
                targetPrefix: normTarget
            });
        } else {
            shouldLog = store.debugOptions.logStateUpdates === true;
        }
    }

    if (shouldLog) {
        const badgeStyle =
            'background: #2563eb; color: white; padding: 2px 6px; border-radius: 4px; font-weight: bold;';

        console.debug(
            ...composeDebugLogArgs(store, [
                { text: '📋 YASM cloning', style: badgeStyle },
                {
                    text: ` subtree from "${normSource}" to "${normTarget}"`
                }
            ])
        );
    }

    const hasCustomSerialization =
        store.serializer !== DEFAULT_SERIALIZER ||
        store.deserializer !== DEFAULT_DESERIALIZER;

    const deepCloneValue = (
        val: unknown,
        sectionName: keyof SM,
        sourcePath: Path
    ): unknown => {
        if (val === undefined || val === null || typeof val !== 'object') {
            return val;
        }

        if (hasCustomSerialization) {
            try {
                return serializeForSnapshot(val, store);
            } catch {
                // Fall through to structuredClone.
            }
        }

        if (typeof structuredClone === 'function') {
            try {
                return structuredClone(val);
            } catch {
                // Fall through to the final explicit error.
            }
        }

        throw new Error(
            `YASM: cloneSubtree could not clone "${String(sectionName)}" at path "${sourcePath}".`
        );
    };

    type StateCandidate = {
        sectionName: keyof SM;
        sourcePath: Path;
        targetPath: Path;
        value: unknown;
    };

    const stateCandidates: StateCandidate[] = [];

    for (const sectionName of Object.keys(store.state) as (keyof SM)[]) {
        if (omitted.has(String(sectionName))) {
            continue;
        }

        const sectionState = store.state[sectionName] as
            | Record<Path, unknown>
            | undefined;

        if (sectionState === undefined) {
            continue;
        }

        for (const path of Object.keys(sectionState)) {
            if (!matches(path)) {
                continue;
            }

            stateCandidates.push({
                sectionName,
                sourcePath: path,
                targetPath: buildTargetPath(path),
                value: sectionState[path]
            });
        }
    }

    type RegistryCandidate = {
        sectionName: Name;
        targetPath: Path;
    };

    const registryCandidates: RegistryCandidate[] = [];

    for (const sectionName of Object.keys(store.pathRegistry)) {
        if (omitted.has(sectionName)) {
            continue;
        }

        const registeredPaths = store.pathRegistry[sectionName];

        if (!Array.isArray(registeredPaths)) {
            continue;
        }

        for (const registeredPath of registeredPaths) {
            if (!matches(registeredPath)) {
                continue;
            }

            registryCandidates.push({
                sectionName,
                targetPath: buildTargetPath(registeredPath)
            });
        }
    }

    // Prepare every clone before mutating the live store.
    const preparedStateCandidates = stateCandidates.map(candidate => {
        let cloned = deepCloneValue(
            candidate.value,
            candidate.sectionName,
            candidate.sourcePath
        );

        if (options?.transform !== undefined) {
            cloned = options.transform(
                candidate.sectionName,
                cloned,
                candidate.sourcePath,
                candidate.targetPath
            );
        }

        if (process.env.NODE_ENV !== 'production') {
            deepFreeze(cloned);
        }

        return {
            ...candidate,
            cloned
        };
    });

    // Build a hypothetical post-clone state/registry view and run the same
    // routing-anchor invariant used by hydration.
    const proposedState = (Object.keys(store.state) as (keyof SM)[]).reduce(
        (result, sectionName) => {
            result[String(sectionName)] = {
                ...(store.state[sectionName] as Record<Path, unknown>)
            };
            return result;
        },
        {} as Record<string, Record<Path, unknown>>
    );

    for (const candidate of preparedStateCandidates) {
        proposedState[String(candidate.sectionName)][candidate.targetPath] =
            candidate.cloned;
    }

    const proposedRegistry = Object.keys(store.pathRegistry).reduce(
        (result, sectionName) => {
            result[sectionName] = [...store.pathRegistry[sectionName]];
            return result;
        },
        {} as Record<string, string[]>
    );

    for (const candidate of registryCandidates) {
        if (proposedRegistry[candidate.sectionName] === undefined) {
            proposedRegistry[candidate.sectionName] = [];
        }

        if (
            !proposedRegistry[candidate.sectionName].includes(
                candidate.targetPath
            )
        ) {
            proposedRegistry[candidate.sectionName].push(candidate.targetPath);
        }
    }

    pruneUnanchoredRegistrations(
        proposedRegistry,
        proposedState,
        store.routingPlan as Record<string, string[] | undefined>,
        boundaryChars
    );

    const validRegistryKeys = new Set(
        Object.entries(proposedRegistry).flatMap(
            ([sectionName, paths]) =>
                paths.map(path => `${sectionName}\u0000${path}`)
        )
    );

    const validRegistryCandidates = registryCandidates.filter(candidate =>
        validRegistryKeys.has(
            `${candidate.sectionName}\u0000${candidate.targetPath}`
        )
    );

    const notificationTargets = new Set<string>();

    // Commit ALL state before invoking ANY subscriber.
    for (const candidate of preparedStateCandidates) {
        const sectionState = store.state[candidate.sectionName] as Record<
            Path,
            unknown
        >;

        sectionState[candidate.targetPath] = candidate.cloned;

        notificationTargets.add(
            `${String(candidate.sectionName)}\u0000${candidate.targetPath}`
        );
    }

    // Commit ALL valid routing registrations before invoking ANY subscriber.
    for (const candidate of validRegistryCandidates) {
        const registeredPaths = store.pathRegistry[candidate.sectionName];

        if (
            Array.isArray(registeredPaths) &&
            !registeredPaths.includes(candidate.targetPath)
        ) {
            registeredPaths.push(candidate.targetPath);
        }
    }

    const reboundRoutes = rebindRoutedMemos(store, normTarget);

    for (const change of reboundRoutes) {
        notificationTargets.add(
            `${String(change.newRoutedName)}\u0000${change.newRoutedPath}`
        );
    }

    const isStateChanged =
        preparedStateCandidates.length > 0 ||
        validRegistryCandidates.length > 0;

    if (!isStateChanged) {
        return;
    }

    // Global notification happens only after the complete clone is committed.
    store[SYMBOL_NOTIFY_CHANGE]();

    // Notify target subscribers only after the whole subtree and routing
    // topology have been committed.
    for (const target of Array.from(notificationTargets)) {
        const separatorIndex = target.indexOf('\u0000');

        const sectionName = target.slice(0, separatorIndex) as Name;
        const targetPath = target.slice(separatorIndex + 1);

        const pathSubscribers = (
            store.subscribers as Record<
                Name,
                Record<Path, Record<number, () => void>>
            >
        )[sectionName]?.[targetPath];

        if (pathSubscribers === undefined) {
            continue;
        }

        for (const id of Object.keys({ ...pathSubscribers })) {
            const callback = pathSubscribers[id as unknown as number];

            if (callback === undefined) {
                continue;
            }

            try {
                callback();
            } catch (error) {
                console.error(
                    'YASM: a subscriber callback threw an exception during clone. The error is isolated so other subscribers are still notified.',
                    error
                );
            }
        }
    }
};

export { cloneYasmSubtree, type CloneSubtreeOptions };
