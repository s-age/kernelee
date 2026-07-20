# Static wiring-graph snapshot

`Pipe.descriptors` (`kind`/`symbolId`/`note`/`divertsTo`/`branches`/
`untrackedBranches`/`handlerName`) already carries a static topology readable
without running anything — including `fork(symbol)`'s dynamic fan-out (a
`kind: 'fork(symbol)'` stage carries only `symbolId`; there is no branch
count to record ahead of time, since "how many" is a runtime fact — see
`pipes-and-fork.md`'s "Dynamic: fork(symbol)" section). Swift's `WiringGraphView`
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

## divertsTo validation (`validateWiringGraph`)

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

### The typed tier: `DispatchKey` / `KernelBuilder.flow`

The "documented ceiling" above is a real bug that has happened, not a
hypothetical: a `divertsTo` string that names a *real but wrong* key — a
valid-looking, author-swapped reference — passes every check above silently,
because a free-string `divertsTo` entry has no binder at all. The name lives
in three unlinked places (the `divertsTo` string, the `describePipe` catalog
key, and the actual runtime `Pipe` a handler diverts to) with nothing forcing
them to agree.

`src/dispatch-key.ts` closes this the same way `KernelSymbol` already closes
the analogous gap for `invoke` targets: a typed token plus a kernel-level
binding.

```ts
export interface DispatchKey<in P> {
  readonly key: string;
  readonly description?: string;
}
export function dispatchKey<P>(key: string, description?: string): DispatchKey<P>;
```

A `pipe`/`pipeline` anonymous verb stage gets a **typed twin** of the
free-string form: pass a `DivertTargets` map (`Record<string, DispatchKey
<any>>`) instead of a `readonly string[]`, and the closure receives a third
`diverts` argument — one callable per map entry, each pinned by `tsc` to
that entry's own `DispatchKey`'s payload type:

```ts
const retryFlow = dispatchKey<RetryPayload>('flows.retry');

pipeline(
  { note: 'maybe retry', divertsTo: { retry: retryFlow } },
  (kernel, cursor, diverts) => shouldRetry(cursor) ? diverts.retry(payload) : next(cursor),
)
```

`StageDescriptor.divertsTo` is filled identically either way — eagerly
normalized to `Object.values(map).map(k => k.key)` for the typed form — so
the JSON shape a wiring-graph consumer reads **never changes** between
tiers; this is purely an authoring-time upgrade. Runtime discrimination
between the two forms is `Array.isArray(divertsTo)`.

The other half is the binder: `KernelBuilder.flow(key, title, pipe, note?)`
registers the key against the pipe in the kernel's divert-resolution table
**and** records the same `PipeDescriptorEntry` `describePipe` would —
`describePipe`'s signature was always, in effect, a `(key, pipe)` pair; a
binder wearing a cataloguing hat. Merging the two flips the direction of
truth: `KernelBuilder.flowCatalog` is *derived* from the binding table
(the same relationship `boundSymbolIds` already has to the handler table),
rather than being a parallel, hand-maintained transcription of what got
wired — so `builder.flowCatalog` can feed `projectWiringGraph` exactly like
a hand-built catalog array, with completeness guaranteed rather than
disciplined.

`KernelBuilder.build()` adds one more check on top of `validateWiringGraph`:
it walks every registered flow's pipe (`Pipe.declaredTypedDivertKeys`, which
folds in fork-branch declarations too) and throws if any *typed* key was
declared but never bound via `flow()` — naming the missing key and which
flow(s) declared it. Free-string `divertsTo` entries are not part of this
check; they remain the unchecked tier `validateWiringGraph` covers instead.

**Detection-timing table** — where each class of mistake is caught:

| Mistake | Caught at |
|---|---|
| Typo / rename / payload-shape drift on a **typed** target | `tsc` (compile time) |
| Typed target declared but never `flow()`-bound | `KernelBuilder.build()` |
| A pipe's typed declaration invisible to `build()` because the pipe itself was never registered via `flow()` | Runtime, at the first `divert` to that key (`Kernel`'s "never bound via `KernelBuilder.flow(...)`" throw) — the safety net for exactly this gap |
| Raw/free-string `divertsTo`, or a hand-assembled `Diversion` | Unchecked — `validateWiringGraph`'s convention-level match, or nothing at all |
| A *real but wrong* choice **among several correctly-declared, correctly-bound** typed targets | Not caught anywhere — a principled ceiling, not an oversight: which candidate is correct is a runtime decision by definition, and no tier above claims otherwise |

The typed tier is TS-led: nothing in Swift forces a matching change, since
`swift-kernelee`'s `Pipe.swift` carries the identical, deliberate free-text
limitation today. A `DispatchKey`-shaped phantom generic struct (mirroring
Swift's own `Symbol<P, O>`) would be the natural counterpart there, should
the same problem get closed on that side too.

**Alternative considered and rejected**: auto-registering a flow the moment
its `DispatchKey` is minted (a module-level table populated on mint, so no
explicit `flow()` call would be needed) was rejected — import order is not
guaranteed, so "this key was never bound" and "this key's binding module
just hasn't been imported yet" would be indistinguishable at `build()` time.
That is the same reason `callable.ts`'s `mintedCallableIds` deliberately
stays a collision ledger and not a readable registry. See
`KernelBuilder.flow`'s own doc comment for the fuller version of this
argument.

## unlistedBoundSymbols / unlistedBoundSymbol

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
