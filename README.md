# kernelee

A **UNIX-pipe-like, message-driven, forward-only** control framework for
TypeScript. Control is data (messages), not a call hierarchy. A port of
[swift-kernelee](https://github.com/s-age/swift-kernelee) — the Swift
implementation's semantics are the source of truth, translated into TS
idioms. Zero runtime dependencies, ESM, strict.

See it in action:
[kernelee-lifegame](https://github.com/s-age/kernelee-lifegame) — Conway's
Game of Life driving the generation loop with `divert` and parallel row
chunks with `fork`.

![The devtools-bridge panel rendering lifegame's Randomize pipe as a node graph — fork branches, map/effect stages and symbol endpoints, all read statically from Pipe.descriptors](https://raw.githubusercontent.com/s-age/kernelee/master/docs/wiring-panel.png)

*Every flow above is a `Pipe` value — the
[devtools panel](https://github.com/s-age/kernelee-devtools-bridge) renders
it from `Pipe.descriptors` without executing anything, alongside live
traces from the same connection.*

## The model

Three ideas, borrowed from the shell:

- **Everything is a message.** A command is a typed symbol + payload
  (`kernel.call(increment, 41)`), not a method on an object graph. One
  kernel is the single chokepoint every message passes through — which is
  what makes tracing and a static wiring graph possible.
- **Flows are pipes.** Multi-step control chains left to right like a UNIX
  pipe (`fetchNote | map | tap | render`) and seals into a first-class
  `Pipe<I, O>` value whose topology is readable *without running it*.
- **Handlers steer with a `Verb` — and only forward.** Instead of
  return-value-or-throw, a handler answers with control as data:

  ```ts
  next(value)                       // keep flowing to the next stage
  abort(value)                      // stop here — the value is the result
  divert(diversion(otherPipe, p))   // discard remaining stages, jump into another pipe
  fail(error)                       // reject the whole flow
  ```

  Nothing flows backwards: `dispatch` is fire-and-forget with no return
  path, and `divert` *swaps the remaining stages* rather than calling and
  returning — a self-diverting loop (an agent loop) runs O(1) stack across
  any number of hops.

## Why not Redux / XState / effect-ts?

They answer different questions. Redux answers "how does state change"
(actions → reducer) and leaves multi-step control flow to add-ons (thunks,
sagas). XState answers "which states are legal" (statecharts). effect-ts
answers "how do I make effects typed and composable" with its own runtime
(fibers). kernelee answers "**what is the flow, as a value**" — and keeps
observable state (`Buffer`) deliberately thin, with transition logic in
plain functions. If you want reducer-centric state management and its
middleware ecosystem, use Redux; if you want to model legal state machines,
use XState. kernelee is for when the flow itself — dispatch, fan-out, divert
loops — should be an inspectable piece of data, on plain `async`/`await`.

## Install

```sh
npm install @s-age/kernelee
```

## Quick start

```ts
import { symbol, next, fail, pipeline, KernelBuilder, type Kernel } from '@s-age/kernelee';

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

Multi-step flows chain like a UNIX pipe and freeze into a typed value:

```ts
const toDto = pipeline(fetchNote)               // KernelSymbol<NoteId, Note>
  .map((note) => ({ note, seenAt: Date.now() }))
  .tap(saveAudit)                                // side effect, forwards the original value
  .map((c) => c.note).pipe(renderDto)            // payload assembly is a visible map node
  .seal();                                       // Pipe<NoteId, NoteDto>

const dto = await kernel.compose(toDto, id);     // typed final value
toDto.descriptors;                               // static shape, readable without running
```

Gotchas:

- **Leaf vs composing is discriminated by declared parameter count**
  (`fn.length >= 2` means kernel-first). Default and rest parameters break
  the discrimination.
- A composing handler's lambda needs parameter type annotations
  (`(kernel: Kernel, n: number) => …`) — TS settles the overload before
  contextually typing the lambda. A wrong annotation is a compile error.

## Documentation

Design notes and full API semantics live in `docs/`:

- [Pipes & fork](docs/pipes-and-fork.md) — `pipeline` / `divert` (O(1)
  loops) / `tap` / `map` / `effect`, and parallel fan-out with fork
  (including how cancellation differs from Swift).
- [Buffer](docs/buffer.md) — observable state cells (`defineState` /
  `mutate` / `subscribe`), `useSyncExternalStore` fit, `KernelErrorState`.
- [defineCallable & actionsOf](docs/define-callable.md) — the typed port
  factory (the `@callable` macro's TS counterpart) and redux-style
  `dispatch(action)`.
- [Tracing](docs/tracing.md) — span propagation through the `Kernel.invoke`
  chokepoint, `onTrace`, the `TraceState` buffer cell.
- [Wiring graph](docs/wiring-graph.md) — `describePipe` /
  `projectWiringGraph` / `validateWiringGraph`: a static JSON snapshot of
  the app's wiring.
- [Transport adapters](docs/transport-adapters.md) — why the core ships no
  delivery layer, and the two APIs a bridge package builds on.
- [Swift ↔ TS correspondence](docs/swift-ts-correspondence.md) — the full
  port table, including every deliberate non-correspondence.

Not ported *yet*: time-travel (trace forest reconstruction,
`Buffer.capture` / `restore`) — swift-kernelee ships it, and the TS port
plans to build it on `TraceState`. Today,
[kernelee-devtools-bridge](https://github.com/s-age/kernelee-devtools-bridge)
already rides a `Buffer` snapshot on every traced message, so the state at
any past point is inspectable; what's missing is restoring the live app to
it. Delivery/UI layers are out of scope by design — the core stays
zero-dependency and exposes the seams instead.

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
  showcase app (Conway's Game of Life).

## Development

```sh
npm test          # vitest run
npm run typecheck # tsc --noEmit
npm run build     # tsc → dist/ (with declarations)
```

## License

[MIT](LICENSE) © s-age
