import { fireEvent, render, screen } from '@testing-library/react';
import { YasmContext } from '../../src/Context';
import { Section, createStore } from '../../src/createStore';
import { usePurgeWhenUnused } from '../../src/usePurgeWhenUnused';
import { init, useYasmState } from '../../src/useYasmState';
import { mergeUpdaterGenerator } from '../../src/util';

type State = { value: number; text: string };
const section: Section<State, Partial<State>> = {
    initialState: { value: 0, text: '' },
    updater: mergeUpdaterGenerator<State>()
};

// Mirrors tests/persist.test.ts's adapter shape (async getItem/setItem)
const createMockStorage = () => {
    const data = new Map<string, string>();
    return {
        getItem: async (key: string) => data.get(key) || null,
        setItem: async (key: string, value: string) => {
            data.set(key, value);
        },
        removeItem: async (key: string) => {
            data.delete(key);
        },
        clear: async () => {
            data.clear();
        }
    };
};

const createPersistedStore = (storage: ReturnType<typeof createMockStorage>) =>
    createStore({ State: section }, { persist: { key: 'tabs', storage } });

type SectionMap = { State: typeof section };

// A tab body reading/writing one path — the shape of the user's tab app
const makeTabContent = () => {
    const TabContent = () => {
        const [value, update] = useYasmState<SectionMap, 'State', number>(
            'State',
            '/tabs/1',
            state => state.value
        );
        return (
            <>
                <span data-testid="tab-value">{value}</span>
                <button onClick={() => update({ value: value + 1 })}>
                    increment
                </button>
            </>
        );
    };
    return TabContent;
};

test('switching tabs (full unmount → remount) restores state from the global store', () => {
    const store = createStore({ State: section });
    const TabContent = makeTabContent();

    // Tab 1 is open and the user interacts with it
    const tab = render(
        <YasmContext.Provider value={store}>
            <TabContent />
        </YasmContext.Provider>
    );
    fireEvent.click(screen.getByText('increment'));
    fireEvent.click(screen.getByText('increment'));
    expect(screen.getByTestId('tab-value')).toHaveTextContent('2');

    // Switching away unmounts the tab completely — but nothing was purged,
    // so the state must survive in the global store
    tab.unmount();
    expect(store.state.State['/tabs/1'].value).toBe(2);

    // Switching back brings the exact same state, not a re-initialized one
    render(
        <YasmContext.Provider value={store}>
            <TabContent />
        </YasmContext.Provider>
    );
    expect(screen.getByTestId('tab-value')).toHaveTextContent('2');
});

test('a page refresh brings tab state back through save + hydrate', async () => {
    const storage = createMockStorage();
    const before = createPersistedStore(storage);
    await before.hydrate();

    const BeforeTab = makeTabContent();

    const first = render(
        <YasmContext.Provider value={before}>
            <BeforeTab />
        </YasmContext.Provider>
    );
    fireEvent.click(screen.getByText('increment'));
    fireEvent.click(screen.getByText('increment'));
    expect(screen.getByTestId('tab-value')).toHaveTextContent('2');
    first.unmount();

    // "Refresh": save before unload, then a brand-new store hydrates from
    // the same storage — no component was mounted during hydration
    await before.save();
    const after = createPersistedStore(storage);
    await after.hydrate();

    const AfterTab = makeTabContent();
    render(
        <YasmContext.Provider value={after}>
            <AfterTab />
        </YasmContext.Provider>
    );

    // init() must reuse the hydrated state instead of resetting to initial
    expect(screen.getByTestId('tab-value')).toHaveTextContent('2');
});

test('purgeWhenUnused: shared state survives until the LAST tab unmounts', async () => {
    const warningSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);

    try {
        const store = createStore({ State: section });
        init(store, 'State', '/tabs/shared');

        const Reader = () => {
            const [value] = useYasmState<
                typeof store.sectionMap,
                'State',
                number
            >('State', '/tabs/shared', state => state.value);
            return <span data-testid="reader">{value}</span>;
        };

        const Purger = () => {
            const purgeWhenUnused = usePurgeWhenUnused();
            return (
                <button onClick={() => purgeWhenUnused('/tabs')}>
                    close-for-good
                </button>
            );
        };

        // Two tabs read the same path; tab 1 also carries the purge trigger
        const tab1 = render(
            <YasmContext.Provider value={store}>
                <Purger />
                <Reader />
            </YasmContext.Provider>
        );
        const tab2 = render(
            <YasmContext.Provider value={store}>
                <Reader />
            </YasmContext.Provider>
        );

        // The user closes the tab "for good" — but the state is still
        // subscribed by tab 2, so the purge must wait
        fireEvent.click(screen.getByText('close-for-good'));
        expect(store.state.State['/tabs/shared']).toBeDefined();

        tab1.unmount();
        // Tab 2 is still mounted and showing live data
        expect(screen.getByTestId('reader')).toBeInTheDocument();
        expect(store.state.State['/tabs/shared']).toBeDefined();

        // Now the path is TRULY unused: no subscribers anywhere → wiped on
        // the next task
        tab2.unmount();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(store.state.State['/tabs/shared']).toBeUndefined();
    } finally {
        warningSpy.mockRestore();
    }
});

test('purgeWhenUnused over a prefix waits for EVERY matching path to drain, then wipes them all', async () => {
    const store = createStore({ State: section });

    const makeReader = (path: string) => () => {
        const [value] = useYasmState<typeof store.sectionMap, 'State', number>(
            'State',
            path,
            state => state.value
        );
        return <span>{value}</span>;
    };

    const Purger = () => {
        const purgeWhenUnused = usePurgeWhenUnused();
        return (
            <button onClick={() => purgeWhenUnused('/tabs')}>close-all</button>
        );
    };

    const Reader1 = makeReader('/tabs/1');
    const Reader2 = makeReader('/tabs/2');

    // Two independent tab roots sharing the global store — the real app shape
    const tab1 = render(
        <YasmContext.Provider value={store}>
            <Purger />
            <Reader1 />
        </YasmContext.Provider>
    );
    const tab2 = render(
        <YasmContext.Provider value={store}>
            <Reader2 />
        </YasmContext.Provider>
    );

    // Scheduling while BOTH paths have mounted readers must not purge either
    fireEvent.click(screen.getByText('close-all'));
    expect(store.state.State['/tabs/1']).toBeDefined();
    expect(store.state.State['/tabs/2']).toBeDefined();

    // Closing tab 1 drains only ITS path from the pending snapshot; tab 2 is
    // still subscribed, so nothing under '/tabs' may be wiped yet
    tab1.unmount();
    expect(store.state.State['/tabs/1']).toBeDefined();
    expect(store.state.State['/tabs/2']).toBeDefined();

    // The last matching reader leaves → every matching path goes together
    tab2.unmount();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(store.state.State['/tabs/1']).toBeUndefined();
    expect(store.state.State['/tabs/2']).toBeUndefined();
});
