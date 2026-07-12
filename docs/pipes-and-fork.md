# Pipes

The mental model is a UNIX pipe. `pipeline(...)` assembles left to right
(the `Cursor` type enforces "previous stage's Return == next stage's
Payload"), `seal()` freezes the chain into a `Pipe<I, O>`, and
`kernel.compose` / `kernel.run` drive it.

```ts
import { pipeline, next, divert, diversion, type Kernel, type Verb } from '@s-age/kernelee';

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
