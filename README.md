# 🧩 YASM — Yet Another State Management!

> Path-based, purgeable, composable state management for React — built on `useSyncExternalStore` and `immer`.

YASM organizes state as a grid of **Sections × Paths**. A _section_ defines the shape and update logic of a piece of state (like a mini-reducer), and a _path_ is a string address for one **instance** of that section. This makes YASM ideal for applications that open many instances of the same UI simultaneously—like an ERP with dozens of tabs, tables, and dialogs—and lets you **purge** everything under a path when a tab closes.

---

## ✨ Features

- 🗂️ **Multi-instance state**: The same section can live at unlimited paths. `useYasmState('UserTable', '/tabs/1/users')` and `useYasmState('UserTable', '/tabs/2/users')` are fully independent.
- 🧹 **Purgeable state**: Free all state under a path prefix in one call: `purge('/tabs/1')`. Segment-aware matching guarantees `/tabs/1` never touches `/tabs/10`.
- 🧬 **Composable sections**: `arraySectionGenerator` and `objectSectionGenerator` build parent sections whose children are addressable through **path routing**: `useYasmState('Row', '/table[3]')` reads/writes the row _inside_ the table state immutably, with parent subscribers notified.
- ⚡ **Precise re-renders**: Components subscribe per `(section, path)` and can narrow further with selectors. No top-down re-render cascades.
- ✍️ **Reducer-like updaters with Immer**: Write mutable code, get immutable updates. Updaters returning an unchanged state produce **no** notification churn (reference equality is preserved).
- 🦥 **Lazy initialization**: State is created on first use, optionally with `overrideInitialState` (object or function form).
- 🎯 **Payload creators**: `updater(state => payload)` reads the latest state at dispatch time, avoiding stale closures.
- 🧰 **Zero setup**: `createStore(sectionMap)` + one context provider. No actions, no dispatch strings, no boilerplate.
- 🛡️ **Safe async updates**: Updaters fired after a purge (from `setTimeout`, promises, or stale handlers) are silent no-ops instead of crashes.
- 🩺 **Dev diagnostics**: Helpful errors for unknown sections or missing providers, warnings when purging state that still has mounted subscribers, and opt-in state logging.
- 💾 **Built-in persistence**: Hydrate and save through any sync or async key-value storage, with debounced autosave, section omission, lifecycle hooks, deep normalization, and custom serialization.

---

## 📦 Installation

```bash
npm install @mrnafisia/yasm
# react >= 18.2 is a peer dependency (immer is included automatically)
```

---

## 🚀 Quick Start

```tsx
import {
    createStore,
    YasmContext,
    useYasmState,
    usePurgeYasmState,
    mergeUpdaterGenerator,
    type Section
} from '@mrnafisia/yasm';

// 1. Define sections
type CounterState = { count: number; label: string };
const counterSection: Section<CounterState, Partial<CounterState>> = {
    initialState: { count: 0, label: '' },
    updater: mergeUpdaterGenerator<CounterState>()
};

// 2. Create the store (once, outside components)
const store = createStore({ Counter: counterSection });

// 3. Provide it
const App = () => (
    <YasmContext.Provider value={store}>
        <Counter path="/tabs/1/counter" />
        <Counter path="/tabs/2/counter" />
    </YasmContext.Provider>
);

// 4. Use it — each path is an independent instance
const Counter = ({ path }: { path: string }) => {
    const [count, update] = useYasmState('Counter', path, s => s.count);
    return (
        <button onClick={() => update(s => ({ count: s.count + 1 }))}>
            {count}
        </button>
    );
};
```

---

## 🧠 Core Concepts

### Sections

A section is `{ initialState, updater, routing?, normalize? }`. The updater is Immer-powered: mutate the draft **or** return a new state.

```ts
type Todo = { id: number; title: string };
const todoSection: Section<Todo[], { add: Todo }> = {
    initialState: [],
    updater: (state, { add }) => {
        state.push(add); // mutate freely — immer handles immutability
    }
};
```

### Paths

Paths are plain strings, but by convention, they are hierarchical: `/tabs/12/users/table`. Segments are separated by `/`, `[`, or `.`. Purging and routing are **segment-aware**: `/tabs/1` covers `/tabs/1/x` and `/tabs/1[3]` but **not** `/tabs/10`.

### Updaters & Payload Creators

```ts
const [state, update] = useYasmState('Counter', '/c');

update({ count: 5 }); // Payload
update(prev => ({ count: prev.count + 1 })); // Payload creator (reads latest state)
```

### Selectors & Overrides

```ts
const [label] = useYasmState('Counter', '/c', s => s.label);

const [state, update] = useYasmState('Counter', '/c', {
    selector: s => s,
    overrideInitialState: { count: 100 } // Used only on first initialization
});
```

> ⚠️ **Warning**: Selectors must return **stable** values for unchanged state (primitives, or references stored in state). A selector that builds a new object/array on every call will cause infinite re-renders under `useSyncExternalStore`.

---

## 🧬 Composition & Routing

### ArraySection

```ts
const store = createStore({
    UserTable: arraySectionGenerator('UserRow', userRowSection),
    UserRow: userRowSection
});

// Parent: the whole table
const [table, updateTable] = useYasmState('UserTable', '/users');
updateTable({
    addingItems: [{ id: 7, partialState: { name: 'Sara' } }],
    order: [7]
});

// Child: one row, addressed *through* the parent
const [row, updateRow] = useYasmState('UserRow', '/users[7]');
updateRow({ name: 'Sara A.' }); // Immutably updates the row inside the table
```

The `updater` payload supports `order`, `addingItems`, `editingItems`, and `removingIDs`. These are applied in the order: **order → removals → additions → edits**, allowing you to add and edit the same item in a single update.

### ObjectSection

```ts
const formSection = objectSectionGenerator({
    profile: { name: 'Profile', state: profileState, updater: profileUpdater },
    address: { name: 'Address', state: addressState, updater: addressUpdater }
});
// Child access: useYasmState('Profile', '/form[profile]')
```

> ⚠️ **Warning**: Registered routing paths must not be nested within each other. YASM logs an error in development if a path is a segment-prefix of another registered path of a routing section.

---

## 🧹 Purging

```tsx
const purge = usePurgeYasmState();

// When tab 12 closes:
purge('/tabs/12'); // Removes state, subscribers, memo records & path registrations
```

- Matching is **segment-aware** by default. Pass `{ match: 'startsWith' }` for legacy raw-prefix behavior.
- Purge **after** the components using that state have unmounted (e.g., from a `useEffect` with a `setTimeout` at the app root). In development, YASM warns _at purge time_ if subscribers are still attached, specifying the exact section and path.
- Purging is idempotent and never throws for unknown/already-purged paths or stale sections restored from persistence.
- Outside React (tests, event buses), use the pure function: `purgeYasmState(store, '/tabs/12')`.

---

## 💾 Persistence

Persistence is configured in the second argument to `createStore`. YASM saves `store.state`, `store.pathRegistry`, and a small `metadata` record (used for migration bookkeeping). The registry is required to restore composition/routing correctly.

The storage adapter may be synchronous or asynchronous and must provide the following shape:

```ts
type YasmPersistenceAdapter = {
    getItem(key: string): string | null | Promise<string | null>;
    setItem(key: string, value: string): void | Promise<void>;
    removeItem(key: string): void | Promise<void>;
    clear?(): void | Promise<void>;
};
```

### Browser Example with `localStorage`

```tsx
import { ReactNode, useEffect, useState } from 'react';
import { createStore, YasmContext } from '@mrnafisia/yasm';

const store = createStore(
    {
        BaseInfo: baseInfoSection,
        UserTable: userTableSection,
        UserManage: userManageSection
    },
    {
        persist: {
            key: 'my-app:yasm-state',
            storage: window.localStorage,

            // Do not persist permissions, tokens, temporary UI, etc.
            omitSections: ['BaseInfo'],

            // Save after YASM updates and purges, debounced by 1.5 seconds.
            autoSave: true,
            persistDebounceMS: 1500,

            onHydrated: () => {
                console.info('YASM state restored');
            }
        }
    }
);

export const StoreProvider = ({ children }: { children: ReactNode }) => {
    const [ready, setReady] = useState(false);

    useEffect(() => {
        let cancelled = false;

        store.hydrate().finally(() => {
            if (!cancelled) setReady(true);
        });

        return () => {
            cancelled = true;
        };
    }, []);

    return (
        <YasmContext.Provider value={store}>
            {/* Critical: do not mount any useYasmState consumers before hydration finishes */}
            {ready ? children : null}
        </YasmContext.Provider>
    );
};
```

> ⚠️ **Race Condition Warning**
> Call `store.hydrate()` **once** during application startup **and before mounting any component that calls `useYasmState`**.
> If a component initializes a path before `hydrate()` finishes, the path is created with the current `initialState`. When the persisted data later arrives, it is shallow-merged, which can produce surprising results or overwrite user actions that happened in the meantime.
> `hydrate()` always resolves (even on failure); on error, YASM logs the issue, keeps the stored snapshot intact, and leaves the fresh in-memory state in place.

### LocalForage / IndexedDB Adapter

`localforage` (and most IndexedDB wrappers) return the raw value, not necessarily a string. Wrap it so `getItem` always yields the serialized string that YASM expects:

```ts
import localforage from 'localforage';

const storage = {
    getItem: (key: string) => localforage.getItem<string>(key),
    setItem: (key: string, value: string) =>
        localforage.setItem(key, value).then(() => undefined),
    removeItem: (key: string) => localforage.removeItem(key),
    clear: () => localforage.clear()
};

const store = createStore(sectionMap, {
    persist: {
        key: 'yasmState',
        storage,
        autoSave: true
    }
});
```

### Manual Save & Autosave

```ts
await store.save(); // Save immediately, e.g., for Ctrl/Cmd+S
```

- `autoSave` defaults to `false`. It may be a boolean or `() => boolean` for runtime control.
- `persistDebounceMS` defaults to `1000`. It may be a number or `() => number`.
- Autosave is scheduled after YASM state updates and successful purges. In browsers, it uses `requestIdleCallback` when available, with a `setTimeout` fallback.
- `store.save()` is always available and bypasses the debounce. It does nothing when no `persist` configuration is supplied.
- `store.save()` captures the state snapshot at the exact moment it is called. Concurrent saves are serialized through an internal FIFO queue, so the newest completed write always wins.
- ⚠️ Autosave is debounced. If the app closes within the debounce window, the last changes are lost. Flush manually with `await store.save()` from a `pagehide` or `visibilitychange` listener when needed.

### Excluding Sections

Use `omitSections` for sensitive, stale, or transient sections. Omitted sections (and their `pathRegistry` entries) are excluded from the snapshot entirely; they initialize lazily from their `initialState` the next time they are used.

```ts
persist: {
    key: 'yasmState',
    storage,
    omitSections: ['Credential', 'TemporaryUI']
}
```

Or compute the list dynamically at save time:

```ts
omitSections: state =>
    state.Credential['/credential']?.rememberMe
        ? ['TemporaryUI']
        : ['Credential', 'TemporaryUI'];
```

Both the `state` and the `pathRegistry` entries of omitted sections are excluded, ensuring nothing from these sections ever reaches storage.

### Custom Serialization (`Date`, `BigInt`, `Decimal`, …)

Pass a JSON replacer-compatible `serializer` and reviver-compatible `deserializer` at the **top level** of the store options. They are used by persistence and debug snapshots.

```ts
const BIGINT_PREFIX = '$$BIGINT$$_';
const DECIMAL_PREFIX = '$$DECIMAL$$_';

const store = createStore(sectionMap, {
    serializer(object, key, value) {
        // `object` points to the parent holding the current key
        const original = object[key];

        if (typeof original === 'bigint') {
            return BIGINT_PREFIX + original.toString();
        }
        if (Decimal.isDecimal(original)) {
            return DECIMAL_PREFIX + original.toJSON();
        }
        return value;
    },
    deserializer(_key, value) {
        if (typeof value === 'string' && value.startsWith(BIGINT_PREFIX)) {
            return BigInt(value.slice(BIGINT_PREFIX.length));
        }
        if (typeof value === 'string' && value.startsWith(DECIMAL_PREFIX)) {
            return new Decimal(value.slice(DECIMAL_PREFIX.length));
        }
        // Prefer explicit prefixes over heuristic ISO-date detection
        return value;
    },
    persist: {
        key: 'yasmState',
        storage,
        autoSave: true
    }
});
```

### Preventing String Collisions

If you use string prefixes (like `$$BIGINT$$_`) for custom serialization, you must protect against users typing that exact prefix into a standard string input. If a user types `"$$BIGINT$$_123"` in a text field, the deserializer will mistakenly convert it into a `BigInt`!

To prevent this silent data corruption, implement a **Universal String Escape Mechanism**. By unconditionally prefixing _all_ strings with a dedicated tag (e.g., `$$STR$$_`), you guarantee that any string input is safely restored as a string, regardless of its contents.

#### Applying this to your App

You can optimize your own app's codebase by replacing previous naive `$$STR$$_` logic with this selective escaping:

```ts
function serializer(
    object: Record<string, unknown>,
    key: string,
    value: unknown
) {
    if (typeof object[key] === 'bigint') {
        return '$$BIGINT$$_' + object[key].toString();
    }

    if (Decimal.isDecimal(object[key])) {
        return '$$DECIMAL$$_' + object[key].toJSON();
    }

    // 🛡️ Escape mechanism for primitive strings:
    // We prepend `$$STR$$_` to ALL strings to prevent accidental type corruption.
    // If a user types exactly "$$BIGINT$$_123" in a text field, without this escape tag,
    // the deserializer would mistakenly convert that string input into a real BigInt object!
    // By wrapping it here, it becomes "$$STR$$_$$BIGINT$$_123", ensuring the deserializer
    // safely strips the string tag and restores the exact original text.
    if (typeof object[key] === 'string') {
        return '$$STR$$_' + object[key];
    }

    return value;
}

function deserializer(key: string, value: unknown) {
    if (typeof value !== 'string') {
        return value;
    }

    if (value.startsWith('$$BIGINT$$_')) {
        return BigInt(value.slice('$$BIGINT$$_'.length));
    }

    if (value.startsWith('$$DECIMAL$$_')) {
        return new Decimal(value.slice('$$DECIMAL$$_'.length));
    }

    if (value.startsWith('$$STR$$_')) {
        return value.slice('$$STR$$_'.length);
    }

    if (isISODateString(value)) {
        return new Date(value);
    }

    return value;
}

const store = createStore(sectionMap, {
    serializer,
    deserializer,
    persist: {
        key: 'yasmState',
        storage,
        autoSave: true
    }
});
```

💡 Best Practice Note: Notice the use of `value.slice('$$STR$$_'.length)` instead of `value.replace`. Using `.slice` is significantly faster because it simply trims the start of the string without running a search operation. It also prevents dangerous bugs where developers might accidentally use a global Regex (e.g., `.replace(/\$\$STR\$\$_/g, '')`) which would severely corrupt the user's data if they naturally typed that exact string in the middle of a sentence.

### Lifecycle Hooks and Fully Custom Persistence

```ts
persist: {
    key: 'yasmState',
    storage,

    onBeforeSave: snapshot => {
        // Observe or prepare the snapshot (omissions already applied)
        // immediately before serialization.
        // ⚠️ Read-only: value objects are shared with the live store —
        // never mutate them.
    },

    // Runs after managed migrations and after JSON.parse + deserializer,
    // but *before* normalization & merge. Use it for arbitrary final
    // snapshot transformations.
    onBeforeHydrate: snapshot => {
        // mutate snapshot.state / snapshot.pathRegistry in place
    },

    onHydrated: () => {
        // Safe to start services that depend on restored state
    },

    // Runs after the built-in storage write (or alone for a fully custom backend)
    customPersistCallback: async snapshot => {
        await sendSnapshotToServer({
            state: snapshot.state,
            pathRegistry: snapshot.pathRegistry
        });
    }
}
```

`customPersistCallback` can be used without `key`/`storage` for a completely custom save destination. Hydration, however, still requires the built-in `key` + `storage` pair; custom loading must be performed by the consumer before mounting the provider.

### State Normalization & Transient Fields

By default, YASM normalizes every restored path against the section’s current `initialState` before merging it into the store. This makes ordinary schema evolution safe. We have deep native support for resetting transient properties through configuration options.

```ts
persist: {
    key: 'yasmState',
    storage,
    normalization: {
        // Default true — remove fields that no longer exist in initialState
        pruneStaleFields: true,

        // Reset matching fields to their initialState values globally
        transientPatterns: [/loading/i, /isLoading/i, /submitting/i],

        // Exact field names reset explicitly per section.
        // Note: Thanks to "Deep Normalization", this natively works for children of ArraySections and ObjectSections!
        transientExact: {
            UserTable: ['selectedRowId'],
            Row: ['isLoading'] // Works seamlessly for items inside tables!
        },

        // Fully custom rule matching evaluation
        isTransient: (sectionName, fieldName) =>
            sectionName === 'UserManage' && fieldName === 'draftToken'
    }
}
```

- **Added fields**: Properties present in the current `initialState` but missing from the persisted data receive their initial values.
- **Removed fields**: With `pruneStaleFields: true` (default), they are deleted. Set to `false` for sections whose state is intentionally a dynamic dictionary.
- **Transient fields**: Matched fields are reset to the current `initialState` value. This prevents a page refresh that occurs while a request is in flight from restoring `isLoading: true` with no remaining callback that would ever clear it.
- **Deep Normalization**: When a `Section` has a `normalize` hook (like those generated by `arraySectionGenerator` or `objectSectionGenerator`), YASM traverses the composed rows/children and applies your transient rules with the child section's name. This covers one composition level (e.g., rows of a table). For nested compositions (a composed section inside another), provide a custom `normalize` hook on the outer section that recurses itself.
- **Corruption healing**: On hydration, `ArraySection` order data is healed: duplicate IDs are deduplicated, stringified IDs are coerced back to numbers, and non-numeric entries or IDs without a matching map item are dropped.

Pass `normalization: false` to disable the whole step.

YASM also drops sections that no longer exist in the current `sectionMap` and filters `pathRegistry` entries that point at removed sections, ensuring an old persisted snapshot cannot leave stale routing data behind.

### Migrations (Application-Specific)

Normalization covers the common "add / remove field" cases. For renames, type changes, or any other structural transformation, you need a real migration.

**Use `migrations`**. YASM natively manages schema tracking and prevents duplicate executions. Migrations are mapped directly to specific Sections.

Recommended pattern (idempotent, per-section, tracked by ID):

```ts
import { type StateMigration } from '@mrnafisia/yasm';

const APP_STATE_MIGRATIONS: Partial<
    Record<keyof typeof store.sectionMap, StateMigration[]>
> = {
    TransactionManage: [
        {
            id: '2026-04-27T13:02:00.000Z',
            migrate: stateValue => {
                // Rename
                if ('loading' in stateValue) {
                    stateValue.isLoading = stateValue.loading;
                    delete stateValue.loading;
                }
                // Type change
                if (typeof stateValue.date === 'string') {
                    stateValue.date = new Date(stateValue.date);
                }
            }
        }
    ]
};

const store = createStore(sectionMap, {
    persist: {
        key: 'yasmState',
        storage,
        autoSave: true,
        migrations: APP_STATE_MIGRATIONS
    }
});
```

**Notes:**

- Keep migration IDs unique across the whole application.
- Migrations must be idempotent; they may run again after a hard reload if the bookkeeping entry is lost.
- On a fresh install (empty storage), every configured migration is immediately marked as executed—natively created state already matches the current schema.
- A migration that produces fields absent from the section's `initialState` will see them pruned afterwards by default normalization (`pruneStaleFields: true`).
- Do **not** put migration logic in `onBeforeSave`—that only affects future writes, never the data that is being read.

---

## 🧪 Generic Sections

```ts
const createValueSection = <T>(initial: T): Section<{ value: T }, T> => ({
    initialState: { value: initial },
    updater: (state, payload) => {
        state.value = payload;
    }
});

const store = createStore({
    Volume: createValueSection<number>(50),
    Theme: createValueSection<'light' | 'dark'>('light')
});
```

A single section cannot be generic at the call site (`useYasmState<'Array', number>(...)`) because TypeScript generics are erased. The idiomatic pattern is one `unknown`-typed section plus a thin typed wrapper hook:

```ts
const useValueState = <T>(path: string, initial: T) => {
    const [state, update] = useYasmState('GenericValue', path, {
        selector: s => s.value as T,
        overrideInitialState: { value: initial }
    });
    return [state, (value: T) => update({ value })] as const;
};
```

---

## 💡 Tips & Notes

- 🏷️ **Name paths after your UI hierarchy** (`/tabs/{id}/...`) so a single purge call cleans a whole tab.
- 🧯 **Don’t purge paths that are still rendered.**
- 🔁 **Don’t subscribe to state you only write.** Use a constant selector (`() => null`) to obtain just the updater.
- 💾 **Use normalization for ordinary schema changes**; use `migrations` for real application structural changes.
- 🐞 **Debugging options** live under `debugOptions`:
    - `logStateUpdates: true`
    - `snapshotScope: 'local' | 'full'` (default `'local'`)
    - `purgeSnapshotScope: 'none' | 'full'` (default `'none'`)
- 🚫 **A payload that is a function is always treated as a payload creator**—never store bare functions as payloads.

---

## ⚖️ Comparison with Other Libraries

| Feature                    | **YASM**                                  | **Redux Toolkit**               | **Zustand**          | **Jotai**                  | **React Context**      |
| :------------------------- | :---------------------------------------- | :------------------------------ | :------------------- | :------------------------- | :--------------------- |
| **Mental model**           | Sections × Paths                          | Single store + slices           | Store hooks          | Atoms                      | Tree-scoped values     |
| **Multi-instance state**   | ✅ First-class (paths)                    | 🔶 Manual (keyed slices)        | 🔶 Store factories   | 🔶 Atom families           | 🔶 Nested providers    |
| **Freeing memory (purge)** | ✅ One call per path prefix               | 🔶 Manual actions               | 🔶 Manual            | ✅ Auto GC-ish (unmount)   | ✅ Unmount             |
| **Re-render precision**    | ✅ Per path + selector                    | ✅ Selectors                    | ✅ Selectors         | ✅ Per atom                | ❌ All consumers       |
| **Immutability**           | ✅ Immer built-in                         | ✅ Immer built-in               | 🔶 Manual/middleware | ✅                         | —                      |
| **Boilerplate**            | Low                                       | Medium                          | Low                  | Low                        | Low                    |
| **Devtools**               | ❌ (Logging only)                         | ✅ Excellent                    | ✅                   | ✅                         | ❌                     |
| **Ecosystem/middleware**   | ❌ Minimal                                | ✅ Huge                         | ✅ Rich              | ✅ Rich                    | —                      |
| **Best for**               | Tabbed/multi-instance apps (ERP, editors) | Large teams, strict conventions | General apps         | Fine-grained derived state | Rarely-changing config |

**When YASM shines**: Many simultaneous instances of the same screens whose state must be created and destroyed dynamically (tabs, windows, dialogs, wizards).

**When to pick something else**: You need time-travel debugging, a rich middleware ecosystem, or heavy derived/computed state graphs.

---

## 📚 API Reference (Summary)

| Export                                            | Kind     | Description                                                                                                                |
| :------------------------------------------------ | :------- | :------------------------------------------------------------------------------------------------------------------------- |
| `createStore(sectionMap, options?)`               | function | Creates the store. Options include debugging, persistence, path boundaries, serialization, and `onStateChange`.            |
| `store.hydrate()`                                 | method   | Loads and merges state + path registry from the configured persistence adapter. Must be awaited before mounting consumers. |
| `store.save()`                                    | method   | Immediately saves through built-in and/or custom persistence.                                                              |
| `YasmContext`                                     | context  | Provide the store to your tree.                                                                                            |
| `useYasmState(name, path, selectorOrOptions?)`    | hook     | Returns `[state, updater]`. Options: `selector`, `overrideInitialState`.                                                   |
| `usePurgeYasmState()`                             | hook     | Returns `purge(pathPrefix, options?)`.                                                                                     |
| `purgeYasmState(store, pathPrefix, options?)`     | function | Pure purge — usable outside React.                                                                                         |
| `arraySectionGenerator(childName, childSection)`  | function | Ordered map of child states with routing.                                                                                  |
| `objectSectionGenerator(map)`                     | function | Named composition of child sections with routing.                                                                          |
| `mergeUpdaterGenerator<S>()`                      | function | `Partial<S>` shallow-merge updater.                                                                                        |
| `propertyUpdaterGenerator<S>()`                   | function | `{ key, value }` updater.                                                                                                  |
| `getFieldSetter(updateState, field)`              | function | Cached per-field setter factory.                                                                                           |
| `isPathWithinPrefix(path, prefix, boundaryChars)` | function | Segment-aware prefix check.                                                                                                |

---

## 🧪 Tests

```bash
npm run test        # node:test via tsx
npm run typecheck   # tsc -p tsconfig.test.json
```

---

## 📄 License

MIT © MRNafisiA

```

```
