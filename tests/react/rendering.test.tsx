import { act, fireEvent, render, screen } from '@testing-library/react';
import { YasmContext } from '../../src/Context';
import { Section, createStore } from '../../src/createStore';
import { init, useYasmState } from '../../src/useYasmState';
import { arraySectionGenerator, mergeUpdaterGenerator } from '../../src/util';

type State = { value: number; text: string };
const section: Section<State, Partial<State>> = {
    initialState: { value: 0, text: '' },
    updater: mergeUpdaterGenerator<State>()
};

type Row = { title: string; done: boolean };
const rowSection: Section<Row, Partial<Row>> = {
    initialState: { title: '', done: false },
    updater: mergeUpdaterGenerator<Row>()
};

test('two components on the same path stay in sync', () => {
    const store = createStore({ State: section });

    const Reader = () => {
        const [value] = useYasmState<typeof store.sectionMap, 'State', number>(
            'State',
            '/a',
            state => state.value
        );
        return <span data-testid="reader">{value}</span>;
    };

    const Writer = () => {
        const [, update] = useYasmState<
            typeof store.sectionMap,
            'State',
            unknown
        >('State', '/a');
        return <button onClick={() => update({ value: 42 })}>write</button>;
    };

    render(
        <YasmContext.Provider value={store}>
            <Reader />
            <Writer />
        </YasmContext.Provider>
    );

    expect(screen.getByTestId('reader')).toHaveTextContent('0');

    fireEvent.click(screen.getByText('write'));

    // The reader re-rendered with the writer's payload — the subscribe →
    // notify → commit loop works end to end.
    expect(screen.getByTestId('reader')).toHaveTextContent('42');
});

test('a subscriber re-renders when its own updater fires', () => {
    const store = createStore({ State: section });
    let readerRenders = 0;

    const Reader = () => {
        const [value, update] = useYasmState<
            typeof store.sectionMap,
            'State',
            number
        >('State', '/a', state => state.value);
        readerRenders++;
        return (
            <button onClick={() => update({ value: value + 1 })}>
                count:{value}
            </button>
        );
    };

    render(
        <YasmContext.Provider value={store}>
            <Reader />
        </YasmContext.Provider>
    );

    expect(readerRenders).toBe(1);
    expect(screen.getByText('count:0')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('count:1')).toBeInTheDocument();
    expect(readerRenders).toBe(2);
});

test('a selector that stays stable skips re-renders on unrelated changes', () => {
    const store = createStore({ State: section });
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

    // Unrelated part of the state changes → no re-render for this selector
    act(() => {
        store.memo.State['/a'].updater({ text: 'changed' });
    });
    expect(readerRenders).toBe(rendersAfterMount);
    expect(screen.getByTestId('reader')).toHaveTextContent('0');

    // Selected slice changes → exactly one more commit
    act(() => {
        store.memo.State['/a'].updater({ value: 7 });
    });
    expect(readerRenders).toBe(rendersAfterMount + 1);
    expect(screen.getByTestId('reader')).toHaveTextContent('7');
});

test('routed child components re-render when the parent row updates', () => {
    const store = createStore({
        Table: arraySectionGenerator('Row', rowSection),
        Row: rowSection
    });

    // Seed the parent table before any component mounts
    init(store, 'Table', '/t');
    store.memo.Table['/t'].updater({
        addingItems: [{ id: 3, partialState: { title: 'row3' } }],
        order: [3]
    });

    let rowRenders = 0;

    const RowReader = () => {
        const [title] = useYasmState<typeof store.sectionMap, 'Row', string>(
            'Row',
            '/t[3]',
            state => state.title
        );
        rowRenders++;
        return <span data-testid="row">{title}</span>;
    };

    render(
        <YasmContext.Provider value={store}>
            <RowReader />
        </YasmContext.Provider>
    );

    expect(screen.getByTestId('row')).toHaveTextContent('row3');

    // The routed record's updater writes inside the parent's map, and the
    // child subscriber is notified through its routed subscription.
    act(() => {
        store.memo.Row['/t[3]'].updater({ title: 'updated' });
    });

    expect(screen.getByTestId('row')).toHaveTextContent('updated');
    expect(rowRenders).toBe(2);
    expect(store.state.Table['/t'].map[3].title).toBe('updated');
});
