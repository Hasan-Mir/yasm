# 🧩 YASM — Yet Another State Management!

> Path-based, purgeable, composable state management for React — built on `useSyncExternalStore` and `immer`.

YASM organizes state as a grid of **Sections × Paths**. A *section* defines the shape and update logic of a piece of state (like a mini-reducer), and a *path* is a string address for one **instance** of that section. This makes YASM ideal for apps that open many instances of the same UI at once — like an ERP with dozens of tabs, tables and dialogs — and lets you **purge** everything under a path when a tab closes.

---

## ✨ Features

- 🗂️ **Multi-instance state** — the same section can live at unlimited paths: `useYasmState('UserTable', '/tabs/1/users')` and `useYasmState('UserTable', '/tabs/2/users')` are fully independent.
- 🧹 **Purgeable state** — free all state under a path prefix in one call: `purge('/tabs/1')`. Segment-aware matching guarantees `/tabs/1` never touches `/tabs/10`.
- 🧬 **Composable sections** — `arraySectionGenerator` and `objectSectionGenerator` build parent sections whose children are addressable through **path routing**: `useYasmState('Row', '/table[3]')` reads/writes the row *inside* the table state, immutably, with parent subscribers notified.
- ⚡ **Precise re-renders** — components subscribe per `(section, path)` and can narrow further with selectors. No top-down re-render cascades.
- ✍️ **Reducer-like updaters with immer** — write mutable code, get immutable updates. Updaters returning an unchanged state produce **no** notification churn (reference equality is preserved).
- 🦥 **Lazy initialization** — state is created on first use, optionally with `overrideInitialState` (object or function form).
- 🎯 **Payload creators** — `updater(state => payload)` reads the latest state at dispatch time, avoiding stale closures.
- 🧰 **Zero setup** — `createStore(sectionMap)` + one context provider. No actions, no dispatch strings, no boilerplate.
- 🛡️ **Safe async updates** — updaters fired after a purge (from `setTimeout`, promises, stale handlers) are silent no-ops instead of crashes.
- 🩺 **Dev diagnostics** — helpful errors for unknown sections / missing provider, warnings when purging state that still has mounted subscribers, opt-in state logging.

---

## 📦 Installation

```bash
npm install @mrnafisia/yasm immer
# react >= 18.2 is a peer dependency
```

---

## 🚀 Quick start

```tsx
import {
    createStore,
    YasmContext,
    useYasmState,
    usePurgeYasmState,
    mergeUpdaterGenerator,
    Section
} from '@mrnafisia/yasm';

// 1. Define sections
type CounterState = { count: number; label: string };
const counterSection: Section<CounterState, Partial<CounterState>> = {
    initialState: { count: 0, label: '' },
    updater: mergeUpdaterGenerator<CounterState>()
};

// 2. Create the store (once, outside components)
const store = createStore({ Counter: counterSection });
type AppSectionMap = typeof store extends infer S ? S : never;

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
    return <button onClick={() => update(s => ({ count: s.count + 1 }))}>{count}</button>;
};
```

---

## 🧠 Core concepts

### Sections

A section is `{ initialState, updater, routing? }`. The updater is immer-powered: mutate the draft **or** return a new state.

```ts
const todoSection: Section<Todo[], { add: Todo }> = {
    initialState: [],
    updater: (state, { add }) => {
        state.push(add); // mutate freely — immer handles immutability
    }
};
```

### Paths

Paths are plain strings, but by convention they are hierarchical: `/tabs/12/users/table`. Segments are separated by `/`, `[` or `.`. Purging and routing are **segment-aware**: `/tabs/1` covers `/tabs/1/x` and `/tabs/1[3]` but not `/tabs/10`.

### Updaters & payload creators

```ts
const [state, update] = useYasmState('Counter', '/c');
update({ count: 5 });                          // payload
update(prev => ({ count: prev.count + 1 }));   // payload creator (reads latest state)
```

### Selectors & overrides

```ts
const [label] = useYasmState('Counter', '/c', s => s.label);
const [state, update] = useYasmState('Counter', '/c', {
    selector: s => s,
    overrideInitialState: { count: 100 } // used only on first initialization
});
```

> ⚠️ Selectors must return **stable** values for unchanged state (primitives, or references stored in state). A selector that builds a new object/array every call will re-render forever under `useSyncExternalStore`.

---

## 🧬 Composition & routing

### ArraySection

```ts
const store = createStore({
    UserTable: arraySectionGenerator('UserRow', userRowSection),
    UserRow: userRowSection
});

// Parent: the whole table
const [table, updateTable] = useYasmState('UserTable', '/users');
updateTable({ addingItems: [{ id: 7, partialState: { name: 'Sara' } }], order: [7] });

// Child: one row, addressed *through* the parent
const [row, updateRow] = useYasmState('UserRow', '/users[7]');
updateRow({ name: 'Sara A.' }); // immutably updates the row inside the table
```

The `updater` payload supports `order`, `addingItems`, `editingItems`, `removingIDs` — applied in the order **order → removals → additions → edits**, so you can add and edit the same item in a single update.

### ObjectSection

```ts
const formSection = objectSectionGenerator({
    profile: { name: 'Profile', state: profileState, updater: profileUpdater },
    address: { name: 'Address', state: addressState, updater: addressUpdater }
});
// child access: useYasmState('Profile', '/form[profile]')
```

> ⚠️ Registered routing paths must not be nested within each other — YASM logs an error in development if a path is a segment-prefix of another registered path of a routing section.

---

## 🧹 Purging

```tsx
const purge = usePurgeYasmState();

// when tab 12 closes:
purge('/tabs/12'); // removes state, subscribers, memo records & path registrations
```

- Matching is **segment-aware** by default. Pass `{ match: 'startsWith' }` for the legacy raw-prefix behavior.
- Purge **after** the components using that state have unmounted (e.g. from a `useEffect` + `setTimeout` at the app root). In development, YASM warns *at purge time* if subscribers are still attached — with the exact section and path.
- Purging is idempotent and never throws for unknown/already-purged paths or stale sections restored from persistence.
- Outside React (tests, event buses), use the pure function: `purgeYasmState(store, '/tabs/12')`.

---

## 🧪 Generic sections

Section *generators* make one definition reusable for many types:

```ts
const store = createStore({
    NumberArray: arrayValueSectionGenerator<number>(),     // { value: number[] }
    StringArray: arrayValueSectionGenerator<string>(),     // { value: string[] }
    Volume: valueSectionGenerator(50),                     // { value: number }
    Theme: valueSectionGenerator<'light' | 'dark'>('light')
});
```

Can one **single** section be generic at the use-site (`useYasmState<'Array', number>(...)`)? Not fully — TypeScript generics are erased at runtime and a concrete store object cannot store “a section of any `T`”. The idiomatic pattern is a single `unknown`-typed section plus a tiny **typed wrapper hook**:

```ts
// store: GenericValue: valueSectionGenerator<unknown>(undefined)
const useValueState = <T,>(path: string, initial: T) => {
    const [state, update] = useYasmState('GenericValue', path, {
        selector: s => s.value as T,
        overrideInitialState: { value: initial }
    });
    return [state, (value: T) => update({ value })] as const;
};

const [nums, setNums] = useValueState<number[]>('/report/nums', []);
```

You get full type inference at every call site with one section definition.

---

## 💡 Tips & notes

- 🏷️ Name paths after your UI hierarchy (`/tabs/{id}/...`) so a single purge call cleans a whole tab.
- 🧯 Don't purge paths that are still rendered — e.g. don't purge a dialog's path from a “refresh” action while the dialog is open.
- 🔁 Don't subscribe to state you only *write*. Use a constant selector (`() => null`) to get just the updater without re-rendering on changes.
- 💾 Persistence: serialize `store.state` + `store.pathRegistry` yourself (YASM keeps them plain-JSON friendly). When restoring, **filter out sections that no longer exist** in your section map and merge each path over the section's current `initialState` so newly added fields get defaults.
- 🐞 Debugging: `createStore(map, { debugOptions: { logStateUpdates: true } })` logs every update and purge with before/after snapshots (dev only — it's expensive, hence opt-in).
- 🚫 A payload that is a function is always treated as a payload *creator* — don't store bare functions as payloads.

---

## ⚖️ Comparison with other libraries

| | **YASM** | **Redux Toolkit** | **Zustand** | **Jotai** | **React Context** |
|---|---|---|---|---|---|
| Mental model | Sections × Paths | Single store + slices | Store hooks | Atoms | Tree-scoped values |
| Multi-instance state | ✅ first-class (paths) | 🔶 manual (keyed slices) | 🔶 store factories | 🔶 atom families | 🔶 nested providers |
| Freeing memory (purge) | ✅ one call per path prefix | 🔶 manual actions | 🔶 manual | ✅ auto GC-ish (unmount) | ✅ unmount |
| Re-render precision | ✅ per path + selector | ✅ selectors | ✅ selectors | ✅ per atom | ❌ all consumers |
| Immutability | ✅ immer built-in | ✅ immer built-in | 🔶 manual/middleware | ✅ | — |
| Boilerplate | Low | Medium | Low | Low | Low |
| Devtools | ❌ (logging only) | ✅ excellent | ✅ | ✅ | ❌ |
| Ecosystem/middleware | ❌ minimal | ✅ huge | ✅ rich | ✅ rich | — |
| Best for | Tabbed/multi-instance apps (ERP, editors) | Large teams, strict conventions | General apps | Fine-grained derived state | Rarely-changing config |

**When YASM shines** 🌟: many simultaneous instances of the same screens whose state must be created and destroyed dynamically (tabs, windows, dialogs, wizards) — the path model plus purge is exactly this use case.

**When to pick something else**: if you need devtools/time-travel, a middleware ecosystem, or heavy derived/computed state graphs.

---

## 📚 API reference (summary)

| Export | Kind | Description |
|---|---|---|
| `createStore(sectionMap, options?)` | function | Creates the store. `options.debugOptions`: `logStateUpdates`, `serializer`, `deserializer`. |
| `YasmContext` | context | Provide the store to your tree. |
| `useYasmState(name, path, selectorOrOptions?)` | hook | Returns `[state, updater]`. Options: `selector`, `overrideInitialState`. |
| `usePurgeYasmState()` | hook | Returns `purge(pathPrefix, options?)`. |
| `purgeYasmState(store, pathPrefix, options?)` | function | Pure purge — usable outside React. |
| `valueSectionGenerator<T>(initial)` | function | Generic `{ value: T }` section. |
| `arrayValueSectionGenerator<T>(initial?)` | function | Generic `{ value: T[] }` section. |
| `arraySectionGenerator(childName, childSection)` | function | Ordered map of child states with routing. |
| `objectSectionGenerator(map)` | function | Named composition of child sections with routing. |
| `mergeUpdaterGenerator<S>()` | function | `Partial<S>` shallow-merge updater. |
| `propertyUpdaterGenerator<S>()` | function | `{ key, value }` updater. |
| `getFieldSetter(updateState, field)` | function | Cached per-field setter factory. |
| `isPathWithinPrefix(path, prefix)` | function | Segment-aware prefix check. |

---

## 🧪 Tests

```bash
npm run test        # node:test via tsx
npm run typecheck   # tsc -p tsconfig.test.json
```

---

## 📄 License

MIT © MRNafisiA
