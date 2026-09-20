import { act, fireEvent, render, screen } from '@testing-library/react';
import { YasmContext } from '../../src/Context';
import { Section, createStore } from '../../src/createStore';
import { usePurgeWhenUnused } from '../../src/usePurgeWhenUnused';
import { usePurgeYasmState } from '../../src/usePurgeYasmState';
import { useCloneYasmSubtree } from '../../src/useCloneYasmSubtree';
import {
    init,
    useYasmState,
    useYasmStateUpdater
} from '../../src/useYasmState';
import { mergeUpdaterGenerator } from '../../src/util';

type State = { value: number; text: string };
const section: Section<State, Partial<State>> = {
    initialState: { value: 0, text: '' },
    updater: mergeUpdaterGenerator<State>()
};

test('hooks throw a helpful error when no provider is mounted (client render)', () => {
    const errorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);

    try {
        const Consumer = () => {
            useYasmState('State' as never, '/a');
            return null;
        };
        const UpdaterConsumer = () => {
            useYasmStateUpdater('State' as never, '/a');
            return null;
        };
        const PurgeConsumer = () => {
            usePurgeYasmState();
            return null;
        };
        const CloneConsumer = () => {
            useCloneYasmSubtree();
            return null;
        };

        // The hook throws during rendering, which is the public error
        // contract — now verified in a real mounted tree, not just SSR.
        expect(() => render(<Consumer />)).toThrow(
            /no store was found in the React context/
        );
        expect(() => render(<UpdaterConsumer />)).toThrow(
            /no store was found in the React context/
        );
        expect(() => render(<PurgeConsumer />)).toThrow(
            /no store was found in the React context/
        );
        expect(() => render(<CloneConsumer />)).toThrow(
            /no store was found in the React context/
        );
    } finally {
        errorSpy.mockRestore();
    }
});

test('useYasmStateUpdater initializes lazily, never subscribes, never re-renders', () => {
    const store = createStore({ State: section });
    let writerRenders = 0;
    let capturedUpdater:
        | ReturnType<
              typeof useYasmStateUpdater<typeof store.sectionMap, 'State'>
          >
        | undefined;

    const Writer = () => {
        capturedUpdater = useYasmStateUpdater<typeof store.sectionMap, 'State'>(
            'State',
            '/wo'
        );
        writerRenders++;
        return (
            <button onClick={() => capturedUpdater?.({ value: 42 })}>
                write
            </button>
        );
    };

    const Reader = () => {
        const [value] = useYasmState<typeof store.sectionMap, 'State', number>(
            'State',
            '/wo',
            state => state.value
        );
        return <span data-testid="reader">{value}</span>;
    };

    render(
        <YasmContext.Provider value={store}>
            <Writer />
            <Reader />
        </YasmContext.Provider>
    );

    // Mounting the write-only hook lazily created the state...
    expect(store.state.State['/wo']).toEqual({ value: 0, text: '' });
    // ...but the only subscriber is the Reader, never the Writer
    expect(Object.keys(store.subscribers.State['/wo'] ?? {}).length).toBe(1);

    const rendersAfterMount = writerRenders;
    fireEvent.click(screen.getByText('write'));

    // The dispatch went through and the Reader saw it...
    expect(screen.getByTestId('reader')).toHaveTextContent('42');
    // ...while the Writer never re-rendered (the store never notifies it)
    expect(writerRenders).toBe(rendersAfterMount);

    // The write-only hook shares the memoized record's updater with init()
    expect(init(store, 'State', '/wo').updater).toBe(capturedUpdater);
});

test('usePurgeWhenUnused accepts an array of prefixes', () => {
    const store = createStore({ State: section });
    init(store, 'State', '/multi/a');
    init(store, 'State', '/multi/b');
    init(store, 'State', '/keep');

    const Purger = () => {
        const purgeWhenUnused = usePurgeWhenUnused();
        return (
            <button onClick={() => purgeWhenUnused(['/multi/a', '/multi/b'])}>
                purge-both
            </button>
        );
    };

    render(
        <YasmContext.Provider value={store}>
            <Purger />
        </YasmContext.Provider>
    );

    // Nothing is subscribed under either prefix → both purge immediately
    fireEvent.click(screen.getByText('purge-both'));

    expect(store.state.State['/multi/a']).toBeUndefined();
    expect(store.state.State['/multi/b']).toBeUndefined();
    expect(store.state.State['/keep']).toBeDefined();
});

test('usePurgeYasmState purges through the context store while a reader is mounted', () => {
    const warningSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);

    try {
        const store = createStore({ State: section });
        init(store, 'State', '/p');

        const Purger = () => {
            const purge = usePurgeYasmState();
            return <button onClick={() => purge('/p')}>purge</button>;
        };

        const Reader = () => {
            const [value] = useYasmState<
                typeof store.sectionMap,
                'State',
                number
            >('State', '/p', state => state.value);
            return <span data-testid="reader">{value}</span>;
        };

        const view = render(
            <YasmContext.Provider value={store}>
                <Purger />
                <Reader />
            </YasmContext.Provider>
        );
        expect(store.state.State['/p']).toBeDefined();

        fireEvent.click(screen.getByText('purge'));

        // The context-bound purge executed against the same store
        expect(store.state.State['/p']).toBeUndefined();

        // The still-mounted reader survives; its next render lazily
        // re-initializes the path from initialState
        view.rerender(
            <YasmContext.Provider value={store}>
                <Purger />
                <Reader />
            </YasmContext.Provider>
        );
        expect(screen.getByTestId('reader')).toHaveTextContent('0');
    } finally {
        warningSpy.mockRestore();
    }
});

test('overrideInitialState supports object and callback forms', () => {
    const store = createStore({ State: section });

    const ObjectReader = () => {
        const [value] = useYasmState<typeof store.sectionMap, 'State', number>(
            'State',
            '/obj',
            {
                selector: state => state.value,
                overrideInitialState: { value: 99 }
            }
        );
        return <span data-testid="obj">{value}</span>;
    };

    const CallbackReader = () => {
        const [value] = useYasmState<typeof store.sectionMap, 'State', number>(
            'State',
            '/cb',
            {
                selector: state => state.value,
                overrideInitialState: initial => ({ value: initial.value + 10 })
            }
        );
        return <span data-testid="cb">{value}</span>;
    };

    render(
        <YasmContext.Provider value={store}>
            <ObjectReader />
            <CallbackReader />
        </YasmContext.Provider>
    );

    expect(screen.getByTestId('obj')).toHaveTextContent('99');
    expect(screen.getByTestId('cb')).toHaveTextContent('10');
});

test('overrideInitialState applies on the FIRST init only — remounts ignore it', () => {
    const store = createStore({ State: section });

    const makeReader = (overrideValue: number) => () => {
        const [value, update] = useYasmState<
            typeof store.sectionMap,
            'State',
            number
        >('State', '/once', {
            selector: state => state.value,
            overrideInitialState: { value: overrideValue }
        });
        return (
            <>
                <span data-testid="reader">{value}</span>
                <button onClick={() => update({ value: 7 })}>bump</button>
            </>
        );
    };

    // First mount: the override applies
    const FirstReader = makeReader(5);
    const first = render(
        <YasmContext.Provider value={store}>
            <FirstReader />
        </YasmContext.Provider>
    );
    expect(screen.getByTestId('reader')).toHaveTextContent('5');

    // The user changes the state, then the tab unmounts
    fireEvent.click(screen.getByText('bump'));
    expect(screen.getByTestId('reader')).toHaveTextContent('7');
    first.unmount();

    // A remount with a DIFFERENT override must not clobber the stored
    // state — the override is first-init-only by contract
    const SecondReader = makeReader(100);
    render(
        <YasmContext.Provider value={store}>
            <SecondReader />
        </YasmContext.Provider>
    );
    expect(screen.getByTestId('reader')).toHaveTextContent('7');
});

test('the hook updater accepts a payload creator', () => {
    const store = createStore({ State: section });

    const Counter = () => {
        const [value, update] = useYasmState<
            typeof store.sectionMap,
            'State',
            number
        >('State', '/a', state => state.value);
        return (
            <button
                onClick={() => update(state => ({ value: state.value + 1 }))}
            >
                count:{value}
            </button>
        );
    };

    render(
        <YasmContext.Provider value={store}>
            <Counter />
        </YasmContext.Provider>
    );

    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('count:2')).toBeInTheDocument();
});

test('a no-op update (identical payload) does not re-render subscribers', () => {
    const store = createStore({ State: section });
    init(store, 'State', '/a');
    let readerRenders = 0;

    const Reader = () => {
        const [value] = useYasmState<typeof store.sectionMap, 'State', number>(
            'State',
            '/a',
            state => state.value
        );
        readerRenders++;
        return <span data-testid="reader">{value}</span>;
    };

    render(
        <YasmContext.Provider value={store}>
            <Reader />
        </YasmContext.Provider>
    );
    const rendersAfterMount = readerRenders;

    // Immer returns the same reference when nothing mutated → the updater
    // aborts before notifying, so React must not commit anything
    act(() => {
        store.memo.State['/a'].updater({ value: 0, text: '' });
    });

    expect(readerRenders).toBe(rendersAfterMount);
    expect(screen.getByTestId('reader')).toHaveTextContent('0');
});

test("readers of different paths are isolated from each other's updates", () => {
    const store = createStore({ State: section });
    let rendersA = 0;
    let rendersB = 0;

    const makeReader = (path: string, bump: () => void) => () => {
        const [value] = useYasmState<typeof store.sectionMap, 'State', number>(
            'State',
            path,
            state => state.value
        );
        bump();
        return <span data-testid={path}>{value}</span>;
    };

    const ReaderA = makeReader('/a', () => rendersA++);
    const ReaderB = makeReader('/b', () => rendersB++);

    render(
        <YasmContext.Provider value={store}>
            <ReaderA />
            <ReaderB />
        </YasmContext.Provider>
    );
    const aAfterMount = rendersA;
    const bAfterMount = rendersB;

    // Updating /b must not commit anything for the /a reader
    act(() => {
        store.memo.State['/b'].updater({ value: 9 });
    });

    expect(rendersA).toBe(aAfterMount);
    expect(rendersB).toBe(bAfterMount + 1);
    expect(screen.getByTestId('/a')).toHaveTextContent('0');
    expect(screen.getByTestId('/b')).toHaveTextContent('9');
});
