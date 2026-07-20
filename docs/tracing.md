# Span propagation

`Kernel.invoke` (kernel.ts) is the single chokepoint, and tracing hooks into
it. Implicit ambient tracking of "which call tree am I in" (via a task-local)
is not viable in JS: there is no runtime-independent ambient execution
context — `AsyncLocalStorage` is Node-only, and in the browser the tracking
would silently drop, which is why that approach is a non-starter.

**Adopted: parent/child linking via explicit arguments, confined to
framework-internal calls.** `Span { id, parentId? }` (`src/span.ts`) is
threaded as an explicit argument through `Kernel.invoke`, `Kernel.runStages`
(the shared stage loop under `compose`/`run`, which `fork` also calls
directly) and `fork`'s branch execution. The public signatures of `call` /
`dispatch` / `compose` / `run` are unchanged — on the kernel `build()`
returns they are flow roots (`parentId: undefined`), and on a span-scoped
view (below) they inherit that instance's ambient span as the parent.

- **Linked**: within one `compose`/`run` call, the `divert` loop and each
  `fork` branch forward the `parentSpan` given to that call (`runStages`
  keeps `parentSpan` constant for the whole loop — a divert is a loop
  continuation, not a nested call).
- **Linked (span linking)**: a composing handler (`(kernel, payload) => …`)
  calling back via `kernel.call(other, x)`. The channel is the first
  argument itself: `Kernel.invoke` hands each handler a *span-scoped view*
  of the kernel whose ambient span is the freshly minted span (handler
  table, CommandBus, buffer and sinks all shared; only the ambient span
  differs), and the four public methods (`call`/`dispatch`/`compose`/`run`)
  parent under their own instance's ambient span. Handler signatures are
  untouched. The ambient span rides on the kernel value itself rather than
  on a task-local, so Node and browser behave identically.
  - The one remaining edge: a handler that ignores its `kernel` argument and
    calls back through a kernel reference **captured from outside** bypasses
    the scoped view and mints roots — call through the argument.
  - `dispatch` links too: the bus carries closures that capture the scoped
    kernel, so a dispatched call parents under the span of the handler that
    dispatched it — the link comes for free from how the bus is built.
- Sequential stages within one `compose` do *not* parent each other — every
  stage shares the `parentSpan` the compose call itself received (always
  `undefined` for a top-level call) rather than inheriting the previous
  stage's span. This is deliberate, not a compromise: the ambient span is
  scoped only to the running handler's body and has already reverted by the
  time the next stage's `invoke` fires, so no stage inherits a sibling's
  span.

## onTrace / TraceState

Every `Kernel.invoke` pass can be recorded into `kernel.buffer`'s
`TraceState` cell, with one deliberate design choice driven by TS having no
DEBUG/release split (the same bundle always runs).

**The sink signature carries no `id`.** The monotonic `id` is assigned only
inside `appendTraceEntry` — the raw sink is thin, and "format into a
`TraceEntry` and append to `TraceState`" is the default sink's job alone,
the same relationship as `onError` / `KernelErrorState`:

```ts
// src/trace.ts — the data-model module (same granularity as span.ts)
export type TraceVerbKind = Verb<unknown>['kind']; // reuses 'next'|'abort'|'divert'|'fail' —
                                                     // Verb.kind is already the discriminant,
                                                     // no separate enum needed.
export type TraceSink = (
  symbolId: string,
  verb: TraceVerbKind,
  span: Span,             // carries {id, parentId?} whole — one argument instead of separate span/parent
  payload: string | undefined,
  timestamp: number,
) => void;

export interface TraceEntry {
  readonly id: number;    // assigned only by the default sink that writes into TraceState
  readonly symbolId: string;
  readonly verb: TraceVerbKind;
  readonly span: Span;
  readonly payload?: string;
  readonly timestamp: number;
}

export interface TraceStateValue { readonly entries: readonly TraceEntry[]; }
export const TraceState: StateKey<TraceStateValue> = defineState('TraceState', { entries: [] });

// Batch-trim policy: trim once the ring overshoots cap by 25%: removeFirst is
// O(cap), so the overshoot is dropped in one batch instead of paying per
// append. The entry carries no id — it is assigned here (the raw sink has
// none, as above).
export function appendTraceEntry(
  state: TraceStateValue,
  entry: Omit<TraceEntry, 'id'>,
  cap: number,
): TraceStateValue;
```

`TraceState` is not a built-in state that `BufferBuilder.build()` seeds
unconditionally the way `KernelErrorState` is — `KernelBuilder.build()`
looks at `options.tracing` and conditionally
`allocateIfAbsent(TraceState)`s before freezing the buffer. Left off,
`kernel.buffer.read(TraceState)` throws `BufferError('unallocated')` like
any other unallocated cell.

**There is exactly one toggle.** TS has no DEBUG/release build split (the
same bundle always runs), so **one flag gates the whole recording** — off,
neither payload rendering nor the `Buffer.mutate` into `TraceState` ever
runs, and the only remaining cost is span minting (`crypto.randomUUID()`,
which is paid unconditionally). It is not a two-tier toggle (recording vs
payload rendering) because no concrete use case demands that granularity;
it can be added when one does.

```ts
export interface KernelBuildOptions {
  onError?: (symbolId: string, error: unknown) => void;
  buffer?: BufferBuilder;
  /** Master switch for trace recording. Default false — off, nothing beyond span minting is paid. */
  tracing?: boolean;
  /** Injecting one replaces the default write into TraceState (same behavior as onError). */
  onTrace?: TraceSink;
  /** The default sink's ring size. Default 300. */
  traceCap?: number;
}
```

Payload rendering: `describeTracePayload` uses `JSON.stringify`
(with a replacer that summarizes binary buffer views as e.g.
`"Uint8Array(3072)"` — see [trace-payload-rendering-cost](./trace-payload-rendering-cost.md)),
falls back to `String(payload)` for non-serializable values (cycles,
functions), and caps at 1024 characters with an ellipsis. With `tracing`
off, `Kernel.invoke` skips both this rendering and the `onTrace` call
entirely.

**A handler that throws instead of `fail`ing is still recorded.** A handler
bound with `register` (value-returning) has no way to return a `fail(...)`
verb directly, so its failures are always throws — `invoke` wraps the
handler call in try/catch and, on catching, still notifies `onTrace` once
with `verb: 'fail'` before re-throwing the same error (the exception
behavior seen from `call`/`dispatch` is unchanged). Without this, every
failure from a `register`-bound handler would vanish from the trace,
defeating the point of showing what failed.

**Observation never changes program behavior.** `onTrace` is a passive
observer, not a participant in the flow it's watching, and `invoke`
guarantees that in both directions:

- If the sink itself throws, `invoke` contains the error and reports it via
  `console.error` — the same non-throwing backstop `Buffer.mutate` uses for
  its listeners, and the same precedent as `reportDetached` and
  `CommandBus`'s trailing `.catch`. That trace entry is dropped, but the
  `call`/`dispatch` outcome (resolve, reject, or `verb.kind`) is never
  affected by whether the sink succeeded — re-thrown errors are always the
  handler's own.
- A sink must be synchronous. Assigning an `async` function type-checks
  (it's still assignable to `=> void`), but the `Promise` it returns is not
  covered by the containment above — a rejection there becomes an unhandled
  rejection, not a caught one. Sinks that do async work must catch their own
  errors.
- If a payload defeats both of `describeTracePayload`'s rendering tiers
  (`JSON.stringify` and its `String(payload)` fallback both throw — an
  extreme, pathological payload), the entry is **not** dropped: its
  `payload` degrades to the fixed string `'<unrenderable>'` instead. Payload
  rendering failure is a property of the payload, not of the sink, so it is
  kept distinct from a broken sink — dropping the entry here would
  reintroduce exactly the "failing handler invisible to the trace" problem
  the previous paragraph exists to prevent.

Forest reconstruction (for call-tree UI) is not part of the core, and
neither is delivery (WebSocket etc.) — the core stops at writing into
`kernel.buffer`.
