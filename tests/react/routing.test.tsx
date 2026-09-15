import { act, fireEvent, render, screen } from '@testing-library/react';
import { YasmContext } from '../../src/Context';
import { Section, createStore } from '../../src/createStore';
import { init, useYasmState } from '../../src/useYasmState';
import {
    arraySectionGenerator,
    mergeUpdaterGenerator,
    objectSectionGenerator
} from '../../src/util';

type Row = { title: string; done: boolean };
const rowSection: Section<Row, Partial<Row>> = {
    initialState: { title: '', done: false },
    updater: mergeUpdaterGenerator<Row>()
};

test('a parent-section reader re-renders when its routed row child updates', () => {
    const store = createStore({
        Table: arraySectionGenerator('Row', rowSection),
        Row: rowSection
    });

    // Seed the parent before mounting
    init(store, 'Table', '/t');
    store.memo.Table['/t'].updater({
        addingItems: [{ id: 3, partialState: { title: 'row3' } }],
        order: [3]
    });

    let tableRenders = 0;

    const TableReader = () => {
        // No selector: subscribes to the whole parent state
        useYasmState<typeof store.sectionMap, 'Table', unknown>('Table', '/t');
        tableRenders++;
        return null;
    };

    const RowReader = () => {
        const [title] = useYasmState<typeof store.sectionMap, 'Row', string>(
            'Row',
            '/t[3]',
            state => state.title
        );
        return <span data-testid="row">{title}</span>;
    };

    render(
        <YasmContext.Provider value={store}>
            <TableReader />
            <RowReader />
        </YasmContext.Provider>
    );
    const rendersAfterMount = tableRenders;

    // The child writes through its routed record...
    act(() => {
        store.memo.Row['/t[3]'].updater({ title: 'updated' });
    });

    expect(screen.getByTestId('row')).toHaveTextContent('updated');
    // ...and the parent-section subscriber is notified too, because the
    // write mutated the parent's state (immutably — new parent reference)
    expect(tableRenders).toBe(rendersAfterMount + 1);
    expect(store.state.Table['/t'].map[3].title).toBe('updated');
});

test('multi-level routing (Table → Row → Profile) works with mounted components', () => {
    const profileSection: Section<{ name: string }, { name?: string }> = {
        initialState: { name: '' },
        updater: mergeUpdaterGenerator<{ name: string }>()
    };
    const settingsSection: Section<
        { compact: boolean },
        { compact?: boolean }
    > = {
        initialState: { compact: false },
        updater: mergeUpdaterGenerator<{ compact: boolean }>()
    };
    const rowForm = objectSectionGenerator({
        profile: {
            name: 'Profile',
            state: profileSection.initialState,
            updater: profileSection.updater
        },
        settings: {
            name: 'Settings',
            state: settingsSection.initialState,
            updater: settingsSection.updater
        }
    });
    const store = createStore({
        Table: arraySectionGenerator('Row', rowForm),
        Row: rowForm,
        Profile: profileSection,
        Settings: settingsSection
    });

    // Seed: Table '/table' → row 5 → profile.name 'Sara'
    init(store, 'Table', '/table');
    store.memo.Table['/table'].updater({
        addingItems: [{ id: 5, partialState: { profile: { name: 'Sara' } } }],
        order: [5]
    });
    init(store, 'Row', '/table[5]');

    let tableRenders = 0;

    const ProfileReader = () => {
        const [name] = useYasmState<typeof store.sectionMap, 'Profile', string>(
            'Profile',
            '/table[5][profile]',
            state => state.name
        );
        return <span data-testid="profile">{name}</span>;
    };

    const ProfileWriter = () => {
        const [, update] = useYasmState<
            typeof store.sectionMap,
            'Profile',
            unknown
        >('Profile', '/table[5][profile]');
        return (
            <button onClick={() => update({ name: 'Updated' })}>rename</button>
        );
    };

    const TableWatcher = () => {
        useYasmState<typeof store.sectionMap, 'Table', unknown>(
            'Table',
            '/table'
        );
        tableRenders++;
        return null;
    };

    render(
        <YasmContext.Provider value={store}>
            <ProfileReader />
            <ProfileWriter />
            <TableWatcher />
        </YasmContext.Provider>
    );

    // The two-level routed read resolves through Row into Table's map
    expect(screen.getByTestId('profile')).toHaveTextContent('Sara');
    const rendersAfterMount = tableRenders;

    fireEvent.click(screen.getByText('rename'));

    // The routed leaf re-rendered with the new value...
    expect(screen.getByTestId('profile')).toHaveTextContent('Updated');
    // ...the write landed two levels deep inside the parent's map...
    expect(store.state.Table['/table'].map[5].profile.name).toBe('Updated');
    // ...the top-level subscriber was notified...
    expect(tableRenders).toBe(rendersAfterMount + 1);
    // ...and the routed leaf never created its own storage
    expect(store.state.Profile['/table[5][profile]']).toBeUndefined();
});
