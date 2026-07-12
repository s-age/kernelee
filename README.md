# kernelee

A TypeScript port of
[swift-kernelee](https://github.com/s-age/swift-kernelee) — control as
**data (messages)**, not a call hierarchy. The Swift implementation's
semantics are the source of truth, translated into TS idioms. Zero runtime
dependencies, ESM, strict.

What's included:

- **Core dispatch** — `KernelSymbol` / `Verb` / `Diversion` / `KernelBuilder` /
  `Kernel` (`call` / `dispatch`) / `CommandBus`.
- **Pipes** — `Pipe` / `PipeBuilder` / `pipeline` / `kernel.compose` /
  `kernel.run` / `diversion(pipe, payload)`.
- **fork** — parallel fan-out. **Buffer** — `Buffer` / `defineState` /
  `KernelErrorState` (the default `dispatch` error sink).
- **defineCallable** — `port` / `portK` / `portV` / `portKV`, the TS
  counterpart of the `@callable` macro.
- **TS-only sugar** — `actionsOf` / `dispatch(action)` (redux-style).
- **Tracing** — span propagation through `Kernel.invoke` / `Kernel.runStages` /
  `fork`, plus the `onTrace` hook and the `TraceState` buffer cell
  (`KernelBuildOptions.tracing` / `onTrace` / `traceCap`). The core records
  into `kernel.buffer`; delivery and UI live outside this package.
- **Static wiring graph** — `src/wiring-graph.ts`: `describePipe(key, title,
  pipe, note?)` catalogs a `Pipe`; `projectWiringGraph(catalog,
  boundSymbolIds)` projects the catalog into a `WiringGraphDocument`
  (a JSON-serializable static wiring graph); `validateWiringGraph(doc)`
  checks it. No registry — the caller hand-builds the catalog; `kind` is
  computed purely from the existing `Pipe.descriptors` /
  `KernelBuilder.boundSymbolIds`.

Not ported: time-travel (trace forest reconstruction, `Buffer.capture` /
`restore`) and any delivery/UI layer (e.g. a WebSocket bridge, panel UI) —
the core stays zero-dependency and exposes the seams instead.

## Ecosystem

The delivery and tooling layers the core deliberately excludes live in
sibling packages:

- [react-kernelee](https://github.com/s-age/react-kernelee) — React bindings
  for the `Buffer` (`useBuffer` / `useDispatch` / `useKernelError`).
- [kernelee-devtools-bridge](https://github.com/s-age/kernelee-devtools-bridge)
  — dev-only WS bridge + browser panel for the wiring graph and live traces.
- [kernelee-mcp-tools](https://github.com/s-age/kernelee-mcp-tools) — MCP
  server exposing a static scan of a kernelee app's wiring to coding agents.
- [kernelee-lifegame](https://github.com/s-age/kernelee-lifegame) — the
  showcase app (Conway's Game of Life) exercising `divert` (the generation
  loop) and `fork` (parallel row chunks).

```sh
npm test          # vitest run
npm run typecheck # tsc --noEmit
npm run build     # tsc → dist/ (with declarations)
```

## Usage

```ts
import { symbol, next, fail, KernelBuilder, type Kernel } from 'kernelee';

const increment = symbol<number, number>('math.increment');
const guarded = symbol<number, number>('math.guarded');
const reload = symbol<void, void>('notes.reload');

const builder = new KernelBuilder();
builder.register(increment, (n) => n + 1);                    // leaf: value-returning
builder.registerVerb(guarded, (n) =>                          // leaf: verb-returning
  n < 0 ? fail(new Error('negative')) : next(n * 2));
builder.register(reload, async (kernel: Kernel, _: void) => { // composing: kernel-first
  await kernel.call(increment, 1);
});

const kernel = builder.build({ onError: (symbolId, error) => { /* sink */ } });

await kernel.call(increment, 41); // => 42 (typed)
kernel.dispatch(reload, undefined); // fire-and-forget, serialized in submission order, failures go to onError
```

Notes:

- **Leaf vs composing is discriminated by declared parameter count**
  (`fn.length >= 2` means kernel-first). Default and rest parameters break
  the discrimination.
- A composing handler's lambda needs parameter type annotations
  (`(kernel: Kernel, n: number) => …`). TS overload resolution settles the
  overload before contextually typing lambda parameters, so the two-argument
  shape cannot be inferred. A wrong annotation is caught as a compile error.

## Pipes

The mental model is a UNIX pipe. `pipeline(...)` assembles left to right
(the `Cursor` type enforces "previous stage's Return == next stage's
Payload"), `seal()` freezes the chain into a `Pipe<I, O>`, and
`kernel.compose` / `kernel.run` drive it.

```ts
import { pipeline, next, divert, diversion, type Kernel, type Verb } from 'kernelee';

const toDto = pipeline(fetchNote)                    // KernelSymbol<NoteId, Note> — entry
  .map((note) => ({ note, seenAt: Date.now() }))     // pure synchronous transform (no I/O, no kernel calls)
  .tap(saveAudit)                                    // side effect (O=void), forwards the original value (tee). saveAudit receives the carrier as-is — even when only some fields are wanted, tap forwards the original value by contract, so projection is the symbol's own responsibility (tap takes no adapt argument)
  .pipe({ note: 'archived notes go to a different pipe' }, (kernel, c) =>
    c.note.archived
      ? divert(diversion(archivePipe, c.note))       // discard remaining stages → run archivePipe instead
      : next(c))                                     // continue
  .effect(async (kernel, c) => { /* buffer writes etc. */ }) // pass-through effect
  .map((c) => c.note).pipe(renderDto)                // payload assembly is visible as a map node: build the symbol payload from the cursor
  .seal();                                           // Pipe<NoteId, NoteDto>

const dto = await kernel.compose(toDto, id);  // typed final value (a builder can be passed as sugar)
await kernel.run(toDto, id);                  // forward-only: discards the final value, including abort/divert values
toDto.descriptors;                            // static shape readable without running (kind/symbolId/note/divertsTo/handlerName)
```

- **Every symbol stage goes through `kernel.invoke` (the single
  chokepoint)**. Anonymous stages (`pipe(meta, verbFn)` / `map` / `effect`)
  run their closure directly (same as Swift — only symbol traffic shows up
  in a trace).
- **`divert` is iteration, not recursion**: it swaps the stage list and value
  and continues from index 0, so a self-diverting loop (an agent loop) stays
  O(1) stack across any number of hops.
- **A `tap`'s verb governs the pipe**: the output (void) is discarded and the
  original value flows on, but a tapped handler's `fail` stops the pipe.
- Anonymous verb stages are discriminated by `meta = { note: string,
  divertsTo?: string[] }` (the translation of Swift's labeled arguments
  `note:`/`divertsTo:`; `note` doubles as the discriminant, so it is
  required). Mid-chain `.pipe(meta, (kernel, cursor) => …)` needs no lambda
  annotations (the cursor type is known). The entry form
  `pipeline(meta, (kernel: Kernel, p: P) => …)` does (nothing pins `P`).
- `tap` / `map` / `effect` also accept an optional leading `meta = { note }`
  to attach an author note; on `tap(meta, sym)` the author's note wins over
  the symbol's description (Swift's `note ?? description`).

## fork

Fan the current value out to N independent branches (each a sealed sub-pipe —
passing a builder works as sugar), run them concurrently, and collect
**order-preserved** results. Two shapes: heterogeneous tuples (2–4 arguments,
matching Swift's overload set) and homogeneous arrays. There is no dedicated
join API — `.map` / `.pipe` on the tuple/array output *is* the join (the
"transistor").

```ts
const summary = pipeline(fetchOrder)
  .fork(pipeline(fetchCustomer).seal(), pipeline(fetchInvoice).seal()) // [Customer, Invoice]
  .map(([customer, invoice]) => render(customer, invoice))
  .seal();

const all = pipeline(fetchIds)
  .fork([pipeline(fetchOne).seal(), pipeline(fetchOne).seal()], runtimeArity) // R[]
  .seal();
```

Verb semantics inside a branch (each branch is one whole `compose`, same as
Swift):

- `abort` — terminates **that branch only**; the abort value becomes that
  slot's result. The fork continues.
- `divert` — the diverted-to pipe's result fills the slot.
- `fail` — the whole fork (= the outer pipe) rejects. Downstream stages never
  run.

**Cancellation semantics differ from Swift (important)**: Swift's structured
concurrency (`async let` / task groups) cancels *running siblings* when one
branch fails. JS has no task cancellation — the implementation is
`Promise.all`, so the fork settles on the first rejection (the fail-fast
*outcome* is the same), but **sibling branches run to completion in the
background** and their results (or later rejections) are discarded (the
*resources* differ). Write branches so that a wasted full run is safe.
`AbortSignal` support is future scope.

Static shape: a fork stage's `StageDescriptor` has `kind: 'fork(branches)'`,
`branches` (each branch's own descriptors) and `branchArity`
(`fixedArity(n)` — structurally fixed, the default; `runtimeArity` — a
definition-side declaration that the array is sized per call). On non-fork
stages both fields are `undefined` (Swift defaults `branches` to an empty
array; the TS port represents absence, consistent with `branchArity`).

## Buffer

A registry of observable state (the "typed Redux" territory). Each state key
names one cell (single source of truth); the layer holding the kernel writes
via `mutate`, and the view layer only `read`s / `subscribe`s. **Transition
logic does not live in the Buffer** (it belongs to the pure logic layer).

```ts
import { defineState, BufferBuilder, KernelBuilder, KernelErrorState } from 'kernelee';

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

## defineCallable (the TS version of the `@callable` macro)

Swift's `@callable("Id.Prefix")` generates a `<Protocol>Callable` enum (one
typed `Symbol` per method + `wire(_:into:)`) from a device protocol. TS has
no macros, so the port is a **typed factory function** (codegen was
rejected): the spec object is the single denominator from which the symbols,
the device type and the wiring are all derived.

```ts
import { defineCallable, port, portK, portV, portKV, type CallableDeviceOf } from 'kernelee';

// Port declaration — corresponds to one @callable protocol in Swift.
// docs are explicit port() arguments (TS can't read JSDoc at runtime — a documented non-correspondence).
export const LifePort = defineCallable('Compute.Life', {
  stepChunk: port<ChunkInput, ChunkResult>('advance a row chunk one generation'), // leaf, value-returning
  reset:     portK<void, void>('reset the board and generation'),                 // composing (kernel-first), value-returning
  guard:     portV<number, number>('fail on negative input'),                     // leaf, verb-returning
  route:     portKV<number, string>('estimate via the kernel, then next/divert'), // composing, verb-returning
});

LifePort.stepChunk;        // KernelSymbol<ChunkInput, ChunkResult> (id = "Compute.Life.stepChunk",
                           // description = the doc — shows up in the wiring graph)
type LifeDevice = CallableDeviceOf<typeof LifePort>; // the implementor's type (shape derived per marker)

const device: LifeDevice = {
  stepChunk: (cells) => step(cells),
  reset: async (kernel) => { /* kernel-first; a void payload can be elided */ },
  guard: (n) => (n < 0 ? fail(new Error('negative')) : next(n * 2)),
  route: async (kernel, n) => next(String(await kernel.call(LifePort.stepChunk, [n]))),
};

LifePort.wire(device, builder); // one register/registerVerb per spec key
```

**The totality triangle** (there is no hand-written id list to drift):

1. **forward** — `wire`'s `CallableDevice<Spec>` constraint forces every
   method to be implemented (a missing implementation or payload type
   mismatch is a tsc error; in Swift, protocol conformance does this).
2. **reverse** — consumers can only call through the `LifePort.xxx` symbols
   (in Swift, the `any Protocol` use sites do this).
3. **wire** — the spec is the single denominator: one register is generated
   per spec key, so none can be forgotten (pinned in CI by the
   `builder.boundSymbolIds` exhaustiveness smoke test).

The markers map 1:1 onto Swift's four `register` overloads (value/verb ×
leaf/composing):

- `port<P, O>(doc?)` — leaf, value-returning: `(payload) => O | Promise<O>`
- `portK<P, O>(doc?)` — composing, value-returning:
  `(kernel, payload) => O | Promise<O>` (Swift discriminates on "first
  parameter is `Kernel`-typed"; TS can't read types at runtime, so the
  marker is declared)
- `portV<P, O>(doc?)` — leaf, verb-returning:
  `(payload) => Verb<O> | Promise<Verb<O>>` (Swift handles this *implicitly*
  through `register` overload resolution — TS already splits the name into
  `registerVerb`, so the marker is explicit)
- `portKV<P, O>(doc?)` — composing, verb-returning (the remaining 2×2 slot)

Notes and semantics:

- **`wire` does not rely on `fn.length` discrimination**: it composes the
  registered closure from the marker's arity (the same trick as the
  macro-generated `{ kernel, payload in device.m(kernel, payload) }`).
  Writing a `portK<void, void>` implementation as `(kernel) => …`
  (fn.length 1) still binds correctly through the composition.
- **Payloads are at most one argument; none means `void`**: the shape
  `port<void, O>()` enforces this naturally (corresponding to the Swift
  macro's "at most one payload parameter" check).
- **An omitted/empty doc is a `console.warn`**: Swift's
  `UndocumentedCallable` is *warning*-level, so the TS port also makes the
  doc optional and warns instead of throwing. The symbol then has no
  description (blank in the wiring graph).
- **Cross-definition id collisions throw at mint time** (`CallableError`,
  code `'duplicateSymbolId'`): the translation of the Swift macro plugin's
  `SymbolIDRegistry` + compile error, using a module-global ledger (the same
  pattern as `defineState`). Only ids minted by `defineCallable` are covered
  — Swift's registry is also macro-only, and hand-minted `symbol(id)` is out
  of scope (a collision there still throws `'duplicate'` at the second
  register). The spec keys `wire` / `__spec` are reserved because they
  collide with the generated surface (`'reservedMethodName'` throw).
- **Excess keys are type errors (exactness)**: fresh object literals hit
  TS's excess property check; a non-fresh device (via a variable) is
  rejected by `wire`'s `D & { [excessKey]: never }` (the Exclude-`never`
  trick). No runtime throw is needed (wire only walks spec keys, so an
  excess key is inert at runtime). Swift's `wire(_ device: any Protocol)`
  tolerates extra members, but in TS "a typo'd method name = an excess key
  + a missing implementation", so rejecting from both sides is safer.
- An inline fresh literal device gets contextual parameter typing
  (`(cells) => …` needs no annotations — inferred from the
  `CallableDevice<Spec>` constraint).

Non-correspondences with `@callable`: **no automatic JSDoc extraction**
(docs are explicit `port()` arguments); compile-time diagnostics translate
to "throw / console.warn at module evaluation" (TS has no macro expansion
hook); Swift's tolerance for re-expanding the same protocol (its registry
allows a same-name re-claim) is unnecessary here, so re-minting the same
prefix also throws.

## actionsOf (redux-style dispatch — TS-only)

An `Action<P, O>` is a "symbol + payload" pair = **a deferred command as
data**. `actionsOf(callable)` derives action creators from the spec (the
fourth derivation off the single-denominator spec, after the symbols, the
device type and `wire`), and `kernel.dispatch` has a one-argument overload
taking an action — the same idiom as redux's `dispatch(action)`.

```ts
export const SimActions = actionsOf(SimPort); // creators are pure functions — they can live in a contract layer

kernel.dispatch(SimActions.setSpeed(30)); // = dispatch(SimPort.setSpeed, 30)
kernel.dispatch(SimActions.play());       // void payload → zero-argument creator
```

- Zero added capability — it rides the same serial bus as
  `dispatch(sym, payload)`. The difference is separating "where the command
  is built" from "where it is fired" (a view needs one generic dispatcher
  plus creators).
- **Not a thunk**: an action is plain data, so logging, test assertions and
  introspection (the symbol's id/description) work as-is. Dispatching a
  function (redux-thunk style) is deliberately unsupported — control belongs
  to the Circuit.
- The phantom types carry through: `SimActions.setSpeed('fast')` is a tsc
  error.

## Span propagation

`Kernel.invoke` (kernel.ts) is the single chokepoint, and tracing hooks into
it. The Swift implementation wraps the same chokepoint with `traced(_:_:_:)`
(Kernel+Trace.swift) and tracks "which call tree am I in" implicitly via
`@TaskLocal static var span: UUID?`. JS has no TaskLocal equivalent
(runtime-independent ambient execution context) — `AsyncLocalStorage` is
Node-only, and in the browser the tracking would silently drop, which is why
that approach is a non-starter.

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
  untouched. This is Swift's `Kernel.$span.withValue(span) { body() }`
  carried on the kernel value instead of the task, so Node and browser
  behave identically.
  - The one remaining edge: a handler that ignores its `kernel` argument and
    calls back through a kernel reference **captured from outside** bypasses
    the scoped view and mints roots — call through the argument.
  - `dispatch` links too. This is deliberately **more than Swift**: the
    Swift drain task's task-locals freeze at kernel construction
    (CommandBus.swift:19-25), losing dispatch parentage, while the TS bus
    carries closures that capture the scoped kernel, so the link comes for
    free. When comparing traces cross-platform, what Swift shows as a root
    the TS port shows nested.
- Sequential stages within one `compose` do *not* parent each other — every
  stage shares the `parentSpan` the compose call itself received (always
  `undefined` for a top-level call) rather than inheriting the previous
  stage's span. This is not a compromise but Swift's actual behavior:
  `traced`'s `withValue` swaps the ambient only while the handler body runs,
  and it has reverted by the time the next stage's `invoke` fires.

## onTrace / TraceState

Every `Kernel.invoke` pass can be recorded into `kernel.buffer`'s
`TraceState` cell. The design follows the Swift side (`Trace.swift` /
`Kernel+Trace.swift` / `MonitorDefaults.swift`) with one deliberate change
driven by TS having no DEBUG/release split (the same bundle always runs).

**The sink signature carries no `id`.** Swift's `traceSink` receives
`(symbol, verb, span, parent, payload, at)`, and the monotonic `id` is
assigned only inside `TraceState.record` — the raw sink is thin, and
"format into a `TraceEntry` and append to `TraceState`" is the default
sink's job alone, the same relationship as `onError` /
`KernelErrorState`. The TS port keeps this:

```ts
// src/trace.ts — the data-model module (same granularity as span.ts)
export type TraceVerbKind = Verb<unknown>['kind']; // reuses 'next'|'abort'|'divert'|'fail'.
                                                     // Swift keeps a separate TraceVerb enum, but
                                                     // TS's Verb.kind is already the same discriminant.
export type TraceSink = (
  symbolId: string,
  verb: TraceVerbKind,
  span: Span,             // carries {id, parentId?} whole — folds Swift's (span, parent) pair into one argument
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

// Same batch-trim policy as Swift's TraceState.record — trim once the ring overshoots
// cap by 25%: removeFirst is O(cap), so the overshoot is dropped in one batch instead
// of paying per append. The entry carries no id — it is assigned here (the raw sink
// has none, as above).
export function appendTraceEntry(
  state: TraceStateValue,
  entry: Omit<TraceEntry, 'id'>,
  cap: number,
): TraceStateValue;
```

`TraceState` is not a built-in state that `BufferBuilder.build()` seeds
unconditionally the way `KernelErrorState` is — `KernelBuilder.build()`
looks at `options.tracing` and conditionally
`allocateIfAbsent(TraceState)`s before freezing the buffer (the translation
of Swift's "monitor state exists only in DEBUG builds" into the TS `tracing`
flag). Left off, `kernel.buffer.read(TraceState)` throws
`BufferError('unallocated')` like any other unallocated cell.

**There is exactly one toggle.** Swift gates "calling the traceSink at all"
(always, in DEBUG) and "payload rendering/snapshot via `recordsInspection`"
in separate layers (in release builds `traced` itself becomes a
passthrough and both disappear). TS has no such build split, so **one flag
gates the whole recording** — off, neither payload rendering nor the
`Buffer.mutate` into `TraceState` ever runs, and the only remaining cost is
span minting (`crypto.randomUUID()`, which is paid unconditionally). It is
not a two-tier toggle (recording vs payload rendering) because no concrete
use case demands that granularity; it can be added when one does.

```ts
export interface KernelBuildOptions {
  onError?: (symbolId: string, error: unknown) => void;
  buffer?: BufferBuilder;
  /** Master switch for trace recording. Default false — off, nothing beyond span minting is paid. */
  tracing?: boolean;
  /** Injecting one replaces the default write into TraceState (same behavior as onError). */
  onTrace?: TraceSink;
  /** The default sink's ring size. Default 300 (same value as Swift's MonitorOptions.traceCap). */
  traceCap?: number;
}
```

Payload rendering: zero-dep TS has no counterpart of Swift's `dump`
(Mirror-based pretty-print), so `describeTracePayload` uses `JSON.stringify`
(with a replacer that summarizes binary buffer views as e.g.
`"Uint8Array(3072)"` — see `docs/trace-payload-rendering-cost.md`), falls
back to `String(payload)` for non-serializable values (cycles, functions),
and caps at 1024 characters with an ellipsis (the same behavior as Swift's
`describePayload`). With `tracing` off, `Kernel.invoke` skips both this
rendering and the `onTrace` call entirely.

**A handler that throws instead of `fail`ing is still recorded.** A handler
bound with `register` (value-returning) has no way to return a `fail(...)`
verb directly, so its failures are always throws — `invoke` wraps the
handler call in try/catch and, on catching, still notifies `onTrace` once
with `verb: 'fail'` before re-throwing the same error (the exception
behavior seen from `call`/`dispatch` is unchanged). Without this, every
failure from a `register`-bound handler would vanish from the trace,
defeating the point of showing what failed.

Forest reconstruction (Swift's `TraceState.forest`, for call-tree UI) is not
part of the core, and neither is delivery (WebSocket etc.) — the core stops
at writing into `kernel.buffer`.

## Static wiring-graph snapshot

`Pipe.descriptors` (`kind`/`symbolId`/`note`/`divertsTo`/`branches`/
`branchArity`/`handlerName`) already carries a static topology readable
without running anything. Swift's `WiringGraphView`
(`Sources/KernelDebugUI/WiringGraph.swift`) likewise renders an injected
static snapshot of `[PipeDescriptor]`, not runtime events. The TS port
carries "1 Pipe → 1 catalog entry" and "catalog → JSON graph document" as
two layers in `src/wiring-graph.ts`.

**Layer 1 — `describePipe` is Swift's
`PipeDescriptor(key:title:pipe:note:)`.**

```ts
export interface PipeDescriptorEntry {
  readonly key: string;                          // the dispatch key this Pipe answers under
  readonly title: string;                         // human-readable name of the function assembling the pipe
  readonly stages: readonly StageDescriptor[];    // == pipe.descriptors, verbatim
  readonly note?: string;
}

export function describePipe(key: string, title: string, pipe: Pipe<any, any>, note?: string): PipeDescriptorEntry;
```

Swift's `PipeDescriptor.inputType` (a runtime type name) is omitted — for
the same reason `StageDescriptor` omits `flows`/`inputType`: TS generics are
erased at runtime, so it cannot be derived. There is no registry:
`defineCallable` itself carries no static topology (`callable.ts`'s
`mintedCallableIds` is a collision-detection ledger, not readable), and a
symbol only appears in a descriptor once some `Pipe` stage references it. So
the caller (the composition root) hand-builds the `PipeDescriptorEntry[]` —
the same pattern as Swift consumers writing `[PipeDescriptor(...)]` array
literals.

**Layer 2 — `projectWiringGraph` is a scope-reduced counterpart of Swift's
`IndexProjection`/`IndexDocument`.**

```ts
export function projectWiringGraph(
  catalog: readonly PipeDescriptorEntry[],
  boundSymbolIds: ReadonlySet<string>,
): WiringGraphDocument; // { schemaVersion, endpoints, symbols, unresolvedDivertTargets, unlistedBoundSymbols }
```

`kind` (`'endpoint' | 'divertTarget'`) adds no new runtime tracking — it is
decided purely by `boundSymbolIds.has(entry.key)`.
`KernelBuilder.boundSymbolIds` is an existing API readable before `build()`
(originally provided for the wiring-exhaustiveness smoke test), so the
projection just rides on it. `divertedFrom`/`symbols` are a pure fold over
one walk of every entry's `stages` tree (recursing into fork `branches`).

**The `divertedFrom` fold relies on a convention-level match.**
`StageDescriptor.divertsTo` is author-typed free text with no type-level or
runtime binding to the actual divert target (a constraint `pipe.ts` itself
carries by design). `projectWiringGraph` layers one more unchecked
convention on top: that `divertsTo` strings and the `key`s assigned by
`describePipe` follow the same naming convention. A mismatch never throws —
it is listed in `unresolvedDivertTargets` — so consumers of the document
must read a non-empty `unresolvedDivertTargets` as "naming drift, or a
deliberately uncatalogued external target", not automatically as a bug.

Swift's `Sources/KernelIntrospect/IndexProjection.swift`/`IndexSchema.swift`
are much broader (bindings, git/timestamp metadata, SwiftSyntax static-scan
sections `states`/`parts`/`sharedStages`/`types`/`unresolved`) — the TS port
takes only the "array catalog, no registry" pattern and the
`PipeDescriptor` field shape. A panel UI can consume `WiringGraphDocument`
as-is.

### divertsTo validation (`validateWiringGraph`)

The convention-level `divertsTo` match (above) has produced a real bug in
practice: a Route+Switch's `divertsTo` pointed at the key of a textually
similar shared *tail* pipe instead of the actual next hop, and nothing
caught it. `validateWiringGraph(doc)` ports the corresponding
introspection checks:

```ts
export interface WiringGraphIssue {
  readonly kind: 'unresolvedDivertTarget' | 'orphanEntry' | 'unlistedBoundSymbol';
  readonly key: string;
  readonly referrers?: readonly string[]; // unresolvedDivertTarget only
}

export function validateWiringGraph(doc: WiringGraphDocument): readonly WiringGraphIssue[];
```

It adds no new topology tracking — `unresolvedDivertTarget` re-reads
`doc.unresolvedDivertTargets` (only re-walking `stages` to attribute
`referrers`), and `orphanEntry` checks whether each endpoint's
`divertedFrom`, minus the endpoint's own key, is empty. The self-exclusion
is needed because `projectWiringGraph`'s own `divertedFrom` fold does not
exclude self-`divertsTo` (e.g. a continuation loop) — a panel still needs to
render the self-loop edge, so `projectWiringGraph` keeps it and only the
validation excludes it.

**Not a compiler guarantee — the ceiling is explicit**: neither check can
detect a *real but wrong* (swapped) key. The unresolved-target check only
tests existence, and the orphan check only accidentally catches a mistagged
key when its referrer count happens to drop to zero. swift-kernelee has no
compile-time guarantee of this kind either (`Pipe.swift`'s doc comment is
explicit: a divert's destination is decided at runtime, so static derivation
is impossible in principle).

**`orphanEntry` assumes the catalog is complete** — it is only meaningful
against a catalog that enumerates the app's entire real dispatch surface. A
curated demo subset will flag false-positive orphans for every entry not
chosen to demonstrate divert wiring; whether that is actionable is the
consumer's call.

As a side measure that lets TS itself catch typos and missed renames, prefer
referencing a shared `as const` string constant from both the `divertsTo`
declaration and the `describePipe` `key`. This too only catches the "typo"
class — a *real but wrong* (swapped) key is beyond it, the same limit as
`validateWiringGraph`.

### unlistedBoundSymbols / unlistedBoundSymbol

The symmetric twin of `unresolvedDivertTargets`: that field is "**referenced**
by `divertsTo` but unresolvable", while
`WiringGraphDocument.unlistedBoundSymbols: readonly string[]` is "**bound**
but neither any `describePipe` `key` nor referenced by any
`stage.symbolId`" — `boundSymbolIds \ (endpointKeys ∪ referencedSymbolIds)`.
`projectWiringGraph` receives every bound id from the start, so silently
discarding this remainder would be the same failure
`unresolvedDivertTargets` exists to avoid, on the other side of the fold.
The field is always present (`[]` when everything is accounted for).

`validateWiringGraph` reports the whole remainder as
`{kind: 'unlistedBoundSymbol', key}` entries — like `orphanEntry`, it
reports and does not judge. There are at least two real reasons an id can
be bound-but-unlisted, and the core cannot tell them apart: (1) a bound port
member with no `Pipe` behind it (a deliberate plain Mutator / thin
launcher); (2) a bound symbol only referenced through a branch family the
catalog never constructs (a granularity gap). Which one it is requires
reading the source, which neither `projectWiringGraph` nor
`validateWiringGraph` has — classification belongs to a consumer-side static
scan, and the accept/reject decision to the app downstream of that.

## Transport adapters

This README's "zero runtime dependencies, ESM, strict" rests on
`package.json`'s `devDependencies` being only
`@types/node`/`typescript`/`vitest`. Bringing a delivery mechanism such as a
WebSocket client into the core package would break that. Swift achieves the
separation by putting `KernelDebugUI` in a separate target from `Kernel`
(`Package.swift`, with `#if DEBUG` gates); the TS port keeps the delivery
layer outside the core in the same shape.

**There is no `TransportAdapter` type.** `onTrace` (`src/trace.ts`) and
`describePipe`/`projectWiringGraph` (`src/wiring-graph.ts`) are public
exports of `index.ts`, and those two APIs are all an external package needs
to assemble delivery. Freezing a concrete delivery shape (WS send, etc.)
into a type here would take that design freedom away from the bridge package
that actually builds one.

```ts
// tests/transport-adapter.test.ts — uses only index.ts's public exports,
// modeling how an external bridge package would consume them
const kernel = builder.build({
  tracing: true,
  onTrace: (symbolId, verb, span, payload, timestamp) =>
    send({ symbolId, verb, span, payload, timestamp }), // live path
});

const doc = projectWiringGraph(catalog, builder.boundSymbolIds);
send(doc); // static path — both flow into the same send()
```

That this stays dev-only is guaranteed by the opt-in design itself — nothing
happens unless the consumer explicitly wires `onTrace`/catalog emission
(close to Redux's `window.__REDUX_DEVTOOLS_EXTENSION__` pattern; no reliance
on build-time dead-code elimination). `tests/transport-adapter.test.ts`
verifies that both paths (live trace, static catalog) can be assembled from
`../src/index.js` imports alone, never touching internal modules like
`src/kernel.ts`/`src/trace.ts`. Note this proves the completeness of the
public export surface as seen from within this repository; consuming the
built `dist/` output through a real package boundary is an external
package's own verification.

## Swift ↔ TS correspondence

| Swift (swift-kernelee) | TS (kernelee) | Notes |
| --- | --- | --- |
| `Symbol<Payload, Output>` | `KernelSymbol<P, O>` + `symbol(id, description?)` | Renamed to avoid colliding with ES `Symbol`. The phantom types are a `__phantom?: (p: P) => O` brand (absent at runtime; P contravariant / O covariant) |
| `enum Verb<Forward>` | Discriminated union `Verb<F>` (`kind: 'next' \| 'abort' \| 'divert' \| 'fail'`) + `next` / `abort` / `divert` / `fail` helpers | Terminators return `Verb<never>`, assignable to any `Verb<F>` |
| `Verb.erased()` | none | `Verb<F>` widens structurally to `Verb<unknown>`, so only type-level widening is needed |
| `Diversion(pipe, payload)` | `diversion(pipe, payload)` (typed overload) / `diversion(stages, payload)` (raw) | The usage idiom is `divert(diversion(pipe, payload))` = Swift `.divert(Diversion(pipe, payload))`. `ErasedStage` = Swift `PipeStage.run` |
| `KernelBuilder.register` (4 overloads: value/verb × leaf/composing) | `register` (value-returning) / `registerVerb` (verb-returning), each discriminating leaf/composing by `fn.length` | TS cannot resolve overloads on return type, hence the name split |
| duplicate-register `precondition` trap | immediate `KernelError` (code `'duplicate'`) on the second bind | TS has no process trap, so it translates to a throw |
| `KernelError.unbound` | `KernelError` (code `'unbound'`) | Thrown in `invoke` (the single chokepoint) |
| `KernelError.composeTypeMismatch` | none | Generics are fully erased, so the boundary cast is unchecked (`as O`). A mismatch surfaces at the use site |
| `ErasedHandler` (`(Kernel, Any) async throws -> Verb<Any>`) | `ErasedHandler` (`(kernel, payload: unknown) => Promise<Verb<unknown>>`) | |
| `builder.boundSymbolIDs` | `builder.boundSymbolIds` | For the wiring-exhaustiveness smoke test |
| `builder.build(buffer:onError:onTrace:monitor:snapshotStates:)` | `builder.build({ onError?, buffer?, tracing?, onTrace?, traceCap? })` | `buffer` is a `BufferBuilder` (frozen inside build). Default error sink writes `"symbolId: message"` into `KernelErrorState`; default trace sink appends to `TraceState` via `appendTraceEntry` — each replaced entirely by injecting `onError`/`onTrace`. Swift's monitor/snapshot options have no counterpart |
| `kernel.call(symbol, payload)` / `call(Symbol<Void, O>)` | `kernel.call(sym, payload)` / `kernel.call(sym)` (void sugar overload) | One-stage pipe = invoke + interpret. Carries no span argument, but parents under the instance's ambient span (`undefined` on a built kernel = flow root; the handler's span on the span-scoped view a handler receives — span linking) |
| `kernel.dispatch(symbol, payload)` | `kernel.dispatch(sym, payload): void` / `dispatch(action)` (TS-only overload) | Forward-only: no return value or return path. Synchronous enqueue, immediate return. A dispatch from inside a handler links its span (deliberately more than Swift — see the span propagation section) |
| `CommandBus` (one drain task consuming an AsyncStream serially) | `CommandBus` (serial promise chain `queue = queue.then(work).catch(…)`) | A later submission never overtakes an async predecessor. suspend/resume (time-travel) is not ported |
| `Kernel.invoke` (internal chokepoint) | `Kernel.invoke(id, payload, parentSpan?)` (`@internal` JSDoc) | The unbound check is centralized here. Pipe stages funnel through it too. A span is minted after handler resolution; with `tracing` on, `onTrace` is notified. The handler receives a span-scoped view whose ambient span is the minted span (the counterpart of Swift `traced`'s `withValue`) |
| `Kernel.interpret(_:as:)` | `Kernel.#interpret<O>` | `next`/`abort` → value, `divert` → iterate `runStages`, `fail` → throw. The divert path parents under the instance's own ambient span (`undefined` on a built kernel — the diverting handler's span has already closed by interpret time, matching Swift, where `traced`'s ambient has reverted before the follow-up runs under the caller's enclosing span) |
| `Kernel+Compose.runStages` (iterative, O(1) stack) | `Kernel.runStages(stages, payload, parentSpan?)` | Ported verbatim because `call`'s `divert` interpretation needs it; `compose`/`run` are thin wrappers. Not `#`-private so `fork` can call it directly without going through the public `compose` (`parentSpan` stays constant for the whole call, including divert continuations) |
| `Pipe<Input, Output>` / `Pipe.descriptors` | `Pipe<I, O>` (phantom brand, ctor is `@internal`) / `descriptors` | `SourceLocation` (`#filePath`/`#line`) is not ported (design decision). `flows`/`inputType` are also absent — TS has no runtime type names |
| `StageDescriptor` (kind/symbolID/flows/description/wireSite/branches/divertsTo/branchArity) | `StageDescriptor` (`kind`/`symbolId?`/`note?`/`divertsTo`/`branches?`/`branchArity?`/`handlerName?`) | `kind` is nine compound literals (`pipe(symbol)`/`pipe(function)`/`pipe(closure)`/`tap(symbol)`/`map(function)`/`map(closure)`/`effect(function)`/`effect(closure)`/`fork(branches)`) — the method part declares the execution/value-control causality, the operand part declares where the identity lives (`symbol`=`symbolId`, `function`=`handlerName`, `closure`=no identifier, `note` only, `branches`=fork). `function`/`closure` and `handlerName` are minted from one single `fn.name` check, so they can never disagree. Swift's `description` is folded into `note`. `branches`/`branchArity` are fork-only (non-fork is `undefined` — Swift uses `branches: []`) |
| `PipeBuilder.pipe(symbol)` / `pipe(symbol){adapt}` / `pipe(note:divertsTo:){verbFn}` | `.pipe(sym)` / `.pipe(meta, verbFn)` | There is no `pipe(sym, adapt)` — payload assembly is written `.map(adapt).pipe(sym)`, making the reshaping a visible graph node. `meta = { note, divertsTo? }`; `note` doubles as the overload discriminant, so it is required (Swift lets it be omitted). Mid-chain verbFns are contextually typed (single signature) |
| `PipeBuilder.tap(symbol)` / `tap(symbol){adapt}` / `map` / `effect` / `seal()` | `.tap(sym)` / `.tap(meta, sym)` / `.map(fn)` / `.map(meta, fn)` / `.effect(run)` / `.effect(meta, run)` / `seal()` | There is no `tap(sym, adapt)` either — `tap` forwards the original cursor by contract, so `.map(project).tap(sym)` is not equivalent (map replaces the cursor with the projection); a tap symbol needing a projection should take the cursor as-is and read what it needs. `tap`'s verb governs the pipe (`fail` stops it), the original value is forwarded. On `tap(meta, sym)` the author's note wins over the symbol description (Swift's `note ?? description`). `map` is pure and synchronous (JSDoc bans I/O) |
| `pipeline(symbol)` / `pipeline(note:divertsTo:){stage}` | `pipeline(sym)` / `pipeline(meta, verbFn)` | The entry verbFn requires parameter annotations (nothing pins `P`) |
| `kernel.compose(pipe, payload)` / `compose(builder, payload)` | same + `compose(pipe)` (void sugar) | The boundary cast is unchecked (`as O`). The void sugar is TS-only symmetry with `call(sym)` (Swift has no Void compose convenience) |
| `kernel.run(pipe, payload)` / `run(builder, payload)` | same + `run(pipe)` (void sugar) | Forward-only: discards the final value, including `abort`/`divert` values. The boundary cast itself disappears |
| `PipeBuilder.fork` (tuples 2/3/4 + array; `async let` / `withThrowingTaskGroup`) | `.fork(b1, b2[, b3[, b4]])` / `.fork(branches[, arity])` — all shapes share one `Promise.all` code path | A JS tuple *is* an array, so there is one execution strategy. Branches may be `Pipe`s or unsealed `PipeBuilder`s (TS sugar). **Fail-fast outcome matches Swift, but siblings are not cancelled and run to completion** (see the fork section) |
| `BranchArity` (`.fixed(Int)` / `.runtime`) | `BranchArity` discriminated union + `fixedArity(n)` / `runtimeArity` | Array fork with `arity` omitted defaults to `fixedArity(branches.length)` (same default as Swift) |
| state type as the key (`ObjectIdentifier(State.self)`) | `defineState<S>(id, initial)` → `StateKey<S>` (explicit token) | TS cannot key on a type at runtime. A duplicate id throws at mint (`BufferError` `'duplicateStateId'`). The initial value rides on the key (Swift passes it to `allocate(value)`) |
| `BufferBuilder.allocate(initial)` / `allocateIfAbsent` / `build()` | `allocate(key)` / `allocateIfAbsent(key)` / `build()` | `build()` always seeds `KernelErrorState`. A duplicate `allocate` throws (Swift overwrites — in TS the seed rides on the key, so a double allocation is always a mistake) |
| `BufferStore<State>` (`@Observable`) + `Buffer.read`/`mutate` | `Buffer.read(key)` / `getSnapshot(key)` / `mutate(key, updater)` / `subscribe(key, listener)` | Explicit subscribe (`useSyncExternalStore` shape) instead of the Observation macro. `mutate` is copy-on-write (the updater returns the new value — Swift uses `inout`) and synchronous. Unallocated access throws `BufferError` `'unallocated'` (Swift: `preconditionFailure`) |
| `KernelErrorState` (`message: String?`) | `KernelErrorState: StateKey<KernelErrorValue>` (`message: string \| null`) | Swift's `defaultErrorSink` equivalent is built into `build()`: with no `onError` injected it writes `"symbolId: message"`. Injection replaces the default entirely and `KernelErrorState` is unused |
| `Trace.swift` / `Kernel+Trace.swift` (`traceSink`, always recording in DEBUG) / `MonitorDefaults.swift` (`traceCap`) | `src/trace.ts`: `TraceSink` / `TraceEntry` / `TraceState: StateKey<TraceStateValue>` / `appendTraceEntry(state, entry, cap)` | The raw sink carries no `id` — only `appendTraceEntry` assigns one (same relationship as `onError`/`KernelErrorState`). The `(span, parent)` two-argument pair is folded into one `Span {id, parentId?}`. Unlike `KernelErrorState`, `TraceState` is allocated by `KernelBuilder.build()` only when `tracing` is on (Swift's DEBUG-only monitor state) |
| `recordsInspection` (two-tier toggle: recording vs payload rendering; `traced` becomes a passthrough in release) | `KernelBuildOptions.tracing` (single toggle, default `false`) | TS has no DEBUG/release build split, so one flag. Off, neither payload rendering nor `Buffer.mutate` runs (only the span-minting cost remains) |
| `describePayload` (`dump`-based) | `describeTracePayload(payload)` (`src/trace.ts`) | `JSON.stringify` with a binary-view summarizer (`"Uint8Array(3072)"`) → `String(payload)` fallback on failure, 1024-char cap + `…` |
| `Buffer.capture` / `restore` (time-travel) | none | Not ported; would build on `TraceState` |
| `PipeDescriptor` (one catalog entry) | `PipeDescriptorEntry` + `describePipe(key, title, pipe, note?)` (`src/wiring-graph.ts`) | No registry — the caller (composition root) hand-builds the catalog array, same as Swift. `inputType` omitted for the same reason as in `StageDescriptor` |
| `IndexProjection`/`IndexDocument` (full schema incl. bindings, git/timestamp metadata, SwiftSyntax static scan) | `projectWiringGraph(catalog, boundSymbolIds)` → `WiringGraphDocument` (`schemaVersion`/`endpoints`/`symbols`/`unresolvedDivertTargets`/`unlistedBoundSymbols`) | Scope-reduced to wiring topology only. `kind` (`'endpoint' \| 'divertTarget'`) comes from `boundSymbolIds`; `divertedFrom`/`unresolvedDivertTargets` fold `StageDescriptor.divertsTo` against each entry's `key` (recursing into fork `branches`). The match is convention-level (`divertsTo` is unchecked free text — `pipe.ts`'s own constraint); a mismatch never throws, it is listed in `unresolvedDivertTargets` |
| `@callable("Id.Prefix")` protocol + generated `<Protocol>Callable` enum | `defineCallable(prefix, spec)` → symbols + `wire` (frozen object) | Macro → typed factory function (codegen rejected). The spec is the single denominator (totality triangle) |
| requirement = protocol method (composing detected by a `Kernel`-typed first parameter) | spec entry = `port` / `portK` / `portV` / `portKV` marker | TS cannot read types at runtime, so markers are declared. `wire` composes closures from the marker arity — no `fn.length` discrimination |
| verb-returning methods (bound implicitly via `register` overload resolution) | `portV` / `portKV` (explicit, bound via `registerVerb`) | TS already splits register/registerVerb by name, so explicit markers are the counterpart |
| `///` doc comment → `Symbol.description` (automatic lift) | `port(doc)` argument → `description` | **No automatic JSDoc extraction** (a non-correspondence). Docs are explicit declaration arguments |
| `UndocumentedCallable` (compile warning) | omitted/empty doc → `console.warn` (at mint) | Matching the warning level, docs are optional and never throw |
| `SymbolIDRegistry` + `DuplicateSymbolID` (compile error) | module-global ledger; a duplicate id throws `CallableError` (`'duplicateSymbolId'`) at mint | Same ledger pattern as `defineState`. Covers `defineCallable` mints only (Swift's registry is also macro-only). Re-minting the same prefix also throws (there is no re-expansion concept) |
| "at most one payload parameter" check (macro guard) | structurally enforced by `port<P, O>`'s type parameters (none means `void`) | |
| `wire(_ device: any Protocol, into:)` — tolerates extra members | `wire(device, builder)` — both missing implementations and excess keys are tsc errors | Exactness: fresh literals hit the excess property check, non-fresh devices hit the `Exclude`-`never` trick. `CallableDevice<Spec>` / `CallableDeviceOf<typeof Port>` are public |
| none | `Action<P, O>` / `actionsOf(callable)` / `dispatch(action)` | TS-only: redux's `dispatch(action)` idiom (see the actionsOf section). No thunks (an action is plain data) |
| (unreachable under conformance) | punching a hole through `wire` with a cast throws `'missingImplementation'` | Runtime defense line when the type system is bypassed |

## License

[MIT](LICENSE) © s-age
