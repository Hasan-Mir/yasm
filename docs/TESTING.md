# YASM API audit and test strategy

This document is the API/state audit for the current package and the traceability
matrix for the Node test suite. The repository uses `node:test` through `tsx`
(`npm test`), with TypeScript checked by `npm run typecheck`; no Jest or Vitest
runtime is present in `package.json`.

## 1. Public API audit

The package entry point (`src/index.ts`) exposes the following runtime values:

| API                                               | Contract and options                                                                                                                                                                                      |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createStore(sectionMap, options?)`               | Creates a lazy, path-indexed store. `options` supports `debugOptions`, `pathBoundaryChars`, `onStateChange`, `persist`, `serializer`, and `deserializer`.                                                 |
| `DEFAULT_PATH_BOUNDARY_CHARS`                     | `['/', '[', '.']`; used by segment-aware routing and purge matching.                                                                                                                                      |
| `YasmContext`                                     | React context whose provider value is a store.                                                                                                                                                            |
| `useYasmState(name, path, selectorOrOptions?)`    | Returns `[stateOrSelection, updater]`. The third argument is either a selector or `{ selector?, overrideInitialState? }`. The override is an object or callback and applies only on first initialization. |
| `useYasmStateUpdater(name, path)`                 | Returns only the updater for `(name, path)` without subscribing the component — the store never notifies it, so it never re-renders.                                                                      |
| `usePurgeYasmState()`                             | Returns `(pathPrefix, options?) => void`.                                                                                                                                                                 |
| `purgeYasmState(store, pathPrefix, options?)`     | Removes matching state, subscribers, memo records, and routing registrations. `PurgeOptions.match` is `'segment'` (default) or `'startsWith'`.                                                            |
| `arraySectionGenerator(childName, childSection)`  | Creates `{ order, map }` state with `order`, `addingItems`, `editingItems`, and `removingIDs` updater operations and child routing via `[id]`.                                                            |
| `objectSectionGenerator(sectionMap)`              | Composes named child definitions; child routing uses `[childKey]`.                                                                                                                                        |
| `propertyUpdaterGenerator<S>()`                   | Returns an updater accepting `{ key, value }`; unchanged values preserve identity.                                                                                                                        |
| `mergeUpdaterGenerator<S>()`                      | Returns a shallow `Partial<S>` updater; unchanged payloads preserve identity.                                                                                                                             |
| `getFieldSetter(updateState, field)`              | Returns a cached field setter accepting a value or previous-value callback.                                                                                                                               |
| `isPathWithinPrefix(path, prefix, boundaryChars)` | Segment-aware prefix test; empty prefix matches every path.                                                                                                                                               |

The entry point also exports TypeScript contracts: `Name`, `Path`, `Updater`,
`PayloadAndPayloadCreator`, `Section`, `Store`, `StoreOptions`, `DebugOptions`,
`PersistConfig`, `StateMigration`, `PersistedSnapshot`,
`YasmPersistenceAdapter`, `ArraySection`, `ObjectSection`,
`ObjectSectionState`, `SectionWithName`, and `UpdatingKeyAndValue`.

### Store surface and persistence options

The public `Store` contains `state`, `subscribers`, `sectionMap`, `pathRegistry`,
`routingPlan`, `memo`, `pathBoundaryChars`, `serializer`, `deserializer`,
`debugOptions`, `subscribe`, `hydrate`, and `save`. The symbol-keyed notification
method is an internal integration point, exported from `src/createStore.ts` but
not re-exported by the package entry point.

`YasmPersistenceAdapter` requires `getItem`, `setItem`, and `removeItem`, each
sync or async, and permits async/sync `clear`. `PersistConfig` additionally
supports `key`, `storage`, static/function `omitSections`, boolean/function
`autoSave`, numeric/function `persistDebounceMS`, `onBeforeSave`, per-section
`migrations`, `onBeforeHydrate`, `onHydrated`, `normalization`, and
`customPersistCallback`. Normalization is `false`, `true`, or an object with
`pruneStaleFields`, `transientPatterns`, `transientExact`, and `isTransient`.

### Internal state and mutation audit

`createStore` owns the following closure state:

- `counter`: monotonically allocates subscription IDs.
- `debounceTimer`: replaced/cleared when autosave notifications debounce.
- `saveQueue`: promise chain; each save appends one isolated persistence task
  capturing a call-time shallow copy of the state and registry.
- `hydrationPromise`: single-flight promise reused by concurrent hydration calls.
- `isHydrated`: blocks pre-hydration saves and autosave scheduling, then stays true.
- `executedMigrations`: in-memory migration IDs restored from and written to
  metadata; on an empty storage read, every configured migration is marked
  immediately because natively created state matches the current schema.

The returned mutable structures are intentionally stateful:

- `state[name][path]` is created by `init`, replaced by Immer updates, merged by
  hydration, and deleted by purge.
- `subscribers[name][path][id]` is added by `subscribe`, deleted by unsubscribe,
  and the path record is deleted by purge.
- `memo[name][path]` is created once by `init` and deleted by purge.
- `pathRegistry[name]` is populated when a routing parent is initialized,
  deduplicated/merged by hydration, and filtered by purge.
- `routingPlan` is derived once from section routing declarations and is not
  mutated during normal operation.

Updates resolve payload creators at dispatch time, use Immer for immutable
replacement, notify `onStateChange`/persistence, and then invoke subscribers.
Purge notifies only when actual state or registry data was removed. Hydration
filters obsolete sections and paths, runs migrations before `onBeforeHydrate`,
normalizes before merging, and writes a repaired snapshot when necessary. When
any part of hydration fails, the corrupted raw data is quarantined: it is
backed up under `<key>_corrupted_backup_<timestamp>` and the primary key is
overwritten with a clean fresh snapshot. Hook and queue failures
(`onStateChange`, `onHydrated`, `onBeforeSave`, storage adapters) are caught,
logged, and never reject `hydrate()`/`save()`.

## 2. Scenario mapping

### Unit scenarios

- Path equality, empty prefixes, custom boundary characters, and false segment
  prefixes.
- Merge/property updater identity and immutability.
- Field-setter value/callback forms and cache isolation.
- Array/object path parsing, malformed paths, missing children, and no-op child
  updates.
- Deep freeze of nested, circular, symbol-keyed objects without invoking getters.
- Snapshot serializer/deserializer and undefined round-trip behavior.

### Integration and cross-feature scenarios

- Array parent add/edit/remove/order followed by routed child read/update and
  parent subscription notification.
- The write-only updater hook lazily initializes its path, shares the
  memoized record with regular consumers, dispatches standalone, and creates
  no subscriber entries.
- Multi-level composition routes through nested parents (array → object);
  a child used before its parent falls back to direct storage; hydration
  restores routing through the persisted registry so children work before
  the parent component mounts. Custom routers with their own path syntax
  (dot-notation dictionaries) are covered end-to-end, including no-op
  bailouts; remove+edit of the same id skips the edit; two ArraySection
  instances at different paths stay isolated.
- React hooks: the `useYasmState` options-object overload
  (`selector` + `overrideInitialState`) and the context-bound
  `usePurgeYasmState` execute through `renderToString`; all subscribers of
  a path are notified; the memoized updater keeps its identity.
- Persistence lifecycle phases execute in the documented order
  (getItem → deserialize → migrations → onBeforeHydrate → repair-save →
  onHydrated); purged state does not resurrect after save + rehydration;
  BigInt/Date values round-trip through custom serializers; fields missing
  from the stored snapshot are filled from `initialState`; the
  `logStateUpdates` filter callback narrows logging to matching events;
  `store.save()` without persistence config is a safe no-op; an empty
  section map is accepted.
- Object composition child update through a parent, including nested path errors.
- Purging a parent path removes its routed registry and makes stale child
  updaters safe no-ops.
- Hydration restores routing, normalizes nested array rows, applies transient
  rules, persists the repaired snapshot, and heals corrupted ArraySection
  `order` data (duplicates, stringified ids, non-numeric garbage) plus
  empty-string map keys.
- Dynamic omission is evaluated against the state captured at `save()` call
  time; custom callbacks run after built-in storage.
- State updates and successful purge both invoke the external change callback.

### Option/default/invalid-combination scenarios

- Default and function/array `pathBoundaryChars`.
- Debug disabled, local/full update snapshots, and none/full purge snapshots;
  production mode suppresses diagnostics.
- Persistence absent, partial (`customPersistCallback` only), and complete
  (`key` + `storage`) configurations.
- Static/function omission; boolean/function autosave; default, numeric, and
  function debounce delays; browser idle callback and timer fallback.
- Normalization enabled/default, disabled, `pruneStaleFields: false`, all three
  transient mechanisms, migrations, and lifecycle hooks.
- Duplicate migration ids within a section throw at store creation; the same
  id reused in different sections is allowed.
- Invalid persisted JSON, primitive/null snapshots, missing state/registry,
  storage/hook failures, unknown routing sections, malformed route paths, and
  missing routed elements.

### Boundaries, load, and concurrency

- Empty stores/arrays, zero IDs, duplicate registrations, removed IDs, stale
  sections, stale registry entries, and repeated purge/hydrate calls.
- Large path sets and nested composition without sibling-prefix hijacking.
- Concurrent hydrate calls are single-flight; concurrent saves are serialized;
  save during hydration waits; updates after purge do not throw.
- `save()` serializes the call-time snapshot even while the queue is backed
  up by slow storage writes.
- A failing migration or a corrupt snapshot during hydration triggers the
  quarantine flow: a `<key>_corrupted_backup_<timestamp>` entry is created,
  the primary key is overwritten with fresh state, and the app boots normally.
- Throwing `onStateChange`/`onHydrated`/`onBeforeSave` hooks are logged and
  isolated; `hydrate()`/`save()` still resolve.
- Fresh installs mark migrations executed without running them; registry
  entries without matching state are pruned and persisted by the repair save.
- Autosave debounce coalesces updates and does not schedule before hydration;
  purge also schedules a debounced autosave, and the browser idle-callback
  branch is exercised through a polyfilled `window.requestIdleCallback`.

## 3. Running and interpreting the suite

```bash
npm test
npm run typecheck
```

The suite uses deterministic adapters and timer delays rather than network or
browser storage. Console-error tests capture expected diagnostics and restore
the console in `finally`, so failures cannot leak mocks into later tests.
