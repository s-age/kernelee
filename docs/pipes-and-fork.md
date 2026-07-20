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

`fork` has two vocabularies — **static `fork(branches)`** (a fixed set of
distinct sub-pipes, decided at pipe-construction time) and **dynamic
`fork(symbol)`** (the same one symbol, fanned over a runtime-sized list).
They share only the name and the join strategy (`Promise.all`,
order-preserving, fail-fast); everything else — what the operand *is*, what
the `StageDescriptor` records, how many times a thing runs — differs.

### Static: `fork(branches)`

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
  .fork([pipeline(fetchOne).seal(), pipeline(fetchOne).seal()]) // R[]
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

Static shape: a fork stage's `StageDescriptor` has `kind: 'fork(branches)'`
and `branches` (each branch's own descriptors, in fork order). On non-fork
stages `branches` is `undefined` (Swift defaults it to an empty array; the TS
port represents absence). There used to also be a `branchArity` field
(`fixedArity(n)` / `runtimeArity`, declaring whether the branch count was
structural or sized per invocation) — removed once `fork(symbol)` (below)
gave the "sized per invocation" case a real, non-workaround vocabulary of its
own; see that section.

**Branch/meta contract**: a leading `meta` is recognized by *positively*
validating its shape — it must be a plain `{ note?: string }` object (a
prototype chain that bottoms out at `Object.prototype`/`null` immediately) —
not by guessing "doesn't look like a branch, so it must be meta". Every
branch position accepts only a `Pipe`/`PipeBuilder` constructed by *this*
kernelee module instance; anything else (a cross-copy `Pipe`/`PipeBuilder`
from a duplicated kernelee install, a hand-rolled object with a `.seal`
method, `null`/`undefined`) is rejected loudly with a diagnostic `TypeError`,
never silently absorbed as meta and never silently duck-typed through.
Residual gap, inherent to the overload shape: a *plain-object* branch-like
value in the leading position (e.g. `{ stages: [] }`) is structurally
indistinguishable from an empty meta `{}` and is still accepted as meta —
branch validation only happens once the leading-meta slot has been decided.

### Dynamic: `fork(symbol)`

Fan a **runtime-sized** `ReadonlyArray<P>` cursor out to the *same* symbol,
once per element, via `kernel.invoke` — the identical chokepoint `.pipe(sym)`
itself uses, so gate application and invoke count are unchanged from N
sequential `.pipe(sym)` stages, just concurrent. Order-preserving, fail-fast —
the same join semantics as static `fork` above (each element's `abort` fills
that element's own slot; a `divert` resolves to its target's own result; any
`fail` rejects the whole fork).

```ts
const doubled = pipeline(fetchIds)     // KernelSymbol<void, number[]>
  .fork(doubleOne)                     // KernelSymbol<number, number> — same symbol, N times
  .seal();                             // Pipe<void, number[]>
```

**N ≥ 1 is a runtime contract, not a drawing convention.** An empty payload
array throws `KernelError('emptyFanOut', symbolId, …)` rather than resolving
to `[]`: this stage's `R[]` output can only be produced by the symbol
actually running, so completing on zero elements would fabricate a "ran and
produced nothing" result without the symbol ever having been invoked — the
same class of failure `#resolveFlowKey`'s unbound-divert-key throw already
uses this vocabulary for.

Static shape: `kind: 'fork(symbol)'`, `symbolId` (the fanned-out symbol's
id), `note` (the symbol's own `description`, same convention as
`pipe(symbol)`/`tap(symbol)`). `branches`/`untrackedBranches` never apply —
"how many times" is exactly what this `kind` itself declares, so there is no
branch array to size or nest.

**First exception to "a fork-family operand is a `Pipe`/`PipeBuilder`, never
anything else."** Every shape above, and the detached-launch sugar `.spawn`
(deliberately pipe-only — see that method's own doc comment: "never a bare
closure or symbol"), held to that rule without exception until now —
`fork(symbol)` is the one place a fork-family method accepts something else
(a `KernelSymbol`) as its operand, because there is no sub-pipe to build: the
"branch" *is* the symbol, invoked directly. `.spawn` itself is unchanged and
remains pipe-only; this exception is scoped to `.fork` alone.

Initial version is **tracked only** — there is no untracked/`.spawn` twin of
`fork(symbol)` yet; add one only once a real caller needs it.
