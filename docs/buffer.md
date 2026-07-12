# Buffer

A registry of observable state (the "typed Redux" territory). Each state key
names one cell (single source of truth); the layer holding the kernel writes
via `mutate`, and the view layer only `read`s / `subscribe`s. **Transition
logic does not live in the Buffer** (it belongs to the pure logic layer).

```ts
import { defineState, BufferBuilder, KernelBuilder, KernelErrorState } from '@s-age/kernelee';

// A type can't be a runtime key (no ObjectIdentifier equivalent) → explicit token.
// Ids are module-global unique (a duplicate throws at defineState). The initial value rides on the key.
const GridState = defineState<Grid>('GridState', initialGrid); // StateKey<Grid>

const bufferBuilder = new BufferBuilder();
bufferBuilder.allocate(GridState);          // allocates the cell from key.initial (duplicate allocate throws)
const kernel = new KernelBuilder().build({ buffer: bufferBuilder });
// build() calls BufferBuilder.build(), which always seeds KernelErrorState
// (allocateIfAbsent — never overwrites an explicit allocate). Omitted, an empty
// builder is used, so kernel.buffer always exists.

kernel.buffer.mutate(GridState, (g) => ({ ...g, rows: [...g.rows, row] })); // ★ copy-on-write
kernel.buffer.read(GridState);              // current snapshot
// read/mutate/subscribe on an unallocated key throws (Swift's precondition equivalent)

// React: passes straight into useSyncExternalStore
useSyncExternalStore(
  (onChange) => kernel.buffer.subscribe(GridState, onChange), // returns an unsubscribe function
  () => kernel.buffer.getSnapshot(GridState),                 // reference changes on every mutate
);
```

- **`mutate` is copy-on-write**: the updater **returns** a new value (unlike
  Swift's `inout`). Don't mutate `current` in place and return it — the value
  changes but the reference doesn't, killing React's change detection. The
  reference-change guarantee is supplied by `mutate`'s contract;
  `getSnapshot` is an alias of `read`.
- **`mutate` is synchronous** (single-threaded, so Swift's main-actor hop is
  unnecessary). The whole read-modify-write is one critical section. Listener
  notification also fires synchronously inside `mutate` (1 mutate = 1 call
  per listener). A throw inside a listener is contained (`console.error`)
  and does not take sibling listeners down.
- **The default sink for dispatch failures is `KernelErrorState`**: with no
  `onError` injected, failures land in `kernel.buffer`'s `KernelErrorState`
  cell as `"symbolId: message"` (following Swift's `defaultErrorSink`). An
  explicitly injected `onError` wins and `KernelErrorState` is never touched.
