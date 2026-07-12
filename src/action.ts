import type { KernelSymbol } from './symbol.js';
import type { CallableSpec, Port } from './callable.js';

// MARK: - Action

/**
 * A deferred command as *data*: one symbol paired with its payload. The Redux
 * `dispatch(action)` idiom, translated — the symbol plays the action `type`,
 * the payload rides alongside, and `Kernel.dispatch(action)` is the store's
 * `dispatch`.
 *
 * This is a TS-only convenience with no Swift counterpart: it adds no new
 * capability over `dispatch(sym, payload)` — it only lets a call site *build*
 * the command where the intent lives and *fire* it somewhere else (an event
 * handler holding one generic dispatcher). Both halves stay plain data, which
 * is the whole architecture ("control is data"): an action is inert until it
 * meets a kernel, so it can be constructed, passed around, logged, or asserted
 * on in tests without touching the mesh.
 *
 * Deliberately *not* a thunk: pairing the symbol with a payload keeps the
 * command serializable-in-spirit and introspectable (the symbol carries its
 * id/description); a function would be opaque to both.
 */
export interface Action<P, O> {
  /** The endpoint to dispatch to — the action's `type`, as a typed symbol. */
  readonly sym: KernelSymbol<P, O>;
  /** The payload `dispatch` will hand to the bound handler. */
  readonly payload: P;
}

// MARK: - Action creators

/**
 * The action-creator record a spec derives: one creator per spec key, typed
 * by the marker's payload (`SimActions.setSpeed(30)` compiles,
 * `SimActions.setSpeed('fast')` does not). A `void`-payload port derives a
 * no-argument creator (`SimActions.play()`), mirroring `Kernel.call`'s own
 * void-payload sugar.
 */
export type ActionCreators<Spec extends CallableSpec> = {
  readonly [K in keyof Spec]: Spec[K] extends Port<infer P, infer O>
    ? [P] extends [void]
      ? () => Action<void, O>
      : (payload: P) => Action<P, O>
    : never;
};

/** Sugar mirroring {@link CallableDeviceOf}: recover the creators from the callable value alone. */
export type ActionCreatorsOf<C extends { readonly __spec?: CallableSpec }> = ActionCreators<
  NonNullable<C['__spec']>
>;

/**
 * Derive action creators from a callable — the fourth thing the spec's single
 * denominator yields (after symbols, the device type, and `wire`): creators
 * cannot drift from the ports because they are *made of* the generated
 * symbols.
 *
 * ```ts
 * export const SimActions = actionsOf(SimPort);   // contract, next to the port
 *
 * dispatch(SimActions.setSpeed(30));              // view: redux-shaped fire
 * dispatch(SimActions.play());                    // void payload → no-arg creator
 * ```
 *
 * Creators are pure and the record is frozen, so `actionsOf` results are
 * module-level constants — idiomatically minted once in the contract module,
 * right where the callable itself lives.
 */
export function actionsOf<C extends { readonly __spec?: CallableSpec }>(
  callable: C,
): ActionCreatorsOf<C> {
  const creators: Record<string, (payload?: unknown) => Action<unknown, unknown>> = {};
  for (const [key, value] of Object.entries(callable as Record<string, unknown>)) {
    if (typeof value === 'function') continue; // the generated `wire`
    const sym = value as KernelSymbol<unknown, unknown>;
    creators[key] = (payload?: unknown) => ({ sym, payload });
  }
  return Object.freeze(creators) as unknown as ActionCreatorsOf<C>;
}
