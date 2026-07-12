import { KernelBuilder, type Kernel } from './kernel.js';
import { symbol, type KernelSymbol } from './symbol.js';
import type { Verb } from './verb.js';

// MARK: - CallableError

export type CallableErrorCode = 'duplicateSymbolId' | 'reservedMethodName' | 'missingImplementation';

/**
 * The port-declaration failure vocabulary. All three codes mark a *wiring-time
 * programming error*, never a runtime input — the same policy as
 * `KernelError` / `BufferError` (Swift surfaces these as macro-expansion
 * compile errors; TS has no compile-time hook, so the same programming error
 * throws at module evaluation / wire time, where the stack names the
 * offender):
 *
 * - `'duplicateSymbolId'` — two `defineCallable` calls minted the same
 *   `"prefix.method"` id. Swift's macro plugin keeps a `SymbolIDRegistry` and
 *   emits a compile *error* (left undetected, the second `wire` would collide
 *   in `KernelBuilder` — here it would throw `'duplicate'` only on the cold
 *   path where both are actually wired; the mint site is earlier and always
 *   runs).
 * - `'reservedMethodName'` — a spec key that collides with the generated
 *   surface (`wire`, `__spec`). Swift has no equivalent hazard: the generated
 *   `wire` lives on an enum, not next to the symbols.
 * - `'missingImplementation'` — `wire` found no function for a spec key. Only
 *   reachable past a type-system escape hatch (an `as` cast); the typed
 *   `wire` signature makes this a compile error first.
 */
export class CallableError extends Error {
  override readonly name = 'CallableError';
  readonly code: CallableErrorCode;
  /** The symbol id the failure is about. */
  readonly symbolId: string;

  constructor(code: CallableErrorCode, symbolId: string, message: string) {
    super(message);
    this.code = code;
    this.symbolId = symbolId;
  }
}

// MARK: - Port markers

/**
 * Which of the four handler shapes a spec entry binds as — the runtime
 * discriminator behind {@link port} / {@link portK} / {@link portV} /
 * {@link portKV}.
 *
 * Swift derives the same 2×2 from the method signature itself: a leading
 * `Kernel` parameter marks a composing handler (the macro checks the first
 * parameter's type), and a `Verb<O>` return type selects the verb-returning
 * `register` overload implicitly (Swift overloads `register` on return type;
 * TS split it into `register`/`registerVerb` by name). TS cannot read either
 * from a type, so the declaration site says it with a marker — which is also
 * *more* robust than the runtime `fn.length >= 2` discrimination: `wire`
 * synthesizes its registration closures with the marker's arity, so a device
 * method that elides a trailing `void` payload (`reset: (kernel) => …`,
 * `fn.length === 1`) still binds as composing.
 */
export type PortKind = 'port' | 'portK' | 'portV' | 'portKV';

/**
 * One method requirement in a `defineCallable` spec: the marker kind, the doc
 * (lifted into the generated symbol's `description`), and a phantom pinning
 * the payload/output types. The TS translation of one function requirement in
 * a Swift `@callable` protocol.
 */
export interface Port<in P, out O, out K extends PortKind = PortKind> {
  readonly portKind: K;
  /** The requirement's documentation — `undefined` when undocumented. */
  readonly doc: string | undefined;
  /**
   * Phantom brand — **never present at runtime**. Mirrors
   * `KernelSymbol.__phantom`: `P` contravariant, `O` covariant.
   */
  readonly __phantom?: (payload: P) => O;
}

/**
 * Declare a *leaf, value-returning* requirement: `(payload) => O | Promise<O>`
 * on the device. Swift: `func m(_ p: P) async throws -> O`.
 *
 * `doc` becomes the generated symbol's `description` — pass it explicitly
 * (TS cannot read a JSDoc comment at runtime, so the doc is an argument where
 * Swift lifts the `///` comment). Omitted or blank, `defineCallable` warns
 * (Swift's `UndocumentedCallable` diagnostic is a *warning*, so the TS
 * translation warns rather than throws) and the symbol carries no description.
 */
export function port<P, O>(doc?: string): Port<P, O, 'port'> {
  return { portKind: 'port', doc };
}

/**
 * Declare a *composing (kernel-first), value-returning* requirement:
 * `(kernel, payload) => O | Promise<O>` on the device — the handler routes
 * back into the mesh, so the kernel is handed in at call time. Swift: a
 * leading `Kernel` parameter (`func m(_ kernel: Kernel, _ p: P) …`).
 */
export function portK<P, O>(doc?: string): Port<P, O, 'portK'> {
  return { portKind: 'portK', doc };
}

/**
 * Declare a *leaf, verb-returning* requirement:
 * `(payload) => Verb<O> | Promise<Verb<O>>` on the device — the handler owns
 * its own pipeline control (`next`/`abort`/`divert`/`fail`) and binds via
 * `registerVerb`. Swift needs no marker for this: `register` is overloaded on
 * the closure's return type, so a `Verb<O>`-returning method resolves to the
 * verb overload implicitly; TS split `register`/`registerVerb` by name, so
 * the split surfaces here as an explicit marker.
 */
export function portV<P, O>(doc?: string): Port<P, O, 'portV'> {
  return { portKind: 'portV', doc };
}

/**
 * Declare a *composing (kernel-first), verb-returning* requirement:
 * `(kernel, payload) => Verb<O> | Promise<Verb<O>>` — {@link portK} ×
 * {@link portV}, completing the same 2×2 Swift's four `register` overloads
 * span.
 */
export function portKV<P, O>(doc?: string): Port<P, O, 'portKV'> {
  return { portKind: 'portKV', doc };
}

// MARK: - Spec / derived types

/**
 * The shape `defineCallable` accepts: method name → port marker. The spec is
 * the TS translation of a `@callable` protocol's member block — and, exactly
 * as there, it is the *single source of truth*: symbols, the device type, and
 * the wiring are all derived from it, so no hand-maintained id list exists to
 * drift.
 */
export type CallableSpec = Record<string, Port<never, unknown>>;

/**
 * The device (implementation) type a spec demands — the TS translation of
 * "a type conforming to the `@callable` protocol". Derived per key from the
 * marker kind:
 *
 * - `port`   → `(payload: P) => O | Promise<O>`
 * - `portK`  → `(kernel: Kernel, payload: P) => O | Promise<O>`
 * - `portV`  → `(payload: P) => Verb<O> | Promise<Verb<O>>`
 * - `portKV` → `(kernel: Kernel, payload: P) => Verb<O> | Promise<Verb<O>>`
 *
 * A `void` payload needs no parameter at the implementation site — a
 * fewer-parameter function is assignable, so `reset: (kernel) => …`
 * satisfies `portK<void, void>` (and still binds as composing: see
 * {@link PortKind}).
 */
export type CallableDevice<Spec extends CallableSpec> = {
  [K in keyof Spec]: Spec[K] extends Port<infer P, infer O, 'port'>
    ? (payload: P) => O | Promise<O>
    : Spec[K] extends Port<infer P, infer O, 'portK'>
      ? (kernel: Kernel, payload: P) => O | Promise<O>
      : Spec[K] extends Port<infer P, infer O, 'portV'>
        ? (payload: P) => Verb<O> | Promise<Verb<O>>
        : Spec[K] extends Port<infer P, infer O, 'portKV'>
          ? (kernel: Kernel, payload: P) => Verb<O> | Promise<Verb<O>>
          : never;
};

/** The typed symbol constants a spec generates: one `KernelSymbol<P, O>` per key. */
export type CallableSymbols<Spec extends CallableSpec> = {
  readonly [K in keyof Spec]: Spec[K] extends Port<infer P, infer O> ? KernelSymbol<P, O> : never;
};

/**
 * Exact-object guard for `wire`: TS structural subtyping would let a device
 * with *extra* keys pass silently (Swift's `wire(_ device: any Protocol)`
 * genuinely allows extra members — but there the compiler has already matched
 * every requirement by name, so an extra member can't be a typo'd
 * requirement; in TS a typo'd key *is* an extra key plus a missing one, and
 * only the missing half would error). Every key of `D` beyond the spec is
 * forced to `never`, so an extra method fails to type-check even on a
 * non-fresh (already-typed) object where excess-property checking wouldn't
 * fire.
 */
type ExactDevice<Spec extends CallableSpec, D extends CallableDevice<Spec>> = D & {
  readonly [K in Exclude<keyof D, keyof Spec>]: never;
};

/**
 * What `defineCallable` returns — the TS translation of the macro-generated
 * `<Protocol>Callable` enum: the typed symbol per method, plus `wire`.
 */
export type Callable<Spec extends CallableSpec> = CallableSymbols<Spec> & {
  /**
   * Phantom brand — **never present at runtime**. Carries the spec type so
   * {@link CallableDeviceOf} can recover the device type from the callable
   * value alone (the idiomatic spec is an inline literal, so there is no
   * `typeof spec` to name).
   */
  readonly __spec?: Spec;
  /**
   * Register every requirement's implementation into `builder` — one
   * `register`/`registerVerb` per spec key, so a binding cannot be forgotten
   * (the totality Swift gets from protocol conformance). `device` must
   * implement *exactly* the spec: a missing key fails the
   * `CallableDevice<Spec>` constraint, an extra key fails the
   * {@link ExactDevice} guard.
   */
  readonly wire: <D extends CallableDevice<Spec>>(
    device: ExactDevice<Spec, D>,
    builder: KernelBuilder,
  ) => void;
};

/**
 * Recover the device type from a callable value:
 * `type LifeDevice = CallableDeviceOf<typeof LifePort>`. Sugar over
 * {@link CallableDevice} for the inline-spec idiom.
 */
export type CallableDeviceOf<C extends { readonly __spec?: CallableSpec }> = CallableDevice<
  NonNullable<C['__spec']>
>;

// MARK: - Symbol id ledger

/**
 * Every id ever minted by `defineCallable`, mapped to the prefix that claimed
 * it — the TS translation of the macro plugin's `SymbolIDRegistry`. Scope
 * matches Swift exactly: only `defineCallable`-minted ids are checked;
 * hand-minted `symbol(id)` calls are *not* in the ledger there either (the
 * registry lives in the macro plugin, not in `Symbol.init`). A collision
 * between a hand-minted symbol and a callable id still surfaces — later, as
 * `KernelBuilder`'s `'duplicate'` throw at the second `register`.
 *
 * Unlike Swift's registry, a re-claim by the *same* prefix also throws: the
 * macro tolerates it because one protocol can legitimately re-expand in one
 * compiler process, but a TS module evaluates once, so a second
 * `defineCallable` with the same prefix+method can only be a mistake.
 */
const mintedCallableIds = new Map<string, string>();

/** Spec keys that would collide with the generated surface. */
const reservedNames: ReadonlySet<string> = new Set(['wire', '__spec']);

// MARK: - defineCallable

/**
 * Declare a port — the TS translation of `@callable("Id.Prefix")` on a device
 * protocol. Mints one typed `KernelSymbol` per spec key
 * (id = `"prefix.key"`, description = the marker's `doc`) and a `wire` that
 * registers a device's implementations, one per key.
 *
 * ```ts
 * export const LifePort = defineCallable('Compute.Life', {
 *   stepChunk: port<ChunkInput, ChunkResult>('advance a row chunk one generation'),
 *   reset:     portK<void, void>('reset the board and generation'),
 * });
 *
 * LifePort.stepChunk               // KernelSymbol<ChunkInput, ChunkResult>
 * LifePort.wire(device, builder)   // one register per key — none can be forgotten
 * ```
 *
 * The spec is the single denominator; the totality triangle it closes:
 * 1. **forward** — `wire`'s `CallableDevice<Spec>` constraint forces every
 *    method to be implemented (Swift: protocol conformance).
 * 2. **reverse** — consumers can only call through the generated
 *    `LifePort.xxx` symbols (Swift: `any Protocol` use sites).
 * 3. **wire** — one `register` per spec key is generated, so no hand-written
 *    id list exists to drift (Swift: the macro-generated `wire(_:into:)`).
 *
 * Failure modes at mint time (module evaluation — the closest TS gets to
 * Swift's compile-time diagnostics):
 * - a cross-definition id collision throws `CallableError`
 *   (`'duplicateSymbolId'`) — Swift's `DuplicateSymbolID` compile error;
 * - a missing/blank `doc` warns via `console.warn` — Swift's
 *   `UndocumentedCallable` *warning* (hence not a throw), the symbol then
 *   carries no description (blank in the wiring graph);
 * - a reserved spec key (`wire`, `__spec`) throws `CallableError`
 *   (`'reservedMethodName'`).
 */
export function defineCallable<Spec extends CallableSpec>(prefix: string, spec: Spec): Callable<Spec> {
  const keys = Object.keys(spec);
  const ports = spec as Record<string, Port<never, unknown>>;
  const symbols: Record<string, KernelSymbol<unknown, unknown>> = {};

  for (const key of keys) {
    const id = `${prefix}.${key}`;
    if (reservedNames.has(key)) {
      throw new CallableError(
        'reservedMethodName',
        id,
        `defineCallable spec key '${key}' is reserved (would collide with the generated '${key}') — rename the method`,
      );
    }
    const owner = mintedCallableIds.get(id);
    if (owner !== undefined) {
      throw new CallableError(
        'duplicateSymbolId',
        id,
        `defineCallable symbol id '${id}' is also minted by '${owner}' — both would register under the same key, silently overwriting one in KernelBuilder`,
      );
    }
    mintedCallableIds.set(id, prefix);

    const doc = ports[key]?.doc?.trim();
    if (doc === undefined || doc === '') {
      console.warn(
        `[kernelee] defineCallable method '${id}' has no doc — its symbol will carry no description (blank in the wiring graph)`,
      );
    }
    symbols[key] = symbol(id, doc === '' ? undefined : doc);
  }

  const wire = (device: Record<string, (...args: readonly unknown[]) => unknown>, builder: KernelBuilder): void => {
    for (const key of keys) {
      const sym = symbols[key] as KernelSymbol<unknown, unknown>;
      if (typeof device[key] !== 'function') {
        // Only reachable past an `as` cast — the typed `wire` already forces
        // every key. Named here anyway so the escape hatch fails loud at wire
        // time, not as 'unbound' on a cold call path.
        throw new CallableError(
          'missingImplementation',
          sym.id,
          `wire: device has no implementation for '${key}' (symbol '${sym.id}')`,
        );
      }
      // Each closure is synthesized with the *marker's* arity (the same move
      // as the macro's generated `{ kernel, payload in device.m(kernel, payload) }`
      // closures), so KernelBuilder's `fn.length >= 2` leaf/composing
      // discrimination sees 1 or 2 declared parameters by construction —
      // regardless of how many the device method itself declares (a `void`
      // payload is typically elided there). Method-call syntax (`device[key](…)`)
      // keeps `this` bound for class-instance devices.
      switch (ports[key]?.portKind) {
        case 'port':
          builder.register(sym, (payload: unknown) => device[key]?.(payload));
          break;
        case 'portK':
          builder.register(sym, (kernel: Kernel, payload: unknown) => device[key]?.(kernel, payload));
          break;
        case 'portV':
          builder.registerVerb(sym, (payload: unknown) => device[key]?.(payload) as Verb<unknown>);
          break;
        case 'portKV':
          builder.registerVerb(
            sym,
            (kernel: Kernel, payload: unknown) => device[key]?.(kernel, payload) as Verb<unknown>,
          );
          break;
      }
    }
  };

  return Object.freeze({ ...symbols, wire }) as unknown as Callable<Spec>;
}
