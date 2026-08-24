import { act, render, screen } from '@testing-library/react';
import { YasmContext } from '../../src/Context';
import { Section, createStore } from '../../src/createStore';
import { useYasmState } from '../../src/useYasmState';
import { mergeUpdaterGenerator } from '../../src/util';

type State = { value: number; text: string };
const section: Section<State, Partial<State>> = {
    initialState: { value: 0, text: '' },
    updater: mergeUpdaterGenerator<State>()
};

const createMockStorage = () => {
    const data = new Map<string, string>();
    return {
        getItem: async (key: string) => data.get(key) || null,
        setItem: async (key: string, value: string) => {
            data.set(key, value);
        },
        removeItem: async (key: string) => {
            data.delete(key);
        }
    };
};

const persistedSnapshot = JSON.stringify({
    state: { State: { '/tabs/1': { value: 7, text: '' } } },
    pathRegistry: {}
});

test('a reader mounted BEFORE hydrate() finishes shows persisted state once hydration lands', async () => {
    const storage = createMockStorage();
    await storage.setItem('tabs', persistedSnapshot);

    const store = createStore(
        { State: section },
        { persist: { key: 'tabs', storage } }
    );

    // Dev-mode guidance: YASM warns once that hooks ran before hydration.
    // The warning fires during the first render's lazy init, so arm the
    // spy BEFORE mounting.
    const warningSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);

    // The component mounts while hydration is still in flight (e.g. a
    // splash-screen tree or a tab restored before the storage read
    // resolves). init() lazily creates the default state.
    const Reader = () => {
        const [value] = useYasmState<typeof store.sectionMap, 'State', number>(
            'State',
            '/tabs/1',
            state => state.value
        );
        return <span data-testid="tab-value">{value}</span>;
    };

    try {
        render(
            <YasmContext.Provider value={store}>
                <Reader />
            </YasmContext.Provider>
        );

        // Before hydration only the default is known
        expect(screen.getByTestId('tab-value')).toHaveTextContent('0');

        // Hydration merges persisted data over the live store. The mounted
        // subscriber must be notified — otherwise useSyncExternalStore keeps
        // serving the stale default snapshot forever.
        await act(async () => {
            await store.hydrate();
        });

        expect(store.state.State['/tabs/1'].value).toBe(7);
        expect(screen.getByTestId('tab-value')).toHaveTextContent('7');
        expect(warningSpy).toHaveBeenCalledTimes(1);
        expect(String(warningSpy.mock.calls[0][0])).toMatch(
            /BEFORE store\.hydrate\(\) finished/
        );
    } finally {
        warningSpy.mockRestore();
    }
});

test('overrideInitialState applied before hydration does NOT survive the hydrated value', async () => {
    const storage = createMockStorage();
    await storage.setItem('tabs', persistedSnapshot);

    const store = createStore(
        { State: section },
        { persist: { key: 'tabs', storage } }
    );

    // Silence the expected dev warning about mounting before hydration
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const Reader = () => {
        const [value] = useYasmState<typeof store.sectionMap, 'State', number>(
            'State',
            '/tabs/1',
            {
                selector: state => state.value,
                overrideInitialState: { value: 99 }
            }
        );
        return <span data-testid="tab-value">{value}</span>;
    };

    try {
        render(
            <YasmContext.Provider value={store}>
                <Reader />
            </YasmContext.Provider>
        );

        // The override wins for the first (pre-hydration) initialization...
        expect(screen.getByTestId('tab-value')).toHaveTextContent('99');

        // ...but persistence is the source of truth: the merged snapshot
        // replaces the path and the UI must follow it.
        await act(async () => {
            await store.hydrate();
        });

        expect(screen.getByTestId('tab-value')).toHaveTextContent('7');
    } finally {
        vi.mocked(console.warn).mockRestore();
    }
});

test('a reader mounted after hydrate() completed reads persisted state directly', async () => {
    const storage = createMockStorage();
    await storage.setItem('tabs', persistedSnapshot);

    const store = createStore(
        { State: section },
        { persist: { key: 'tabs', storage } }
    );
    await store.hydrate();

    const Reader = () => {
        const [value] = useYasmState<typeof store.sectionMap, 'State', number>(
            'State',
            '/tabs/1',
            state => state.value
        );
        return <span data-testid="tab-value">{value}</span>;
    };

    render(
        <YasmContext.Provider value={store}>
            <Reader />
        </YasmContext.Provider>
    );

    // init() must reuse the hydrated record instead of resetting to initial
    expect(screen.getByTestId('tab-value')).toHaveTextContent('7');
});
