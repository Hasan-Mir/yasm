import { act, render, screen } from '@testing-library/react';
import { YasmContext } from '../../src/Context';
import { Section, createStore } from '../../src/createStore';
import { init, useYasmState } from '../../src/useYasmState';
import { mergeUpdaterGenerator } from '../../src/util';

type State = { value: number; text: string };
const section: Section<State, Partial<State>> = {
    initialState: { value: 0, text: '' },
    updater: mergeUpdaterGenerator<State>()
};

test('an external (non-React) update still reaches mounted subscribers', () => {
    const store = createStore({ State: section });
    init(store, 'State', '/a');

    const Reader = () => {
        const [value] = useYasmState<typeof store.sectionMap, 'State', number>(
            'State',
            '/a',
            state => state.value
        );
        return <span data-testid="reader">{value}</span>;
    };

    render(
        <YasmContext.Provider value={store}>
            <Reader />
        </YasmContext.Provider>
    );

    act(() => {
        store.memo.State['/a'].updater({ value: 99 });
    });

    // This exercises the raw record.subscribe path that useSyncExternalStore
    // relies on, independent of any component-owned updater.
    expect(screen.getByTestId('reader')).toHaveTextContent('99');
});
