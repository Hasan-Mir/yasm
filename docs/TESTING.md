# YASM API audit and test strategy

This document is the API/state audit for the current package and the traceability
matrix for the Node test suite. The repository uses two complementary runners:

- **Core engine** (`tests/*.test.ts`): `node:test` through `tsx` (`npm test`) —
  store, purge, persist, composition and util logic, no DOM required.
- **React layer** (`tests/react/*.test.tsx`): Vitest + jsdom +
  Testing Library (`npm run test:react`) — real mount/unmount so hook
  reactivity (re-renders, subscription lifecycles, StrictMode, purges under
  live components) is observed end to end.

TypeScript is checked across both by `npm run checktype`.

## 1. Public API audit

The package entry point (`src/index.ts`) exposes the following runtime values:

| API | Contract and options |
| :--- | :--- |
| `createStore(sectionMap, options?)` | Creates a lazy, path-indexed store. `options` supports `debugOptions`, `pathBoundaryChars`, `onStateChange`, `persist`, `serializer`, and `deserializer`. |
| `DEFAULT_PATH_BOUNDARY_CHARS` | `['/', '[', '.']`; used by segment-aware routing and purge matching. |
| `YasmContext` | React context whose provider value is a store. |
| `useYasmState(name, path, selectorOrOptions?)` | Returns `[stateOrSelection, updater]`. The third argument is either a selector or `{ selector?, overrideInitialState? }`. The override is an object or callback and applies only on first initialization. |
| `useYasmStateUpdater(name, path)` | Returns only the updater for `(name, path)` without subscribing the component — the store never notifies it, so it never re-renders. |
| `useHydration(store?)` | Returns the store's `HydrationResult` (`status`, `isHydrated`, optional `error`) and re-renders on status transitions via `useSyncExternalStore`; reads the store from context unless one is passed. |
| `usePurgeYasmState()` | Returns `(pathPrefix, options?) => void`. |
| `usePurgeWhenUnused()` | Returns `(pathPrefix, options?) => void` bound to `store.purgeWhenUnused` — the lifecycle-safe purge that fires once the last matching subscriber unsubscribes (or immediately when unused), re-verifies live subscribers at fire time, and persists pending entries in snapshot metadata. |
| `purgeYasmState(store, pathPrefix, options?)` | Removes matching state, subscribers, memo records, and routing registrations. `PurgeOptions.match` is `'segment'` (default) or `'startsWith'`. |
| `store.subscribe(cb, name, path)` | Low-level subscription backing `useSyncExternalStore` (unchanged). |
| `store.subscribe(name, path, selector, listener, options?)` | Selector-aware subscription: fires `listener(selected, prevSelected)` only when the selection changed (`equality`: `'shallow'` default / `'strict'` / custom; `fireImmediately`: optional). Evaluates lazily-uninitialized/purged paths against `initialState`; isolates listener exceptions. |
| `store.subscribeMany(targets, listener, options?)` | Multi-path subscription: watches several `(name, path)` addresses with one listener and one idempotent unsubscribe. Changes are discriminated by `name` (no casts) and, by default (`batch: 'microtask'`), coalesced per flush into one call with at most one entry per address; `batch: 'sync'` delivers single-entry batches inline. `fireImmediately` reports every target once with `previous: undefined`. Lazily initializes direct addresses, reads unresolvable/purged addresses as `initialState`, dedupes duplicate targets, and isolates listener exceptions. |
| `store.captureRollback(name, path)` | Snapshots one path (through routing) and returns a `rollback()` restoring it; idempotent, purge-safe, reference-equality no-op when unchanged. |
| `store.captureRollback(pathPrefix)` | Snapshots every state entry matching the segment-aware prefix and returns a `rollback()` restoring all of them; purged paths are skipped. |
| `store.getHydrationStatus()` | Current hydration status: `'idle' \| 'hydrating' \| 'hydrated' \| 'failed' \| 'quarantined'`. |
| `store.getHydrationSnapshot()` | Stable memoized `HydrationResult` (same object until the status transitions). |
| `store.subscribeHydration(cb)` | Subscribes to hydration status transitions; returns the unsubscribe function. |
| `arraySectionGenerator(childName, childSection)` | Creates `{ order, map }` state with `order`, `addingItems`, `editingItems`, and `removingIDs` updater operations and child routing via `[id]`. |
| `objectSectionGenerator(sectionMap)` | Composes named child definitions; child routing uses `[childKey]`. |
| `propertyUpdaterGenerator<S>()` | Returns an updater accepting `{ key, value }`; unchanged values preserve identity. |
| `mergeUpdaterGenerator<S>()` | Returns a shallow `Partial<S>` updater; unchanged payloads preserve identity. |
| `getFieldSetter(updateState, field)` | Returns a cached field setter accepting a value or previous-value callback. |
| `isPathWithinPrefix(path, prefix, boundaryChars)` | Segment-aware prefix test; empty prefix matches every path. |
| `snapshotByPrefix(store, pathPrefix?, options?)` | Scoped debug/introspection snapshot of the state entries matching `pathPrefix` (segment-aware by default). Options: `mode` (`'flat'` \| `'tree'`), `match` (`'segment'` \| `'exact'` \| `'startsWith'`), `serialize`, `sectionFilter`, `includeSubscribers`. Omitting the prefix snapshots the ENTIRE store. Never logs by itself. Also available pre-bound as `store.snapshotByPrefix(...)`. |
| `snapshot(value, storeOptions)` | `console.debug`s `value` round-tripped through the store's serializer/deserializer, preserving `undefined` values through a placeholder. Never throws: a failing serializer degrades to the raw live value. |
| `createMemoryStorage()` | In-memory `YasmPersistenceAdapter` for tests, stories and SSR; exposes the backing `Map` as `data` for assertions. |

The entry point also exports TypeScript contracts: `Name`, `Path`, `Updater`,
`PayloadAndPayloadCreator`, `Section`, `Store`, `StoreOptions`, `DebugOptions`,
`SnapshotFilter`, `PersistConfig`, `StateMigration`, `PersistedSnapshot`,
`YasmPersistenceAdapter`, `HydrationStatus`, `HydrationResult`, `QuarantineInfo`,
`SelectorEquality`, `SubscribeSelectorOptions`, `ArraySection`, `ObjectSection`,
`ObjectSectionState`, `SectionWithName`, `UpdatingKeyAndValue`, `MemoryStorage`,
`SnapshotByPrefixOptions`, `SnapshotMode`, `SubscribeManyTarget`,
`SubscribeManyChange`, and `SubscribeManyOptions`.

### Store Surface and Persistence Options

The public `Store` contains `state`, `subscribers`, `sectionMap`, `pathRegistry`,
`routingPlan`, `memo`, `pathBoundaryChars`, `serializer`, `deserializer`,
`debugOptions`, `subscribe`, `captureRollback`, `hydrate`, `save`, `isHydrated`,
`getHydrationStatus`, `getHydrationSnapshot`, `subscribeHydration`,
`snapshotByPrefix`, `subscribeMany`, and `purgeWhenUnused`.
The symbol-keyed notification methods are internal integration points, exported from
`src/createStore.ts` but not re-exported by the package entry point.

`YasmPersistenceAdapter` requires `getItem`, `setItem`, and `removeItem`, each
sync or async, and permits async/sync `clear`. `PersistConfig` additionally
supports `key`, `storage`, static/function `omitSections`, boolean/function
`autoSave`, numeric/function `persistDebounceMS`, `onBeforeSave`, per-section
`migrations`, `onBeforeHydrate`, `onHydrated`, `onQuarantine`, `normalization`, and
`customPersistCallback`. Normalization is `false`, `true`, or an object with
`pruneStaleFields`, `transientPatterns`, `transientExact`, and `isTransient`.

### Internal State and Mutation Audit

`createStore` owns the following closure state:

- `counter`: monotonically allocates subscription IDs.
- `debounceTimer`: replaced/cleared when autosave notifications debounce.
- `saveQueue`: promise chain; each save appends one isolated persistence task
  capturing a call-time shallow copy of the state and registry.
- `hydrationPromise`: single-flight promise reused by concurrent hydration calls.
- `hydrationSettled`: "settled" gate for `store.isHydrated()` and the dev-only
  early-init warning — blocks pre-hydration saves and autosave scheduling,
  then stays `true` (unlike snapshot `isHydrated`, which is `false` on
  `'failed'`).
- `hydrationSuccess`: unlocked at the end of every hydrate run (including
  quarantined boots) so users can save again afterwards.
- `hydrationStatus`: observable hydration state (`'idle'`, `'hydrating'`, `'hydrated'`,
  `'quarantined'`, `'failed'`).
- `hydrationError`: holds the error associated with `'quarantined'` or `'failed'` transitions.
- `hydrationSnapshot`: memoized reference-stable `HydrationResult` object for `useSyncExternalStore`.
- `hydrationSubscribers`: set of listener callbacks invoked when hydration transitions occur.
- `executedMigrations`: in-memory migration IDs restored from and written to
  metadata; on an empty storage read, every configured migration is marked
  immediately because natively created state matches the current schema.
- `pendingPurges`: deferred `purgeWhenUnused` schedules. Keys are removed when their
  last subscriber unsubscribes or when raw purge force-removes the record; an emptied
  entry re-verifies live subscribers at fire time before destroying. Re-scheduled
  entries replace previous ones for the same prefix/match. Pending entries are
  persisted in snapshot metadata and drained during hydration.

Updates resolve payload creators at dispatch time, use Immer for immutable
replacement, notify `onStateChange`/persistence, and then invoke subscribers.
Purge notifies only when actual state or registry data was removed. Hydration
filters obsolete sections and paths — a persisted routing registration survives
when the section owns state at that path OR the path is itself routed into
another surviving registration, so nested composed parents (`Row` at
`/table[5]` inside `Table` at `/table`, which own no state of their own) are
kept instead of pruned; pruning runs to a fixpoint, so a stale parent still
invalidates everything registered underneath it — runs migrations before
`onBeforeHydrate`, normalizes before merging, writes a repaired snapshot when
necessary, and
notifies all live subscribers once after merging so components that mounted
before hydration completed re-read their replaced state instead of showing
lazy defaults forever. When
any part of hydration fails, the corrupted raw data is quarantined: it is
backed up under `<key>_corrupted_backup_<timestamp>` and the primary key is
overwritten with a clean fresh snapshot. The quarantine flow also publishes the
observable `'quarantined'` hydration status, invokes `persist.onQuarantine`
(after the backup attempt, with the backup key or `null`, the raw payload and
the error — sync or async, isolated so a throwing callback never blocks the
reset), and lands on `'failed'` when even the repair-save cannot write storage.
Hook and queue failures
(`onStateChange`, `onHydrated`, `onBeforeSave`, storage adapters) are caught,
logged, and never reject `hydrate()`/`save()`.

---

## 2. Scenario mapping

### Unit scenarios

- Path equality, empty prefixes, custom boundary characters, and false segment prefixes.
- Merge/property updater identity and immutability.
- Field-setter value/callback forms and cache isolation.
- Array/object path parsing, malformed paths, missing children, and no-op child updates.
- Deep freeze of nested, circular, symbol-keyed objects without invoking getters.
- Snapshot serializer/deserializer and undefined round-trip behavior.
- Selector equality comparison: structural equality under `'shallow'`, reference equality under `'strict'`, and custom comparators.
- Date equality under `'shallow'`: distinct timestamp instances trigger re-fire; identical timestamps bail out.

### Integration and cross-feature scenarios

- Array parent add/edit/remove/order followed by routed child read/update and parent subscription notification.
- The write-only updater hook lazily initializes its path, shares the memoized record with regular consumers, dispatches standalone, and creates no subscriber entries.
- Multi-level composition routes through nested parents (array → object); a child used before its parent falls back to direct storage; hydration restores routing through the persisted registry so children work before the parent component mounts.
- Custom routers with their own path syntax (dot-notation dictionaries) are covered end-to-end, including no-op bailouts; remove+edit of the same id skips the edit; two ArraySection instances at different paths stay isolated.
- Selector-aware subscriptions: transforms state and tracks `prevSelected`; default `'shallow'` equality bails out on structurally-identical selections; `'strict'` (`Object.is`) re-fires on new identity; custom comparator (prev, next) decides equality; `fireImmediately` reports `(current, undefined)`; lazy paths and post-purge re-subscriptions resolve from `initialState` (never raw `undefined`); routed children observe parent updates through the physical path; throwing listeners are isolated from other subscribers; low-level `(callback, name, path)` overload remains intact.
- Multi-path subscriptions (`subscribeMany`): several addresses share one listener and one idempotent unsubscribe; microtask batching coalesces a flush into one call with at most one entry per address and drops changes reverted within that flush; `batch: 'sync'` delivers inline single-entry batches; `fireImmediately` reports every target with `previous: undefined`; duplicate targets are wired once; unresolvable/purged addresses read as `initialState`; a throwing listener is isolated and never reaches the hydration error boundary; watched paths defer a matching `purgeWhenUnused` until unsubscribed.
- Optimistic rollback: single-path restore with identity-preserving no-op and idempotency; routed child restore through `ArraySection` parent via direct slice replacement (safe for command/action updaters); purge-safe ignoring of removed rows/paths (no resurrection); path-prefix restore across multiple sections and under global `''`/`'/'` prefix; capture immutability (capturing never mutates or notifies).
- Observable hydration: initial status reflects persistence configuration (`'hydrated'` without it, `'idle'` with it); `hydrate()` transitions `'idle' → 'hydrating' → 'hydrated'` (including while a slow storage read is in flight); snapshot object is stable between transitions; `'quarantined'` carries the error and reports `isHydrated: true`; an unrecoverable repair-save failure lands on `'failed'` and rejects the hydrate promise; `subscribeHydration` unsubscribes cleanly.
- `onQuarantine` lifecycle: invoked with `{ key, backupKey, rawData, error }` for corrupt JSON and throwing migrations; awaited when async; reports `backupKey: null` when backup write fails; skipped on healthy hydration; throwing callback is isolated so hydration resolves, the primary key is reset, and the session stays usable.
- React hooks: `useYasmState` options-object overload (`selector` + `overrideInitialState`) and context-bound `usePurgeYasmState` execute through `renderToString`; all subscribers of a path are notified; memoized updater keeps its identity.
- UI-level (jsdom) coverage: StrictMode double-mounting leaves exactly one live subscription and double-effect `purgeWhenUnused` scheduling never fires early; a reader mounted BEFORE hydration completes is notified once hydration lands; tab switching restores state from global store across full unmount/remount cycles; SSR output matches client-rendered DOM for the same store state.
- Persistence lifecycle phases execute in the documented order (getItem → deserialize → migrations → onBeforeHydrate → repair-save → onHydrated); purged state does not resurrect after save + rehydration; BigInt/Date values round-trip through custom serializers; fields missing from stored snapshot are filled from `initialState`.
- Object composition child update through a parent, including nested path errors.
- Purging a parent path removes its routed registry and makes stale child updaters safe no-ops.
- Hydration restores routing, normalizes nested array rows, applies transient rules, persists the repaired snapshot, and heals corrupted ArraySection `order` data (duplicates, stringified ids, non-numeric garbage) plus empty-string map keys.
- Dynamic omission is evaluated against the state captured at `save()` call time; custom callbacks run after built-in storage.
- State updates and successful purge both invoke the external change callback.
- `purgeWhenUnused` executes immediately with no subscribers, defers until the last matching subscriber unsubscribes, re-verifies live subscribers at fire time (revived paths with mounted readers are never wiped), and uses segment-aware matching. The destructive pass runs on the NEXT task after that last unsubscription and re-verifies again right before executing — bridging React's synchronous detach/reattach flushes (StrictMode double effects, concurrent transitions) where subscriptions transiently drop to zero; if subscribers returned in the meantime the entry re-arms itself. Bookkeeping (the pending marker) is still settled synchronously. Pending entries are persisted in `metadata.pendingPurges`, and the next hydration drains them immediately (nothing mounted) with the repair-save clearing the markers; immediate purges leave no markers. Re-scheduling the same prefix replaces the previous snapshot; `{ match: 'startsWith' }` is honored end-to-end; fire-time detection is subscription-based, so a path recreated purely via write-only hooks between scheduling and firing is wiped with the prefix (documented caveat); a raw purge over a pending entry reconciles its bookkeeping through the forced-unsubscribe notification instead of leaking the marker into future snapshots.

### Option/default/invalid-combination scenarios

- Default and function/array `pathBoundaryChars`.
- Debug disabled, local/full update snapshots, and none/full purge snapshots; production mode suppresses diagnostics.
- Persistence absent, partial (`customPersistCallback` only), and complete (`key` + `storage`) configurations.
- Static/function omission; boolean/function autosave; default, numeric, and function debounce delays; browser idle callback and timer fallback.
- Normalization enabled/default, disabled, `pruneStaleFields: false`, all three transient mechanisms, migrations, and lifecycle hooks.
- Duplicate migration ids within a section throw at store creation; same id reused in different sections is allowed.
- Invalid persisted JSON, primitive/null snapshots, missing state/registry, storage/hook failures, unknown routing sections, malformed route paths, and missing routed elements.

### Boundaries, load, and concurrency

- Empty stores/arrays, zero IDs, duplicate registrations, removed IDs, stale sections, stale registry entries, and repeated purge/hydrate calls.
- Large path sets and nested composition without sibling-prefix hijacking.
- Concurrent hydrate calls are single-flight; concurrent saves are serialized; save during hydration waits; updates after purge do not throw.
- `save()` serializes the call-time snapshot even while the queue is backed up by slow storage writes.
- A failing migration or a corrupt snapshot during hydration triggers quarantine flow: `<key>_corrupted_backup_<timestamp>` entry is created, primary key is overwritten with clean state, and app boots normally.
- Throwing `onStateChange`/`onHydrated`/`onBeforeSave`/`onQuarantine` hooks are logged and isolated; `hydrate()`/`save()` resolve.
- Fresh installs mark migrations executed without running them; registry entries without matching state are pruned and persisted by repair-save.
- Autosave debounce coalesces updates and does not schedule before hydration; purge also schedules debounced autosave, and the browser idle-callback branch is exercised through a polyfilled `window.requestIdleCallback`.

---

## 3. Running and interpreting the suite

```bash
npm test            # Run node:test unit suites
npm run test:react  # Run vitest React integration suite
npm run checktype   # Check static types
```

The suite uses deterministic adapters and timer delays rather than network or
browser storage. Console-error tests capture expected diagnostics and restore
the console in `finally`, so failures cannot leak mocks into later tests.