import type { Kernel } from './kernel.js';
import type { Verb } from './verb.js';

// MARK: - GateError

export type GateErrorCode = 'duplicateGateId';

/**
 * The gate id ledger's own failure vocabulary — a *wiring-time programming
 * error*, never a runtime input, the same policy as `KernelError`/
 * `CallableError`/`BufferError` (TS has no process-trapping precondition, so
 * the same class of programming error surfaces as an immediate throw at the
 * second `declareGate`, where the stack names the offender).
 *
 * - `'duplicateGateId'` — a second `declareGate` minted the same id. Unlike
 *   `callable.ts`'s `mintedCallableIds` (which tolerates a same-*prefix*
 *   re-declare — one protocol legitimately re-expanding in one compiler
 *   process), `declareGate` takes a bare id with no prefix to distinguish a
 *   legitimate re-declare from a real collision — so every re-declare of the
 *   same id is treated as one. `id` is the join key threading one gate
 *   through `KernelBuilder.guardCatalog` (static), the runtime trace (as
 *   `symbolId`, once the gate runs through `invoke`), and the handler-table
 *   entry `KernelBuilder.build()`'s compose pass registers it under — two
 *   different closures answering to the same id would make all three lie
 *   about which gate actually ran.
 */
export class GateError extends Error {
  override readonly name = 'GateError';
  readonly code: GateErrorCode;
  /** The gate id the failure is about. */
  readonly gateId: string;

  constructor(code: GateErrorCode, gateId: string, message: string) {
    super(message);
    this.code = code;
    this.gateId = gateId;
  }
}

// MARK: - Gate / GateRef

/**
 * A verdict function guarding a target symbol: `next` — with or without a
 * value, see `declareGate`'s own doc comment on why the value is ignored in
 * v1 — allows the guarded handler to run; `divert`/`fail` vetoes it,
 * short-circuiting with that verb instead. `abort` that can forge a
 * meaningful `O` is discouraged (it reads as "the target actually ran and
 * produced this" when it did not — `fail`/`divert` say "vetoed" honestly);
 * but for an `O = void` bus-entry target, where "silently ignore" already
 * *is* the contract, `abort(undefined)` forges nothing and is the honest
 * veto — `fail` would fabricate an error that never happened, and `divert`
 * needs a destination this veto has none of. Not structurally blocked either
 * way; nothing here stops it.
 *
 * Same shape as a `registerVerb`-bound handler's own signature
 * (`(kernel, payload) => Verb<O> | Promise<Verb<O>>`, erased) — a gate *is*
 * a verb-returning handler in every respect that matters at runtime;
 * `declareGate` mints it under `guard`'s own vocabulary instead of
 * `KernelBuilder.registerVerb`'s only so a gate is never confused with (or
 * directly `call`able as) an ordinary symbol.
 */
export type Gate<P> = (kernel: Kernel, payload: P) => Verb<unknown> | Promise<Verb<unknown>>;

/**
 * What `declareGate` returns: the id `KernelBuilder.guard`/`guardCatalog`
 * and the runtime trace all join on, plus the erased gate closure
 * `KernelBuilder.build()`'s compose pass reads directly when it registers
 * the gate into the handler table and folds it in front of a guarded
 * target.
 *
 * Structurally similar to `KernelSymbol`/`DispatchKey` (an id-carrying,
 * phantom-typed token minted once and referenced from two otherwise
 * unconnected places) but deliberately not a `KernelSymbol` itself — a gate
 * is never something app code `call`s directly; it only ever runs as a step
 * inside a guarded target's fold wrapper (see kernel.ts's `gatedHandler`).
 */
export interface GateRef<P> {
  readonly id: string;
  /**
   * @internal Not part of the public API — only `KernelBuilder`'s build-time
   * gate compose pass (`#composeGates`, same package, different module)
   * reads this, to register the gate id and to build the fold wrapper.
   * Unlike `KernelSymbol.__phantom`/`DispatchKey.__phantom`, this field
   * genuinely exists at runtime — it *is* how the gate runs — so `@internal`
   * here means only "stripped from the emitted `.d.ts`" (`stripInternal`),
   * not "absent at runtime" (mirrors `KernelBuilder.register`'s own
   * `@internal` overload, kept public-at-runtime for the same reason).
   */
  readonly gate: (kernel: Kernel, payload: unknown) => Verb<unknown> | Promise<Verb<unknown>>;
  /**
   * Phantom brand — **never present at runtime**. Contravariant only (a
   * `(payload: P) => void` shape, mirroring `DispatchKey.__phantom`): a gate
   * *consumes* a payload but has no typed "return" of its own to pin — its
   * verdict is erased to `Verb<unknown>`, same as every other terminator.
   */
  readonly __phantom?: (payload: P) => void;
}

// MARK: - declareGate

/**
 * Every id ever minted by `declareGate` — the collision ledger, same
 * module-level-`Set` shape as `buffer.ts`'s `defineState` ledger (not
 * `callable.ts`'s `mintedCallableIds` map: there is no prefix here to
 * distinguish a legitimate re-declare from a real one — see `GateError`'s
 * own doc comment on why every re-declare of a bare id counts as real).
 */
const mintedGateIds = new Set<string>();

/**
 * Declare a named gate. `id` is the join key between `KernelBuilder.
 * guardCatalog` (static), the runtime trace (the gate runs through the
 * ordinary `invoke` chokepoint once folded in — see `guardCatalog`'s doc
 * comment on the zero-`TraceEntry`-schema-change consequence of that), and
 * the handler-table entry `KernelBuilder.build()`'s compose pass registers
 * it under. Convention (**not enforced structurally**): namespace gate ids
 * under `'guard:'`, e.g. `declareGate('guard:auth', ...)` — nothing stops a
 * differently-prefixed id from working identically, the prefix exists only
 * to keep a gate id visually distinct from a symbol id when both appear
 * side by side (a trace entry, a `guardCatalog` dump).
 *
 * A second `declareGate` with the same id throws `GateError`
 * (`'duplicateGateId'`) immediately, at the second call — real collision,
 * the same "throw at the mint site, where the stack names the offender"
 * discipline `callable.ts`'s `mintedCallableIds` uses for a cross-prefix
 * collision (see `GateError`'s own doc comment on why *every* re-declare
 * counts here, not only a cross-prefix one).
 *
 * **`next(value)`'s `value` is ignored in v1**: any `next` — with or
 * without a payload — means "allow", and the guarded target's handler then
 * runs with the call's *original* payload, never a gate's `next` value.
 * Payload-rewrite-on-allow is reserved for a future version; a gate author
 * relying on `next(v)` to change what the target sees would silently have
 * `v` dropped today, so don't rely on it.
 */
export function declareGate<P>(id: string, gate: Gate<P>): GateRef<P> {
  if (mintedGateIds.has(id)) {
    throw new GateError(
      'duplicateGateId',
      id,
      `Gate id '${id}' is already declared — declareGate ids must be unique`,
    );
  }
  mintedGateIds.add(id);
  return {
    id,
    gate: gate as (kernel: Kernel, payload: unknown) => Verb<unknown> | Promise<Verb<unknown>>,
  };
}

// MARK: - guardCatalog (MVP enumerability)

/**
 * One guarded target in `KernelBuilder.guardCatalog` — the target's symbol
 * id plus the gate ids that run before it, in **fold execution order**: the
 * order `guard()` calls accumulated for this target, which is also the
 * exact order `KernelBuilder.build()`'s compose pass folds them in (the
 * first non-`next` verdict short-circuits the rest, so this order is a real
 * behavioral contract, not merely cosmetic — see kernel.ts's `gatedHandler`).
 * Mirrors `PipeDescriptorEntry`'s role for `flowCatalog`: a static,
 * JSON-friendly projection of builder-time wiring, readable without a
 * running kernel or a trace.
 */
export interface GuardCatalogEntry {
  readonly targetId: string;
  readonly gateIds: readonly string[];
}
