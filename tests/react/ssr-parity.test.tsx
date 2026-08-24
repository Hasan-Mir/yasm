import { render } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { YasmContext } from '../../src/Context';
import { Section, createStore } from '../../src/createStore';
import { init, useYasmState } from '../../src/useYasmState';
import { mergeUpdaterGenerator } from '../../src/util';

type State = { value: number; text: string };
const section: Section<State, Partial<State>> = {
    initialState: { value: 0, text: '' },
    updater: mergeUpdaterGenerator<State>()
};

test('SSR output matches client-rendered DOM for the same store state', () => {
    const store = createStore({ State: section });
    init(store, 'State', '/a');
    store.memo.State['/a'].updater({ value: 42 });

    const Reader = () => {
        const [value] = useYasmState<typeof store.sectionMap, 'State', number>(
            'State',
            '/a',
            state => state.value
        );
        return <span>count:{value}</span>;
    };

    const html = renderToString(
        <YasmContext.Provider value={store}>
            <Reader />
        </YasmContext.Provider>
    );

    const { container, unmount } = render(
        <YasmContext.Provider value={store}>
            <Reader />
        </YasmContext.Provider>
    );

    // Server HTML carries React's text-separator comment markers; strip them
    // from BOTH sides so they can be compared as plain markup.
    const clientHtml = container.innerHTML.replace(/<!--.*?-->/g, '');
    const serverHtml = html.replace(/<!--.*?-->/g, '');

    expect(clientHtml).toBe(serverHtml);
    expect(serverHtml).toContain('count:42');
    unmount();
});
