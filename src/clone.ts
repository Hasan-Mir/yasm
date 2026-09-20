import {
    SYMBOL_NOTIFY_CHANGE,
    Name,
    Path,
    Section,
    Store
} from './createStore';
import {
    composeDebugLogArgs,
    deepFreeze,
    isPathWithinPrefix,
    serializeForSnapshot
} from './util';

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
    // Normalizes prefix by trimming trailing slash to prevent path boundary mangling
    const normalizePrefix = (prefix: string): string => {
        if (prefix.endsWith('/')) {
            return prefix.slice(0, -1);
        }
        return prefix;
    };

    const normSource = normalizePrefix(sourcePrefix);
    const normTarget = normalizePrefix(targetPrefix);

    if (normSource === normTarget) {
        return;
    }

    const boundaryChars = store.pathBoundaryChars;
    const matchMode = options?.match ?? 'segment';

    const matches = (path: Path): boolean => {
        if (matchMode === 'startsWith') {
            return path.startsWith(normSource);
        }
        return isPathWithinPrefix(path, normSource, boundaryChars);
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

    // Deep clone helper utilizing the store's serializer and deserializer
    // to preserve BigInt, Decimal, Date, and undefined placeholders
    const deepCloneValue = (val: unknown): unknown => {
        if (val === undefined || val === null || typeof val !== 'object') {
            return val;
        }

        try {
            return serializeForSnapshot(val, store);
        } catch {
            if (typeof structuredClone === 'function') {
                try {
                    return structuredClone(val);
                } catch {
                    return val;
                }
            }
            return val;
        }
    };

    // 1. Snapshot matching state entries first to prevent self-matching loops
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
            Record<Path, unknown> | undefined;

        if (sectionState === undefined) {
            continue;
        }

        for (const path of Object.keys(sectionState)) {
            if (matches(path)) {
                const relativePath = path.slice(normSource.length);
                const targetPath = `${normTarget}${relativePath}`;

                stateCandidates.push({
                    sectionName,
                    sourcePath: path,
                    targetPath,
                    value: sectionState[path]
                });
            }
        }
    }

    // 2. Snapshot matching pathRegistry entries for composed routing
    // (ArraySection / ObjectSection) so routed children keep working on the target
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
            if (matches(registeredPath)) {
                const relativePath = registeredPath.slice(normSource.length);
                const targetPath = `${normTarget}${relativePath}`;
                registryCandidates.push({
                    sectionName,
                    targetPath
                });
            }
        }
    }

    let isStateChanged = false;

    // 3. Write cloned values to store.state
    for (const candidate of stateCandidates) {
        const sectionState = store.state[candidate.sectionName] as Record<
            Path,
            unknown
        >;

        let cloned = deepCloneValue(candidate.value);

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

        sectionState[candidate.targetPath] = cloned;
        isStateChanged = true;

        // If components are already mounted at the target path, notify them safely
        const pathSubscribers = (
            store.subscribers as Record<
                Name,
                Record<Path, Record<number, () => void>>
            >
        )[candidate.sectionName as Name]?.[candidate.targetPath];

        if (pathSubscribers !== undefined) {
            for (const id of Object.keys(pathSubscribers)) {
                const callback = pathSubscribers[id as unknown as number];
                if (callback !== undefined) {
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
        }
    }

    // 4. Register cloned paths in store.pathRegistry
    for (const candidate of registryCandidates) {
        const registeredPaths = store.pathRegistry[candidate.sectionName];
        if (
            Array.isArray(registeredPaths) &&
            !registeredPaths.includes(candidate.targetPath)
        ) {
            registeredPaths.push(candidate.targetPath);
            isStateChanged = true;
        }
    }

    // 5. Trigger notifications and auto-save if any state or routing was added
    if (isStateChanged) {
        store[SYMBOL_NOTIFY_CHANGE]();
    }
};

export { cloneYasmSubtree, type CloneSubtreeOptions };
