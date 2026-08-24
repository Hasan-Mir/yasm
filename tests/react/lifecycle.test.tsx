import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { YasmContext } from '../../src/Context';
import { Section, createStore } from '../../src/createStore';
import { purgeYasmState } from '../../src/purge';
import { usePurgeWhenUnused } from '../../src/usePurgeWhenUnused';
import { init, useYasmState } from '../../src/useYasmState';
import { mergeUpdaterGenerator } from '../../src/util';

type State = { value: number; text: string };
const section: Section<State, Partial<State>> = {
    initialState: { value: 0, text: '' },
    updater: mergeUpdaterGenerator<State>()
};

const subscriberCount = (store: ReturnType<typeof createStore>, path = '/a') =>
    Object.keys(store.subscribers.State[path] ?? {}).length;

test('unmount unsubscribes the component from the store record', () => {
    const store = createStore({ State: section });

    const Reader = () => {
        const [value] = useYasmState<typeof store.sectionMap, 'State', number>(
            'State',
            '/a',
            state => state.value
        );
        return <span data-testid="reader">{value}</span>;
    };

    const { unmount } = render(
        <YasmContext.Provider value={store}>
            <Reader />
        </YasmContext.Provider>
    );

    expect(subscriberCount(store)).toBe(1);

    unmount();

    expect(subscriberCount(store)).toBe(0);
});

test('updates after unmount do not touch the detached component', () => {
    const store = createStore({ State: section });
    let readerRenders = 0;

    const Reader = () => {
        const [value] = useYasmState<typeof store.sectionMap, 'State', number>(
            'State',
            '/a',
            state => state.value
        );
        readerRenders++;
        return <span>{value}</span>;
    };

    const { unmount } = render(
        <YasmContext.Provider value={store}>
            <Reader />
        </YasmContext.Provider>
    );
    const rendersAfterMount = readerRenders;
    unmount();

    // Must not throw or schedule a React update on an unmounted tree
    expect(() => store.memo.State['/a'].updater({ value: 5 })).not.toThrow();
    expect(readerRenders).toBe(rendersAfterMount);
});

test('StrictMode double-mounting leaves exactly one live subscription', () => {
    const store = createStore({ State: section });

    const Reader = () => {
        const [value, update] = useYasmState<
            typeof store.sectionMap,
            'State',
            number
        >('State', '/a', state => state.value);
        return (
            <button onClick={() => update({ value: value + 1 })}>
                count:{value}
            </button>
        );
    };

    render(
        <>
            <React.StrictMode>
                <YasmContext.Provider value={store}>
                    <Reader />
                </YasmContext.Provider>
            </React.StrictMode>
        </>
    );

    // StrictMode mounts → unmounts → remounts effects; the net subscription
    // must still be exactly one (no leaked duplicates).
    expect(subscriberCount(store)).toBe(1);

    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('count:1')).toBeInTheDocument();
});

test('usePurgeWhenUnused waits for the last mounted reader to unmount', async () => {
    const store = createStore({ State: section });
    init(store, 'State', '/t/1');

    const Reader = ({ path }: { path: string }) => {
        const [value] = useYasmState<typeof store.sectionMap, 'State', unknown>(
            'State',
            path
        );
        return <span data-testid={path}>{String(value)}</span>;
    };

    const Purger = () => {
        const purgeWhenUnused = usePurgeWhenUnused();
        return <button onClick={() => purgeWhenUnused('/t')}>schedule</button>;
    };

    const { unmount } = render(
        <YasmContext.Provider value={store}>
            <Reader path="/t/1" />
            <Reader path="/t/2" />
            <Purger />
        </YasmContext.Provider>
    );

    // Scheduling while readers are mounted must not purge yet
    fireEvent.click(screen.getByText('schedule'));
    expect(store.state.State['/t/1']).not.toBeUndefined();
    expect(store.state.State['/t/2']).not.toBeUndefined();

    // The deferred fire executes on the next task after the last unmount
    unmount();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(store.state.State['/t/1']).toBeUndefined();
    expect(store.state.State['/t/2']).toBeUndefined();
});

test('after a deferred purge fires, a remounted reader starts fresh', async () => {
    const store = createStore({ State: section });

    const Reader = () => {
        const [value, update] = useYasmState<
            typeof store.sectionMap,
            'State',
            number
        >('State', '/a', state => state.value);
        return (
            <>
                <span data-testid="reader">{value}</span>
                <button onClick={() => update({ value: 100 })}>bump</button>
            </>
        );
    };

    const Purger = () => {
        const purgeWhenUnused = usePurgeWhenUnused();
        return <button onClick={() => purgeWhenUnused('/a')}>schedule</button>;
    };

    const first = render(
        <YasmContext.Provider value={store}>
            <Reader />
            <Purger />
        </YasmContext.Provider>
    );

    fireEvent.click(screen.getByText('bump'));
    expect(screen.getByTestId('reader')).toHaveTextContent('100');

    // Schedule the purge and take the only reader out of the tree
    fireEvent.click(screen.getByText('schedule'));
    first.unmount();
    // The destructive pass runs on the next task after the last unmount
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(store.state.State['/a']).toBeUndefined();

    // A brand-new mount re-initializes from initialState, not stale state
    render(
        <YasmContext.Provider value={store}>
            <Reader />
        </YasmContext.Provider>
    );
    expect(screen.getByTestId('reader')).toHaveTextContent('0');
});

test('StrictMode double-effect scheduling of purgeWhenUnused does not fire early', async () => {
    const warningSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);

    try {
        const store = createStore({ State: section });
        init(store, 'State', '/a');
        store.memo.State['/a'].updater({ value: 5 });

        const EffectPurger = () => {
            const purgeWhenUnused = usePurgeWhenUnused();
            React.useEffect(() => {
                // StrictMode mounts → unmounts → remounts effects, so this
                // schedule runs TWICE. The dedup must replace the snapshot,
                // never fire it while the reader below is still subscribed.
                purgeWhenUnused('/a');
            }, [purgeWhenUnused]);
            return null;
        };

        const Reader = () => {
            const [value] = useYasmState<
                typeof store.sectionMap,
                'State',
                number
            >('State', '/a', state => state.value);
            return <span data-testid="reader">{value}</span>;
        };

        const view = render(
            <React.StrictMode>
                <YasmContext.Provider value={store}>
                    <Reader />
                    <EffectPurger />
                </YasmContext.Provider>
            </React.StrictMode>
        );

        // Effects settled: state intact, exactly one live subscription
        await act(async () => {});
        expect(screen.getByTestId('reader')).toHaveTextContent('5');
        expect(store.state.State['/a'].value).toBe(5);
        expect(subscriberCount(store)).toBe(1);
        // No "purged while subscribers are mounted" warnings so far
        expect(warningSpy).not.toHaveBeenCalled();

        // Everything unmounts → the deferred purge fires on the next task,
        // exactly once, cleanly — even though StrictMode scheduled it twice
        // and transiently dropped every subscription mid-flush
        view.unmount();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(store.state.State['/a']).toBeUndefined();
        expect(warningSpy).not.toHaveBeenCalled();
    } finally {
        warningSpy.mockRestore();
    }
});

test('a raw purge over live subscribers warns but keeps components working', async () => {
    const warningSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);

    try {
        const store = createStore({ State: section });

        const Reader = () => {
            const [value] = useYasmState<
                typeof store.sectionMap,
                'State',
                number
            >('State', '/a', state => state.value);
            return <span data-testid="reader">{value}</span>;
        };

        const view = render(
            <YasmContext.Provider value={store}>
                <Reader />
            </YasmContext.Provider>
        );

        act(() => {
            purgeYasmState(store, '/a');
        });

        // The dev-time warning fired for purging under a live subscriber
        expect(warningSpy).toHaveBeenCalled();

        // The next render lazily re-initializes the purged path from
        // initialState instead of crashing the mounted tree
        view.rerender(
            <YasmContext.Provider value={store}>
                <Reader />
            </YasmContext.Provider>
        );
        expect(store.state.State['/a']).toBeDefined();
        expect(screen.getByTestId('reader')).toBeInTheDocument();
    } finally {
        warningSpy.mockRestore();
    }
});
