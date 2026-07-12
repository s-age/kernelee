# Static wiring-graph snapshot

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
