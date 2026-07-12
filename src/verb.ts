import type { Kernel } from './kernel.js';
import type { Pipe } from './pipe.js';
import type { Span } from './span.js';

// MARK: - Verb

/**
 * The control word a pipeline stage returns instead of a bare value.
 *
 * Mental model: UNIX pipe. `next` is the implicit "write to stdout, keep
 * flowing"; the other three are explicit terminators. Only `next` *feeds a
 * downstream stage*, so only `next` carries a statically-pinned `F` type (the
 * next stage's payload). The terminators discard the rest of the pipe, so
 * their value never lands in a typed payload slot; it leaves once, through the
 * single boundary cast in `Kernel`'s interpreter. That is why they are erased
 * to `unknown` without losing any guarantee that ever existed.
 *
 * Swift's `Verb<Forward>` enum, translated to a discriminated union. Swift's
 * `.erased()` has no runtime counterpart here: `Verb<F>` is structurally
 * assignable to `Verb<unknown>` (only `next.value` is typed, covariantly), so
 * erasure is purely a type-level widening.
 */
export type Verb<F> =
  /** Continue: `F` becomes the next stage's payload. */
  | { readonly kind: 'next'; readonly value: F }
  /** Normal early termination: stop here, this value is the pipe's result. */
  | { readonly kind: 'abort'; readonly value: unknown }
  /**
   * Drop the remaining stages and run another pipe instead; its result
   * becomes this pipe's result.
   */
  | { readonly kind: 'divert'; readonly diversion: Diversion }
  /** Abnormal termination: throw out of the pipe / `call`. */
  | { readonly kind: 'fail'; readonly error: unknown };

/**
 * Continue with `value` as the next stage's payload.
 *
 * The zero-argument overload continues a pipe that carries no value —
 * `Verb<void>`, not `Verb<undefined>`. Both spellings run identically (the
 * erased `value` is `undefined` either way); the difference is what the NEXT
 * stage's cursor type is called, and therefore what introspection reports for
 * `StageEntry.flows`. Without this
 * overload a `void` gate had to write `next(undefined)`, which infers
 * `F = undefined` and made a `Pipe<void, void>`'s own gate stage report a
 * cursor type of `"undefined"` — an honest reading of a type the author never
 * meant to write, and one a consumer easily misreads as "not scanned" (`flows`
 * is `null` for that). `next()` lets the intent BE the type.
 */
export function next(): Verb<void>;
export function next<F>(value: F): Verb<F>;
export function next(value?: unknown): Verb<unknown> {
  return { kind: 'next', value };
}

/**
 * Terminate normally with `value` as the pipe's result. Returns `Verb<never>`
 * so it is assignable to any `Verb<F>` — a terminator feeds no downstream
 * stage, so it carries no forward type.
 */
export function abort(value: unknown): Verb<never> {
  return { kind: 'abort', value };
}

/** Drop the remaining stages and run `target` instead. */
export function divert(target: Diversion): Verb<never> {
  return { kind: 'divert', diversion: target };
}

/** Terminate abnormally: `error` is thrown out of the pipe / `call`. */
export function fail(error: unknown): Verb<never> {
  return { kind: 'fail', error };
}

// MARK: - Diversion

/**
 * One erased pipeline step — the minimal internal representation a
 * `Diversion` (and a sealed `Pipe`) is made of. Deliberately the
 * same shape as `ErasedHandler` plus the flowing value: `PipeBuilder`
 * compiles each typed stage down to one of these, so the kernel's iterative
 * stage runner needs no other vocabulary.
 *
 * (Swift counterpart: `PipeStage.run`. The `descriptor` half of `PipeStage`
 * is introspection metadata — `StageDescriptor` in this port.)
 *
 * `parentSpan` ([[span.ts]]): the span a symbol-backed stage's
 * `kernel.invoke` call should mint its own span under. Optional and additive —
 * a hand-rolled two-argument stage (built for `diversion(stages, payload)`)
 * is still a valid `ErasedStage`; it simply never sees a
 * parent. Anonymous verb stages (`.pipe(meta, fn)`) ignore it: they run their
 * closure directly, never through `invoke`, so there is no span to mint.
 */
export type ErasedStage = (
  kernel: Kernel,
  value: unknown,
  parentSpan?: Span,
) => Verb<unknown> | Promise<Verb<unknown>>;

/**
 * A fully-formed "jump target" for `divert`: another pipe's stages plus the
 * payload to start it with, packaged so the running pipe needn't know its
 * input type. Deliberately plain data (not a closure over `Kernel`) — this is
 * what lets the stage runner splice a diverted-to pipe straight into its own
 * iteration loop and keep going, rather than recursing. A pipe that diverts
 * back to a pipe shaped like itself (an agent/stream-processing loop) costs
 * O(1) stack frames this way, no matter how many hops the loop takes.
 *
 * The output is erased to `unknown` here and re-typed at the `call`/`compose`
 * boundary, exactly like every other terminator — the diverted pipe's result
 * is never consumed by an upstream stage, so there is no chain constraint to
 * enforce.
 */
export interface Diversion {
  readonly stages: readonly ErasedStage[];
  readonly payload: unknown;
}

/**
 * Package a jump target.
 *
 * The typed shape — `diversion(pipe, payload)` — is the Swift
 * `Diversion.init(_:_:)` counterpart: the payload is checked against the
 * pipe's `Input`, the usual idiom being
 * `divert(diversion(otherPipe, payload))`. The raw shape
 * (`ErasedStage[]` + payload) remains for machinery that assembles stage
 * lists by hand.
 */
export function diversion(stages: readonly ErasedStage[], payload: unknown): Diversion;
export function diversion<I>(pipe: Pipe<I, unknown>, payload: I): Diversion;
export function diversion(
  target: readonly ErasedStage[] | Pipe<never, unknown>,
  payload: unknown,
): Diversion {
  return Array.isArray(target)
    ? { stages: target as readonly ErasedStage[], payload }
    : { stages: (target as Pipe<never, unknown>).erasedStages, payload };
}
