import type { GuardCatalogEntry } from './gate.js';
import type { Pipe, StageDescriptor } from './pipe.js';

// MARK: - PipeDescriptorEntry (one Pipe, catalogued)

/**
 * One `Pipe` entered into a wiring-graph catalog, scoped to what a static
 * wiring graph needs (no `inputType`, for the same reason
 * {@link StageDescriptor} omits `flows`: TS generics are erased, so there is
 * no runtime type name to record).
 */
export interface PipeDescriptorEntry {
  /** The dispatch key this `Pipe` answers under — matched against {@link StageDescriptor.divertsTo} strings and `KernelBuilder.boundSymbolIds` by {@link projectWiringGraph}. */
  readonly key: string;
  /** Human-readable name of the function that assembles this pipe. */
  readonly title: string;
  /** `pipe.descriptors`, taken verbatim — the static topology a wiring graph renders. */
  readonly stages: readonly StageDescriptor[];
  readonly note?: string;
}

/**
 * Catalog one `Pipe`. There
 * is no registry to enumerate (wiring is scattered across independently
 * constructed `Pipe`/`Callable` values, and `defineCallable` itself carries no
 * static topology — see `callable.ts`'s `mintedCallableIds`, which is a
 * collision ledger, not a readable registry): a caller builds the catalog
 * array by hand.
 */
export function describePipe(
  key: string,
  title: string,
  pipe: Pipe<any, any>,
  note?: string,
): PipeDescriptorEntry {
  return { key, title, stages: pipe.descriptors, note };
}

// MARK: - WiringGraphDocument (catalog -> static graph, JSON-serializable)

/**
 * Whether a catalog entry answers dispatch directly (bound in the kernel that
 * built it) or is only ever reached by a `divert` from another entry.
 */
export type WiringEndpointKind = 'endpoint' | 'divertTarget';

/** One catalog entry, projected with its incoming divert edges folded in. */
export interface WiringEndpoint {
  readonly key: string;
  readonly title: string;
  readonly kind: WiringEndpointKind;
  readonly note?: string;
  /** Other entries' keys whose stage tree names this entry's `key` in `divertsTo`. */
  readonly divertedFrom: readonly string[];
  readonly stages: readonly StageDescriptor[];
}

/** One symbol id referenced anywhere in the catalog's stage trees. */
export interface WiringSymbolEntry {
  readonly symbolId: string;
  readonly bound: boolean;
  /** Catalog entry keys whose stage tree invokes this symbol id (fork branches included). */
  readonly usedByEndpoints: readonly string[];
}

/**
 * The static twin of `gate.ts`'s `GuardCatalogEntry` inside a projected
 * `WiringGraphDocument` — a plain alias, not a new type, because the shape a
 * consumer needs here (`targetId` + `gateIds` in fold execution order) is
 * exactly `KernelBuilder.guardCatalog`'s own shape with nothing added or
 * dropped; introducing a second, structurally-identical interface would only
 * invite the two to drift silently apart at the one point (this document)
 * where the golden-JSON contract most needs them not to. `projectWiringGraph`
 * takes `guardCatalog: readonly WiringGuardEntry[]` verbatim.
 */
export type WiringGuardEntry = GuardCatalogEntry;

/** The projected, JSON-serializable static wiring graph, scoped to wiring topology. */
export interface WiringGraphDocument {
  /**
   * Golden-JSON contract version. Bumped 4 → 5 when `StageDescriptor` gained
   * `untrackedBranches` (detached fork branches — see `pipe.ts`): an additive
   * field, but the JSON shape a downstream consumer (devtools panel,
   * py-kernelee, the mcp-tools scanner) reads changed, so the version moves in
   * lockstep. Consumers should gate on `schemaVersion >= 5` to read the field.
   *
   * Bumped 5 → 6 when the document gained the required `guards` field (gate
   * wiring — see `gate.ts`'s `declareGate`/`KernelBuilder.guard`/
   * `GuardCatalogEntry`). Additive in shape, like 4 → 5, but `guards` is
   * *required* rather than optional-with-a-`[]`-default specifically so "this
   * app wires zero gates" (`guards: []`) stays distinguishable from "the
   * projector forgot to pass a guard catalog" (a field silently missing from
   * the JSON) — the same silent-absence failure `unresolvedDivertTargets`/
   * `unlistedBoundSymbols` already exist to reject, now applied to gates.
   * Consumers should gate on `schemaVersion >= 6` to expect `guards` to be
   * present.
   */
  readonly schemaVersion: 6;
  readonly endpoints: readonly WiringEndpoint[];
  readonly symbols: readonly WiringSymbolEntry[];
  /**
   * Every guarded target from `KernelBuilder.guardCatalog`, taken verbatim —
   * `gateIds` stays in fold execution order (never re-sorted; see
   * `GuardCatalogEntry`'s own doc comment on why that order is a behavioral
   * contract). `targetId` is a `KernelSymbol` id, which may or may not also
   * appear in `endpoints`/`symbols` below — see {@link
   * WiringGraphIssue}'s `unanchoredGuardTarget` for what an absence there
   * means (report, don't judge).
   */
  readonly guards: readonly WiringGuardEntry[];
  /**
   * `divertsTo` strings that match no catalog entry's `key`. Never dropped
   * silently — a stale or externally-owned divert target still shows up here
   * rather than vanishing (see {@link projectWiringGraph}'s doc comment on
   * why a non-empty list here is not necessarily a bug).
   */
  readonly unresolvedDivertTargets: readonly string[];
  /**
   * `boundSymbolIds` entries that are neither a catalog entry's own `key` nor
   * referenced by any stage's `symbolId` — the symmetric twin of {@link
   * unresolvedDivertTargets}: that field is "referenced but unresolved", this
   * one is "bound but unlisted". `projectWiringGraph` already receives every bound
   * id, so silently dropping the ones the catalog never mentions would be the
   * same failure `unresolvedDivertTargets` exists to avoid, just on the other
   * side of the fold. `[]` when every bound id is accounted for. A non-empty
   * list is not necessarily a bug — a bound port member with no `Pipe` behind
   * it (a plain Mutator, deliberately never `describePipe`d) and a leaf symbol
   * only reachable through an uncatalogued fork branch are both real,
   * different reasons a bound id can end up here; telling them apart needs
   * information this module does not have (why the catalog omits it), so it
   * is not attempted — same "report, don't judge" discipline as {@link
   * validateWiringGraph}'s `orphanEntry` check.
   */
  readonly unlistedBoundSymbols: readonly string[];
}

/** Every stage in `stages`, plus every stage nested in a `fork`'s `branches`
 * AND its `untrackedBranches`, recursively. Untracked (detached) branches are folded in exactly like tracked ones:
 * a detached branch's `symbolId`/`divertsTo` are real graph edges (a symbol it
 * invokes, a flow it diverts to), so omitting them would silently drop those
 * edges — the precise "silent absence" defect this project rejects. */
function flattenStages(stages: readonly StageDescriptor[]): readonly StageDescriptor[] {
  const flat: StageDescriptor[] = [];
  for (const stage of stages) {
    flat.push(stage);
    for (const branch of stage.branches ?? []) {
      flat.push(...flattenStages(branch));
    }
    for (const branch of stage.untrackedBranches ?? []) {
      flat.push(...flattenStages(branch));
    }
  }
  return flat;
}

/** Get-or-create the `Set` at `key` in `map`, add `value`, and write it back — the
 * "collect referrers, deduped" shape shared by `divertedFrom`/`symbolUsage`/`referrers` below. */
function addToSetMap<K>(map: Map<K, Set<string>>, key: K, value: string): void {
  const set = map.get(key) ?? new Set<string>();
  set.add(value);
  map.set(key, set);
}

/**
 * Fold a `PipeDescriptorEntry` catalog into one JSON-serializable
 * `WiringGraphDocument`, scoped to wiring
 * topology (no bindings/git metadata, no static-scan
 * sections). `kind` is computed purely from `Pipe.descriptors` (already on
 * each entry) and `boundSymbolIds` (already on `KernelBuilder`) — no new
 * runtime tracking.
 *
 * `divertedFrom`/`unresolvedDivertTargets` fold `StageDescriptor.divertsTo`
 * against every entry's `key`. This is a convention-level match, not a
 * checked one: `divertsTo` is author-typed free text (`pipe.ts`'s own doc
 * comment on `divertsTo`), with no compile-time or run-time link to any
 * `key`. A mismatch between the two never throws — it just lands in
 * `unresolvedDivertTargets` — so a non-empty `unresolvedDivertTargets` means
 * either a stale/typo'd `divertsTo` entry or a deliberately uncatalogued
 * external target, not necessarily a bug.
 *
 * @param guardCatalog `KernelBuilder.guardCatalog`, taken verbatim into
 * `doc.guards` (fold execution order preserved, never re-sorted — see
 * `GuardCatalogEntry`'s own doc comment on why that order is a behavioral
 * contract, not cosmetic). Required, not optional-with-a-`[]`-default: an
 * optional parameter would make "this app wires zero gates" indistinguishable
 * from "the caller forgot to pass guardCatalog" once read back from the v6
 * document — exactly the silent-absence failure this feature exists to kill.
 * A caller with genuinely no gates passes `[]` explicitly; the compile-time
 * noise this adds at every existing call site is the point, not an accident.
 */
export function projectWiringGraph(
  catalog: readonly PipeDescriptorEntry[],
  boundSymbolIds: ReadonlySet<string>,
  guardCatalog: readonly WiringGuardEntry[],
): WiringGraphDocument {
  const keys = new Set(catalog.map((entry) => entry.key));
  const flatByEntry = catalog.map((entry) => flattenStages(entry.stages));

  const divertedFrom = new Map<string, Set<string>>();
  const unresolved: string[] = [];
  const seenUnresolved = new Set<string>();
  catalog.forEach((entry, i) => {
    for (const stage of flatByEntry[i]!) {
      for (const target of stage.divertsTo) {
        if (keys.has(target)) {
          addToSetMap(divertedFrom, target, entry.key);
        } else if (!seenUnresolved.has(target)) {
          seenUnresolved.add(target);
          unresolved.push(target);
        }
      }
    }
  });

  const symbolUsage = new Map<string, Set<string>>();
  catalog.forEach((entry, i) => {
    for (const stage of flatByEntry[i]!) {
      if (stage.symbolId !== undefined) {
        addToSetMap(symbolUsage, stage.symbolId, entry.key);
      }
    }
  });

  const endpoints: WiringEndpoint[] = catalog.map((entry) => ({
    key: entry.key,
    title: entry.title,
    kind: boundSymbolIds.has(entry.key) ? 'endpoint' : 'divertTarget',
    note: entry.note,
    divertedFrom: [...(divertedFrom.get(entry.key) ?? [])],
    stages: entry.stages,
  }));

  const symbols: WiringSymbolEntry[] = [...symbolUsage.entries()].map(([symbolId, users]) => ({
    symbolId,
    bound: boundSymbolIds.has(symbolId),
    usedByEndpoints: [...users],
  }));

  // Symmetric to `unresolved` above, but the other direction: a bound id that
  // names neither a catalog key nor a referenced stage symbol. Order follows
  // `boundSymbolIds` iteration order (insertion order, since it is backed by a
  // `Map`) — deterministic without an arbitrary sort imposed here.
  const unlistedBoundSymbols = [...boundSymbolIds].filter(
    (id) => !keys.has(id) && !symbolUsage.has(id),
  );

  return {
    schemaVersion: 6,
    endpoints,
    symbols,
    guards: guardCatalog,
    unresolvedDivertTargets: unresolved,
    unlistedBoundSymbols,
  };
}

// MARK: - WiringGraphIssue (reusable validation over an already-projected document)

/**
 * One problem `validateWiringGraph` found in a projected `WiringGraphDocument`:
 * `unresolvedDivertTarget` — a `divertsTo`
 * string names no real catalog key; `orphanEntry` — a non-`'endpoint'` key has
 * no referrer other than itself; `unlistedBoundSymbol` —
 * a straight echo of `doc.unlistedBoundSymbols` — one issue per entry, always,
 * never filtered here (see that field's own doc comment on why judging actionability needs
 * information this module does not have); `unanchoredGuardTarget` — a
 * `doc.guards[].targetId` that matches neither an `endpoints[].key` nor a
 * `symbols[].symbolId` — "known" here means exactly that: nothing in the
 * projected document names the target at all, guarded or not. `guard()`
 * targets are plain `KernelSymbol`s, and a symbol may legitimately be bound
 * and guarded without ever appearing in a catalogued `Pipe` (the same reason
 * `unlistedBoundSymbol` exists) — so this is reported, not judged, same
 * discipline as the other two checks below.
 */
export interface WiringGraphIssue {
  readonly kind: 'unresolvedDivertTarget' | 'orphanEntry' | 'unlistedBoundSymbol' | 'unanchoredGuardTarget';
  readonly key: string;
  /** `unresolvedDivertTarget` only: catalog entry keys whose stage tree names this key in `divertsTo`. */
  readonly referrers?: readonly string[];
}

/**
 * Validate an already-projected `WiringGraphDocument` (four checks — see {@link
 * WiringGraphIssue}). Never throws: an empty array means clean, same "surface data, let the
 * caller assert" idiom `unresolvedDivertTargets` itself already uses — a consumer writes its own
 * `expect(validateWiringGraph(doc)).toEqual([])`.
 *
 * Needs no new topology tracking beyond what {@link projectWiringGraph} already computed: the
 * `unresolvedDivertTarget` check re-reads `doc.unresolvedDivertTargets` (only re-walking `stages`
 * to attribute *which* entries named each unresolved key, since the document doesn't store that);
 * the `orphanEntry` check re-reads each endpoint's own `divertedFrom`, filtering out the endpoint's
 * own key — `projectWiringGraph`'s `divertedFrom` fold does not exclude self-`divertsTo` (e.g. a
 * continuation loop that diverts back to its own key), so an endpoint whose only "referrer" is
 * itself must not count as referenced. `projectWiringGraph` itself keeps the self-edge (a graph
 * panel still needs to render a self-loop edge); only this check applies the exclusion. The
 * `unlistedBoundSymbol` check re-reads `doc.unlistedBoundSymbols` verbatim — no re-walk needed,
 * since (unlike the divert check) that field already names the bound id itself, not something a
 * caller has to attribute after the fact.
 *
 * **Documented ceiling**: a `divertsTo` string that names a *real
 * but wrong* catalog key (an author-swapped, valid-looking reference) is indistinguishable from a
 * correct one to both checks — exactly that mistake has passed both checks silently in practice.
 * No compile-time mechanism closes this either — a divert's destination is
 * decided at runtime, so static derivation is impossible in principle.
 *
 * **`orphanEntry` assumes the catalog is a complete enumeration of the app's real dispatch
 * surface.** A curated-subset catalog (e.g.
 * only the pipes a devtools panel bothers to visualize) will report false-positive orphans for
 * every entry not chosen to demonstrate divert wiring. Whether that's actionable is a
 * given consumer's own call, not assumed here.
 *
 * **`unlistedBoundSymbol` reports every entry unconditionally — it does not attempt to classify
 * causes.** A bound port member with no `Pipe` behind it (a deliberate plain Mutator) and
 * a bound leaf symbol only reachable through a fork branch family the catalog never constructs are
 * both real, and this module cannot tell them apart (that needs source-level information this
 * module never sees). Distinguishing and, where warranted, promoting an entry to a first-class
 * catalog citizen is a consumer/scanner concern; whether an
 * unclassified entry is actionable at all is a further-downstream consumer call — same
 * "report, don't judge" discipline as `orphanEntry`.
 *
 * **`unanchoredGuardTarget` needs one new lookup**: whether each `doc.guards[].targetId` matches
 * an `endpoints[].key` or a `symbols[].symbolId` — both already computed by {@link
 * projectWiringGraph}, so this is a membership check over existing document arrays, not a
 * re-walk of `stages`. Same "report, don't judge" discipline as `unlistedBoundSymbol`: a guarded
 * target absent from both is not assumed to be a mistake (see {@link WiringGraphIssue}'s own doc
 * comment on why a guarded, bound, uncatalogued `KernelSymbol` is a legitimate shape).
 */
export function validateWiringGraph(doc: WiringGraphDocument): readonly WiringGraphIssue[] {
  const issues: WiringGraphIssue[] = [];

  for (const key of doc.unlistedBoundSymbols) {
    issues.push({ kind: 'unlistedBoundSymbol', key });
  }

  if (doc.unresolvedDivertTargets.length > 0) {
    const unresolvedSet = new Set(doc.unresolvedDivertTargets);
    const referrers = new Map<string, Set<string>>();
    for (const endpoint of doc.endpoints) {
      for (const stage of flattenStages(endpoint.stages)) {
        for (const target of stage.divertsTo) {
          if (!unresolvedSet.has(target)) continue;
          addToSetMap(referrers, target, endpoint.key);
        }
      }
    }
    for (const key of doc.unresolvedDivertTargets) {
      issues.push({ kind: 'unresolvedDivertTarget', key, referrers: [...(referrers.get(key) ?? [])] });
    }
  }

  for (const endpoint of doc.endpoints) {
    if (endpoint.kind === 'endpoint') continue;
    const externalReferrers = endpoint.divertedFrom.filter((key) => key !== endpoint.key);
    if (externalReferrers.length === 0) {
      issues.push({ kind: 'orphanEntry', key: endpoint.key });
    }
  }

  const endpointKeys = new Set(doc.endpoints.map((endpoint) => endpoint.key));
  const symbolIds = new Set(doc.symbols.map((symbol) => symbol.symbolId));
  for (const guard of doc.guards) {
    if (!endpointKeys.has(guard.targetId) && !symbolIds.has(guard.targetId)) {
      issues.push({ kind: 'unanchoredGuardTarget', key: guard.targetId });
    }
  }

  return issues;
}
