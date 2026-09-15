import { type ReactNode, useEffect, useState } from 'react';

import {
    YasmContext,
    useHydration,
    usePurgeWhenUnused,
    useYasmState
} from '../../src/index';
import { type NoteState, type ProfileState, store } from './store';

const HydrationGate = ({ children }: { children: ReactNode }) => {
    const { status } = useHydration(store);
    return (
        <>
            <span data-testid="hydration-status">{status}</span>
            {status === 'hydrated' ||
            status === 'quarantined' ||
            status === 'failed' ? (
                children
            ) : (
                <span data-testid="splash">loading</span>
            )}
        </>
    );
};

const Note = () => {
    const [state, update] = useYasmState<
        typeof store.sectionMap,
        'Note',
        NoteState
    >('Note', '/note');

    return (
        <div>
            <input
                data-testid="note-text"
                value={state.text}
                onChange={event => update({ text: event.target.value })}
            />
            <span data-testid="note-count">{state.count}</span>
            <button
                data-testid="note-increment"
                onClick={() => update(prev => ({ count: prev.count + 1 }))}
            >
                increment
            </button>
            <span data-testid="note-created-at">
                {state.createdAt === undefined
                    ? 'none'
                    : state.createdAt.toISOString()}
            </span>
            <button
                data-testid="note-set-date"
                onClick={() =>
                    update({ createdAt: new Date('2024-03-04T05:06:07.008Z') })
                }
            >
                set date
            </button>
            <span data-testid="note-bulk-size">{state.bulk.length}</span>
            <button
                data-testid="note-fill-bulk"
                onClick={() =>
                    update({
                        bulk: Array.from(
                            { length: 2000 },
                            (_, index) => `row-${index}-${'x'.repeat(200)}`
                        )
                    })
                }
            >
                fill bulk
            </button>
        </div>
    );
};

const Profile = () => {
    // Addressed through TWO routing levels: Table -> Row -> Profile.
    const [state, update] = useYasmState<
        typeof store.sectionMap,
        'Profile',
        ProfileState
    >('Profile', '/table[5][profile]');

    return (
        <div>
            <span data-testid="profile-first-name">{state.firstName}</span>
            <input
                data-testid="profile-input"
                value={state.firstName}
                onChange={event => update({ firstName: event.target.value })}
            />
        </div>
    );
};

const Row = () => {
    // `Row` must be in use so ITS path is registered — this is the entry whose
    // persistence is under test.
    useYasmState<
        typeof store.sectionMap,
        'Row',
        typeof store.sectionMap.Row.initialState
    >('Row', '/table[5]');

    return <Profile />;
};

/**
 * Mounts the composition parents in the documented parent-first order so their
 * paths are registered, then renders the deep child.
 */
const Composition = () => {
    const [table, updateTable] = useYasmState<
        typeof store.sectionMap,
        'Table',
        typeof store.sectionMap.Table.initialState
    >('Table', '/table');

    const hasRow = table.map[5] !== undefined;

    return (
        <div>
            <span data-testid="table-has-row">{String(hasRow)}</span>
            <button
                data-testid="table-add-row"
                onClick={() =>
                    updateTable({
                        addingItems: [{ id: 5 }],
                        order: [5]
                    })
                }
            >
                add row
            </button>
            {hasRow ? <Row /> : null}
        </div>
    );
};

const Secret = () => {
    const [state, update] = useYasmState<
        typeof store.sectionMap,
        'Secret',
        { token: string }
    >('Secret', '/secret');

    return (
        <div>
            <span data-testid="secret-token">
                {state.token === '' ? 'empty' : state.token}
            </span>
            <button
                data-testid="secret-set"
                onClick={() => update({ token: 'in-memory-only' })}
            >
                set secret
            </button>
        </div>
    );
};

const Purger = () => {
    const purgeWhenUnused = usePurgeWhenUnused();
    return (
        <button
            data-testid="purge-note"
            onClick={() => purgeWhenUnused('/note')}
        >
            purge note
        </button>
    );
};

const App = () => {
    const [ready, setReady] = useState(false);
    const [showNote, setShowNote] = useState(true);

    useEffect(() => {
        let isCancelled = false;

        store
            .hydrate()
            .catch(error => {
                console.error('YASM: hydration failed irrecoverably.', error);
            })
            .finally(() => {
                if (!isCancelled) {
                    setReady(true);
                }
            });

        return () => {
            isCancelled = true;
        };
    }, []);

    useEffect(() => {
        // Mirrors the application's emergency flush: autosave is debounced, so
        // a close/refresh inside the window would otherwise lose the tail.
        const flushPendingSave = () => {
            void store.save();
        };

        const handleVisibilityChange = () => {
            if (document.visibilityState === 'hidden') {
                flushPendingSave();
            }
        };

        window.addEventListener('pagehide', flushPendingSave);
        document.addEventListener('visibilitychange', handleVisibilityChange);

        return () => {
            window.removeEventListener('pagehide', flushPendingSave);
            document.removeEventListener(
                'visibilitychange',
                handleVisibilityChange
            );
        };
    }, []);

    return (
        <YasmContext.Provider value={store}>
            <HydrationGate>
                <div data-testid="app-ready">{String(ready)}</div>
                <button
                    data-testid="toggle-note"
                    onClick={() => setShowNote(current => !current)}
                >
                    toggle note
                </button>
                {showNote ? <Note /> : null}
                <Composition />
                <Secret />
                <Purger />
            </HydrationGate>
        </YasmContext.Provider>
    );
};

export { App };
