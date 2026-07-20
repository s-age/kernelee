# defineCallable

TS has no macros, so a port is declared via a **typed factory function**
(codegen was rejected): the spec object is the single denominator from which
the symbols, the device type and the wiring are all derived.

```ts
import { defineCallable, port, portK, portV, portKV, type CallableDeviceOf } from '@s-age/kernelee';

// Port declaration — the spec object is the single source of truth.
// docs are explicit port() arguments (TS can't read JSDoc at runtime).
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
   mismatch is a tsc error).
2. **reverse** — consumers can only call through the `LifePort.xxx` symbols.
3. **wire** — the spec is the single denominator: one register is generated
   per spec key, so none can be forgotten (pinned in CI by the
   `builder.boundSymbolIds` exhaustiveness smoke test).

The markers form a 2×2 matrix (value/verb × leaf/composing):

- `port<P, O>(doc?)` — leaf, value-returning: `(payload) => O | Promise<O>`
- `portK<P, O>(doc?)` — composing, value-returning:
  `(kernel, payload) => O | Promise<O>` (TS can't read types at runtime, so
  the marker is declared explicitly)
- `portV<P, O>(doc?)` — leaf, verb-returning:
  `(payload) => Verb<O> | Promise<Verb<O>>` (TS already splits the name into
  `registerVerb`, so the marker is explicit)
- `portKV<P, O>(doc?)` — composing, verb-returning (the remaining 2×2 slot)

Notes and semantics:

- **`wire` does not rely on `fn.length` discrimination**: it composes the
  registered closure from the marker's arity (the same trick as the
  macro-generated `{ kernel, payload in device.m(kernel, payload) }`).
  Writing a `portK<void, void>` implementation as `(kernel) => …`
  (fn.length 1) still binds correctly through the composition.
- **Payloads are at most one argument; none means `void`**: the shape
  `port<void, O>()` enforces this naturally.
- **An omitted/empty doc is a `console.warn`**: the doc is optional, and an
  omission warns instead of throwing. The symbol then has no description
  (blank in the wiring graph).
- **Cross-definition id collisions throw at mint time** (`CallableError`,
  code `'duplicateSymbolId'`), using a module-global ledger (the same
  pattern as `defineState`). Only ids minted by `defineCallable` are covered
  — hand-minted `symbol(id)` is out of scope (a collision there still throws
  `'duplicate'` at the second register). The spec keys `wire` / `__spec` are
  reserved because they collide with the generated surface
  (`'reservedMethodName'` throw).
- **Excess keys are type errors (exactness)**: fresh object literals hit
  TS's excess property check; a non-fresh device (via a variable) is
  rejected by `wire`'s `D & { [excessKey]: never }` (the Exclude-`never`
  trick). No runtime throw is needed (wire only walks spec keys, so an
  excess key is inert at runtime). Rejecting from both sides is safer: in
  TS, a typo'd method name shows up as both an excess key and a missing
  implementation.
- An inline fresh literal device gets contextual parameter typing
  (`(cells) => …` needs no annotations — inferred from the
  `CallableDevice<Spec>` constraint).

**No automatic JSDoc extraction**: docs are explicit `port()` arguments.
Compile-time diagnostics translate to "throw / `console.warn` at module
evaluation". Re-minting the same prefix also throws.

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
