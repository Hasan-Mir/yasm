import { act, fireEvent, render, screen } from '@testing-library/react';
import { YasmContext } from '../../src/Context';
import { Section, createStore } from '../../src/createStore';
import { useCloneYasmSubtree } from '../../src/useCloneYasmSubtree';
import { useYasmState } from '../../src/useYasmState';
import { mergeUpdaterGenerator } from '../../src/util';

type State = { value: number; text: string };
const section: Section<State, Partial<State>> = {
    initialState: { value: 0, text: '' },
    updater: mergeUpdaterGenerator<State>()
};

test('useCloneYasmSubtree clones into a mounted target and notifies it', () => {
    const store = createStore({ State: section });

    const Cloner = () => {
        const clone = useCloneYasmSubtree<typeof store.sectionMap>();
        return (
            <button onClick={() => clone('/tabs/1', '/tabs/2')}>clone</button>
        );
    };

    const Reader = ({ path, testId }: { path: string; testId: string }) => {
        const [value] = useYasmState<typeof store.sectionMap, 'State', number>(
            'State',
            path,
            state => state.value
        );
        return <span data-testid={testId}>{value}</span>;
    };

    render(
        <YasmContext.Provider value={store}>
            <Cloner />
            <Reader path="/tabs/1" testId="source" />
            <Reader path="/tabs/2" testId="target" />
        </YasmContext.Provider>
    );

    act(() => {
        store.memo.State['/tabs/1'].updater({ value: 7 });
    });

    expect(screen.getByTestId('source').textContent).toBe('7');
    expect(screen.getByTestId('target').textContent).toBe('0');

    // The already-mounted target must re-render with the cloned value
    fireEvent.click(screen.getByText('clone'));

    expect(screen.getByTestId('target').textContent).toBe('7');
    expect(store.state.State['/tabs/2'].value).toBe(7);

    // The clone stays independent from the source after the duplication
    act(() => {
        store.memo.State['/tabs/1'].updater({ value: 99 });
    });

    expect(screen.getByTestId('source').textContent).toBe('99');
    expect(screen.getByTestId('target').textContent).toBe('7');
});

test('useCloneYasmSubtree returns a stable callback across re-renders', () => {
    const store = createStore({ State: section });
    const captured: {
        current: ((source: string, target: string) => void) | undefined;
    } = { current: undefined };

    const Harness = () => {
        captured.current = useCloneYasmSubtree<typeof store.sectionMap>();
        return null;
    };

    const makeTree = () => (
        <YasmContext.Provider value={store}>
            <Harness />
        </YasmContext.Provider>
    );

    const view = render(makeTree());
    const first = captured.current;

    view.rerender(makeTree());
    view.rerender(makeTree());

    expect(first).toBeDefined();
    expect(captured.current).toBe(first);
});
