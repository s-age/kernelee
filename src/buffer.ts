// MARK: - BufferError

export type BufferErrorCode = 'duplicateStateId' | 'duplicateAllocate' | 'unallocated';

/**
 * The buffer's own failure vocabulary. All three codes mark a *wiring-time
 * programming error*, never a runtime input — the same policy as
 * `KernelError` (TS has no process-trapping precondition, so the same class
 * of programming error surfaces as an immediate throw where the stack names
 * the offender):
 *
 * - `'duplicateStateId'` — two `defineState` calls minted the same id. TS
 *   erases types at runtime, so uniqueness of the explicit token id is
 *   enforced at mint time instead of being derived from the state's type.
 * - `'duplicateAllocate'` — a second `allocate` for an already-allocated key.
 * - `'unallocated'` — `read`/`mutate`/`subscribe` on a key that was never
 *   allocated.
 */
export class BufferError extends Error {
  override readonly name = 'BufferError';
  readonly code: BufferErrorCode;
  /** The state key id the failure is about. */
  readonly stateId: string;

  constructor(code: BufferErrorCode, stateId: string, message: string) {
    super(message);
    this.code = code;
    this.stateId = stateId;
  }
}

// MARK: - StateKey

/**
 * The name of one buffer cell: a typed token that stands in for the state's
 * type as its key. TS erases types at runtime, so the key must be an
 * explicit value — `id` is the runtime identity, and the phantom pins `S` so
 * `read`/`mutate` on this key are typed end to end.
 *
 * `initial` travels with the key: the definition site — the module that
 * owns the state shape — is the one place that knows a correct empty value,
 * so the key carries it and every `allocate`/`allocateIfAbsent` of the same
 * key agrees on the seed.
 */
export interface StateKey<S> {
  readonly id: string;
  readonly initial: S;
  /**
   * Phantom brand — **never present at runtime**. The `(state: S) => S` shape
   * makes `S` *invariant* (it appears in both parameter and return position):
   * a cell is read *and* written at `S`, so neither widening nor narrowing
   * the state type is sound.
   */
  readonly __phantom?: (state: S) => S;
}

/** Every id ever minted by `defineState` — the uniqueness ledger. */
const mintedIds = new Set<string>();

/**
 * Mint a state key. One `defineState` per state shape, at module scope, in
 * the module that owns the shape.
 *
 * A duplicate id throws immediately (code `'duplicateStateId'`): two keys
 * sharing an id would silently alias one cell, and the mint site is where
 * the stack names the offender. The ledger is module-global, so this also
 * (deliberately) rejects re-minting the same id from two places.
 */
export function defineState<S>(id: string, initial: S): StateKey<S> {
  if (mintedIds.has(id)) {
    throw new BufferError(
      'duplicateStateId',
      id,
      `State id '${id}' is already defined — defineState ids must be unique`,
    );
  }
  mintedIds.add(id);
  return { id, initial };
}

// MARK: - Built-in state

/**
 * The value shape of {@link KernelErrorState}: one optional message. The
 * default error sink writes it as `"symbolId: message"`; an app that injects
 * its own `onError` at `build` may write here from that sink too (or ignore
 * the cell entirely). Clearing is the app's job, through its normal write
 * path: the displaying view dispatches an app-declared clear command, and
 * the layer that holds the kernel `mutate`s the cell back to
 * `{ message: null }` — a sink only ever writes here, it never clears. TS
 * spells the "explicitly empty" case `null` so a plain object literal can
 * express it.
 */
export interface KernelErrorValue {
  readonly message: string | null;
}

/**
 * Global error channel in the buffer, owned by the kernel — the state side of
 * `dispatch`'s error sink. A failure inside a fire-and-forget command has no
 * return path to `catch`; unless the app injects its own `onError` at
 * `build`, the default sink renders the failure here and the view layer
 * observes it like any other state. `BufferBuilder.build()` allocates the
 * cell unconditionally (errors are a release feature), so the default sink
 * can never hit a missing allocation. An app that wants a richer error shape
 * keeps the classic route — define its own state and inject `onError` at
 * `build`; this cell then just sits unused.
 */
export const KernelErrorState: StateKey<KernelErrorValue> = defineState<KernelErrorValue>(
  'KernelErrorState',
  { message: null },
);

// MARK: - Cell

/**
 * One *named container* in the buffer: the current value of a single state
 * key plus its change listeners, an explicit `Set` that `subscribe` fills
 * and `mutate` fires.
 */
interface Cell {
  value: unknown;
  readonly listeners: Set<() => void>;
}

// MARK: - Builder

/**
 * Collects the buffer's named containers during app wiring — the state-side
 * counterpart of `KernelBuilder`. The composition root `allocate`s a
 * container per state key; once wiring is done, `build()` freezes the set of
 * containers into a `Buffer`.
 *
 * The freeze is of the cell *set*, not the cells: `build()` snapshots which
 * keys exist, but the `Cell` containers themselves stay shared — between the
 * builder and every `Buffer` it builds, and therefore between two `Buffer`s
 * built from the same builder (values *and* listeners; a `mutate` through one
 * is observed through the other). This sharing is what lets a caller's
 * explicit pre-build `allocate` stay authoritative and live. One builder is
 * meant to build one kernel's buffer — it is not a state-sharing mechanism
 * between kernels.
 */
export class BufferBuilder {
  readonly #cells = new Map<string, Cell>();

  /**
   * Allocate a named container, seeded with the key's `initial`. A duplicate
   * allocate throws (code `'duplicateAllocate'`): which seed a cell starts
   * from is part of the wiring, and a silent last-write-win would hide a
   * double-wired state. (The seed rides on the key here, so a second
   * allocate can only be a mistake.)
   */
  allocate<S>(key: StateKey<S>): void {
    if (this.#cells.has(key.id)) {
      throw new BufferError(
        'duplicateAllocate',
        key.id,
        `Buffer cell '${key.id}' is already allocated — duplicate allocate`,
      );
    }
    this.#cells.set(key.id, { value: key.initial, listeners: new Set() });
  }

  /**
   * Allocate only if the key has no cell yet — the framework-default seeding
   * path used by `build()`, so an explicit caller `allocate` (e.g. a
   * pre-seeded state in a test) always stays authoritative.
   */
  allocateIfAbsent<S>(key: StateKey<S>): void {
    if (!this.#cells.has(key.id)) {
      this.#cells.set(key.id, { value: key.initial, listeners: new Set() });
    }
  }

  /**
   * Freeze the container *set* into a `Buffer`, after seeding the
   * framework-owned default: `KernelErrorState`, the target of the default
   * error sink — a release feature, so unconditional. Callers allocate only
   * their own app states. (`TraceState` is allocated by
   * `KernelBuilder.build`, and only when tracing is on.)
   *
   * A later `allocate` on the builder is invisible to an already-built
   * `Buffer`, but the shared cells mean value/listener traffic crosses freely
   * between builds.
   */
  build(): Buffer {
    this.allocateIfAbsent(KernelErrorState);
    return new Buffer(new Map(this.#cells));
  }
}

// MARK: - Buffer

/**
 * A key-addressed registry of observable cells — the "typed Redux" region.
 *
 * Mental model: each state key names one cell (single source of truth). The
 * layers that hold the kernel write new values (`mutate`); the view layer
 * only reads (`read`/`getSnapshot`) and observes (`subscribe`). `Buffer` is
 * the dumb mechanism — **any transition logic belongs in the caller's
 * pure-logic layer**, never in here: a cell stores whatever the updater
 * returns, and validating/deriving that value is not its job.
 *
 * JS is single-threaded, so `mutate` needs no actor hop — it is plain
 * synchronous, and the whole read-modify-write is one job, giving a "no
 * lost update between read and write" guarantee.
 */
export class Buffer {
  readonly #cells: ReadonlyMap<string, Cell>;

  /** @internal Construct via `BufferBuilder.build()`, never directly. */
  constructor(cells: ReadonlyMap<string, Cell>) {
    this.#cells = cells;
  }

  /** The single allocation check — every accessor funnels through here. */
  #cell(id: string): Cell {
    const cell = this.#cells.get(id);
    if (cell === undefined) {
      throw new BufferError(
        'unallocated',
        id,
        `Buffer cell '${id}' was not allocated — forgotten allocate?`,
      );
    }
    return cell;
  }

  /** Read the current snapshot of a cell. */
  read<S>(key: StateKey<S>): S {
    return this.#cell(key.id).value as S;
  }

  /**
   * `read` under the name React's `useSyncExternalStore` expects — pair it
   * with {@link subscribe}:
   *
   * ```ts
   * useSyncExternalStore(
   *   (onChange) => buffer.subscribe(GridState, onChange),
   *   () => buffer.getSnapshot(GridState),
   * )
   * ```
   *
   * The "new reference per change" contract that makes this work is supplied
   * by {@link mutate}'s copy-on-write discipline, not by extra machinery here.
   */
  getSnapshot<S>(key: StateKey<S>): S {
    return this.read(key);
  }

  /**
   * Atomically read-modify-write a cell: the updater receives the current
   * value and **returns the next one** (copy-on-write — the JS idiom, and
   * it is what keeps `getSnapshot` returning a fresh reference per change,
   * which React's change detection relies on). Do not mutate `current` in place
   * and return it — the value would change but its reference would not.
   *
   * Synchronous and single-threaded, so the whole read-modify-write is one
   * critical section: concurrent *additive / targeted* mutations (append,
   * replace-by-id) cannot lose each other. It does **not** make a
   * snapshot-then-apply-after-I/O sequence safe (a stale full-list reload
   * can still clobber a mutation that landed during the I/O window) — that
   * is a serialization concern, not an atomicity one.
   *
   * Listeners fire synchronously, once per `mutate`, after the value is
   * committed. A throwing listener is contained (reported via
   * `console.error`) so it cannot starve its siblings.
   */
  mutate<S>(key: StateKey<S>, update: (current: S) => S): void {
    const cell = this.#cell(key.id);
    cell.value = update(cell.value as S);
    // Snapshot the set: a listener that unsubscribes (or subscribes) mid-
    // notification must not perturb this round's iteration.
    for (const listener of [...cell.listeners]) {
      try {
        listener();
      } catch (error) {
        // Contain, don't propagate: one broken subscriber must not starve the
        // others, and mutate's caller is a writer with no stake in view-layer
        // failures.
        console.error(`[kernelee] buffer listener for '${key.id}' threw:`, error);
      }
    }
  }

  /**
   * Observe a cell: `listener` fires (with no arguments — pull the new value
   * via `read`/`getSnapshot`) after every `mutate` commit. Returns the
   * unsubscribe function, in exactly the shape `useSyncExternalStore`'s
   * `subscribe` parameter expects.
   */
  subscribe<S>(key: StateKey<S>, listener: () => void): () => void {
    const cell = this.#cell(key.id);
    cell.listeners.add(listener);
    return () => {
      cell.listeners.delete(listener);
    };
  }
}
