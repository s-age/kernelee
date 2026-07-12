import type { KernelSymbol } from './symbol.js';
import type { Action } from './action.js';
import type { Pipe, PipeBuilder } from './pipe.js';
import { next, type ErasedStage, type Verb } from './verb.js';
import { mintSpan, type Span } from './span.js';
import { CommandBus } from './command-bus.js';
import { Buffer, BufferBuilder, KernelErrorState } from './buffer.js';
import { appendTraceEntry, describeTracePayload, TraceState, type TraceSink } from './trace.js';

// MARK: - KernelError

export type KernelErrorCode = 'unbound' | 'duplicate';

/**
 * The kernel's own failure vocabulary — part of the public contract.
 *
 * `call` rejects with whatever the bound handler threw, passing through
 * untouched; these codes are the only failures the *kernel itself* produces,
 * and both mark a wiring-time programming error rather than a runtime input:
 * catch them to distinguish "the machinery is miswired" from "the operation
 * failed".
 *
 * - `'unbound'` — no handler was wired for the symbol id (a forgotten
 *   `register`). Mirrors Swift `KernelError.unbound`.
 * - `'duplicate'` — a second `register` for an already-bound symbol id.
 *   Swift traps this with a `precondition`; TS has no process-trapping
 *   precondition, so the same programming error surfaces as an immediate
 *   throw at the second bind.
 *
 * Swift's `composeTypeMismatch` has no counterpart here: TS generics are
 * fully erased, so the terminator boundary cast is unchecked (see
 * `Kernel.#interpret`).
 */
export class KernelError extends Error {
  override readonly name = 'KernelError';
  readonly code: KernelErrorCode;
  /** The symbol id the failure is about — the caller already holds it. */
  readonly symbolId: string;

  constructor(code: KernelErrorCode, symbolId: string, message: string) {
    super(message);
    this.code = code;
    this.symbolId = symbolId;
  }
}

// MARK: - ErasedHandler

/**
 * The erased dispatch cell: what `KernelBuilder.register` mints when it fuses
 * a `KernelSymbol`'s phantom types with a concrete handler, and what the
 * kernel's handler table stores per symbol id.
 *
 * Deliberately *not* typed in `P`/`O` — those vary per symbol, so a single
 * homogeneous table can only hold the erased form (`unknown` in,
 * `Verb<unknown>` out). Type safety is *not* claimed here; it lives on the
 * `KernelSymbol` that pins both ends, re-applied at the typed
 * `call`/`register` boundary. The name states the role — an *erased* handler —
 * not a guarantee: `invoke` is the (erased) act of calling one, `call<P, O>`
 * is the typed wrapper around an `invoke`.
 */
export type ErasedHandler = (kernel: Kernel, payload: unknown) => Promise<Verb<unknown>>;

// MARK: - Builder

/** Options frozen into the kernel by `KernelBuilder.build`. */
export interface KernelBuildOptions {
  /**
   * Sink for failures of fire-and-forget commands (`Kernel.dispatch`).
   * `symbolId` is the id of the dispatched command that failed — the caller
   * already holds it, so it travels alongside the error rather than being
   * dropped. Omitted, failures are rendered into the buffer's
   * `KernelErrorState` cell as `"symbolId: message"` (Swift's
   * `defaultErrorSink`); an injected sink replaces that default entirely —
   * `KernelErrorState` then stays untouched.
   */
  onError?: (symbolId: string, error: unknown) => void;
  /**
   * The buffer wiring — the state-side counterpart of this builder. `build`
   * freezes it (`BufferBuilder.build()`, which seeds `KernelErrorState`, plus
   * `TraceState` when `tracing` is on) into the kernel's `buffer`. Omitted, an
   * empty `BufferBuilder` is used, so `kernel.buffer` always exists and
   * always holds `KernelErrorState`. One `BufferBuilder` is meant for one
   * `build()` call, same as `KernelErrorState`'s seeding: passing the *same*
   * instance to two `build()` calls with different `tracing` values leaks
   * the first call's `allocateIfAbsent` forward into the second (there is no
   * `deallocate`), so don't share one across kernels with different tracing
   * settings.
   */
  buffer?: BufferBuilder;
  /**
   * Master switch for trace recording. Default
   * `false`. Off, `Kernel.invoke` pays only the span-minting cost it already
   * pays unconditionally — no payload rendering, no
   * `Buffer.mutate` call. Unlike Swift's two-tier "record always in DEBUG,
   * gate only payload rendering/snapshot separately" split, TS has no
   * DEBUG/release build separation to make that split free, so one flag
   * gates the whole thing; a finer-grained toggle can be added if a concrete
   * need for it shows up.
   */
  tracing?: boolean;
  /**
   * Sink for trace entries (`Kernel.invoke` passes) when {@link tracing} is
   * on. Omitted, the default sink formats each call into a `TraceEntry`
   * (assigning its `id`) and `Buffer.mutate`s it into `kernel.buffer`'s
   * `TraceState` cell — same relationship as `onError`/`KernelErrorState`:
   * an injected sink replaces that default write entirely.
   */
  onTrace?: TraceSink;
  /** Default sink's ring size. Default 300 (Swift's `MonitorOptions.traceCap`). */
  traceCap?: number;
}

/**
 * Leaf/composing discrimination: a composing handler declares two parameters
 * (`(kernel, payload)`), a leaf declares at most one (`(payload)`).
 *
 * This reads `Function.prototype.length`, which counts only the parameters
 * **before the first default or rest parameter** — so a composing handler
 * written as `(kernel, payload = x) => …` reports length 1 and would be bound
 * as a leaf. Do not use default or rest parameters in handler signatures.
 */
function isComposing(handler: (...args: never[]) => unknown): boolean {
  return handler.length >= 2;
}

/**
 * Collects the symbol → handler bindings during app wiring. Wiring code
 * registers into a builder; once everything is wired, `build()` freezes the
 * bindings into an immutable `Kernel`.
 *
 * Splitting "register" (mutable, single-threaded startup) from "call"
 * (immutable, shared) is what lets `Kernel` be a plain frozen value:
 * registration is finished before the first call can happen.
 */
export class KernelBuilder {
  #handlers = new Map<string, ErasedHandler>();

  /**
   * The set of symbol ids currently bound. Read after wiring (before `build`)
   * by a wiring-exhaustiveness smoke test, which asserts it covers every
   * declared symbol id — turning a forgotten `register` from a runtime
   * `KernelError` (`'unbound'`) on a cold path into a CI failure.
   */
  get boundSymbolIds(): ReadonlySet<string> {
    return new Set(this.#handlers.keys());
  }

  /**
   * The single write point of the handler table — every register shape
   * funnels through here. Two bindings for one symbol id would silently
   * last-write-win, and which handler answers a symbol is the runtime half of
   * the architecture's guarantee, so a duplicate throws immediately at the
   * second register (where the stack names the offender) rather than
   * surfacing as the wrong device answering on some cold path. (Swift makes
   * this a `precondition` trap; the TS equivalent of "programming error,
   * never an input" is an unconditional throw.)
   */
  #bind(id: string, handler: ErasedHandler): void {
    if (this.#handlers.has(id)) {
      throw new KernelError('duplicate', id, `Symbol '${id}' is already bound — duplicate register`);
    }
    this.#handlers.set(id, handler);
  }

  /**
   * Bind a *value-returning* handler. The plain return is implicitly the
   * `next` verb.
   *
   * Two shapes, discriminated by declared parameter count (see
   * {@link isComposing} — default/rest parameters break the discrimination):
   * - **leaf** `(payload) => output` — fulfils the symbol on its own and makes
   *   no further kernel calls (e.g. a storage endpoint hitting its database).
   * - **composing** `(kernel, payload) => output` — receives the kernel so it
   *   can call other symbols. Passing the kernel at call time, rather than
   *   wiring it in, is what breaks the build-order cycle: the handler needs
   *   the kernel only when invoked, by which point `build()` has already
   *   produced it. With tracing on, what arrives is `invoke`'s span-scoped
   *   view — calls made through it trace as children of this handler's span
   *   (span linking), which is one more reason to call through the
   *   parameter rather than a kernel reference captured from outside.
   *
   * The public signature is fully typed; the unsafe `as` casts that erase to
   * `unknown` are confined here, and are safe because the same `KernelSymbol`
   * pins both ends.
   *
   * DX note: a *leaf* lambda gets its parameter type inferred from the
   * symbol; a *composing* lambda must annotate its parameters
   * (`(kernel: Kernel, n: number) => …`) — TS overload resolution decides
   * the overload before contextually typing a lambda argument, so the
   * two-parameter shape cannot be inferred. Mismatched annotations are still
   * compile errors; only the inference is lost.
   */
  register<P, O>(sym: KernelSymbol<P, O>, handler: (payload: P) => O | Promise<O>): void;
  register<P, O>(sym: KernelSymbol<P, O>, handler: (kernel: Kernel, payload: P) => O | Promise<O>): void;
  register<P, O>(
    sym: KernelSymbol<P, O>,
    handler: ((payload: P) => O | Promise<O>) | ((kernel: Kernel, payload: P) => O | Promise<O>),
  ): void {
    if (isComposing(handler)) {
      const h = handler as (kernel: Kernel, payload: P) => O | Promise<O>;
      this.#bind(sym.id, async (kernel, payload) => next(await h(kernel, payload as P)));
    } else {
      const h = handler as (payload: P) => O | Promise<O>;
      this.#bind(sym.id, async (_kernel, payload) => next(await h(payload as P)));
    }
  }

  /**
   * Bind a *verb-returning* handler — one that owns its own pipeline control:
   * it answers `next`/`abort`/`divert`/`fail` directly instead of a bare
   * value. In a pipe its verb drives the flow (e.g. a fetch that
   * `fail`s on a missing row); via `call` the verb is interpreted down to the
   * symbol's `O`.
   *
   * Same leaf/composing discrimination as {@link register} — and the same
   * caveat: default/rest parameters break it.
   *
   * (Swift overloads `register` on the handler's return type; TS overload
   * resolution cannot discriminate on return type reliably, hence the
   * separate name.)
   */
  registerVerb<P, O>(sym: KernelSymbol<P, O>, handler: (payload: P) => Verb<O> | Promise<Verb<O>>): void;
  registerVerb<P, O>(sym: KernelSymbol<P, O>, handler: (kernel: Kernel, payload: P) => Verb<O> | Promise<Verb<O>>): void;
  registerVerb<P, O>(
    sym: KernelSymbol<P, O>,
    handler:
      | ((payload: P) => Verb<O> | Promise<Verb<O>>)
      | ((kernel: Kernel, payload: P) => Verb<O> | Promise<Verb<O>>),
  ): void {
    if (isComposing(handler)) {
      const h = handler as (kernel: Kernel, payload: P) => Verb<O> | Promise<Verb<O>>;
      this.#bind(sym.id, async (kernel, payload) => h(kernel, payload as P));
    } else {
      const h = handler as (payload: P) => Verb<O> | Promise<Verb<O>>;
      this.#bind(sym.id, async (_kernel, payload) => h(payload as P));
    }
  }

  /**
   * Freeze the bindings into an immutable `Kernel`. The builder itself stays
   * usable, but the kernel takes a snapshot — later registers do not leak
   * into an already-built kernel.
   *
   * `TraceState` is allocated only when `tracing` is on
   * — unlike `KernelErrorState`, which `BufferBuilder.build()` seeds
   * unconditionally as a release feature, trace recording mirrors Swift's
   * monitor states existing only in DEBUG builds. The allocate happens here,
   * before the buffer freezes, since `KernelBuildOptions.tracing` is only
   * known at this call, not to `BufferBuilder` itself.
   */
  build(options: KernelBuildOptions = {}): Kernel {
    const bufferBuilder = options.buffer ?? new BufferBuilder();
    const tracing = options.tracing ?? false;
    if (tracing) {
      bufferBuilder.allocateIfAbsent(TraceState);
    }
    const buffer = bufferBuilder.build();
    const onError = options.onError ?? KernelBuilder.#defaultErrorSink(buffer);
    const onTrace = tracing ? (options.onTrace ?? KernelBuilder.#defaultTraceSink(buffer, options.traceCap ?? 300)) : undefined;
    return new Kernel(new Map(this.#handlers), onError, buffer, onTrace);
  }

  /**
   * The error sink `build` falls back to when the caller injects none: render
   * the failed command's symbol id and error message into `KernelErrorState`.
   * Swift's `defaultErrorSink`, verbatim (`"\(symbol): \(error.localizedDescription)"`
   * becomes `"symbolId: message"`) — `dispatch` swallows the error either way,
   * and a silently dropped failure is the worse default.
   */
  static #defaultErrorSink(buffer: Buffer): (symbolId: string, error: unknown) => void {
    return (symbolId, error) => {
      const message = error instanceof Error ? error.message : String(error);
      buffer.mutate(KernelErrorState, () => ({ message: `${symbolId}: ${message}` }));
    };
  }

  /**
   * The trace sink `build` falls back to when `tracing` is on and the caller
   * injects none: format the call into a `TraceEntry` (assigning its `id` —
   * see `appendTraceEntry`) and `Buffer.mutate` it into `TraceState`, trimmed
   * to `cap`.
   */
  static #defaultTraceSink(buffer: Buffer, cap: number): TraceSink {
    return (symbolId, verb, span, payload, timestamp) => {
      buffer.mutate(TraceState, (state) =>
        appendTraceEntry(state, { symbolId, verb, span, payload, timestamp }, cap),
      );
    };
  }
}

// MARK: - Kernel

/**
 * Dispatches `call(symbol, payload)` to the handler bound for that symbol.
 *
 * The single quirk requested: you call by *symbol*, not by method —
 * `kernel.call(Storage.Notes.fetch, id)`. Type safety is preserved end to end
 * because `call` is generic over the symbol's `P`/`O`.
 */
export class Kernel {
  readonly #handlers: ReadonlyMap<string, ErasedHandler>;
  /**
   * Serial queue for fire-and-forget commands (`dispatch`). Shared across
   * every span-scoped view of this kernel (see `#scoped`) — submission-order
   * serialization is a kernel-wide guarantee, not a per-view one, so a
   * handler's dispatch and a top-level dispatch land on the same chain.
   */
  readonly #commands: CommandBus;
  /** Where a dispatched command's failure goes — frozen by `build`. */
  readonly #errorSink: (symbolId: string, error: unknown) => void;
  /**
   * The observable-state region this kernel writes into — frozen by `build`
   * (from `KernelBuildOptions.buffer`, or an empty default). Handlers and
   * pipe stages `mutate` it; the view layer `read`s / `subscribe`s. Always
   * present, always holding at least `KernelErrorState`.
   */
  readonly buffer: Buffer;
  /**
   * Trace sink. `undefined` unless
   * `KernelBuildOptions.tracing` was on at `build` — off, `invoke` skips the
   * sink call entirely, paying only the span-minting cost it already pays
   * unconditionally.
   */
  readonly #onTrace: TraceSink | undefined;
  /**
   * The span enclosing every public call made *through this instance* —
   * `undefined` on the kernel `build()` returns (top-level calls are flow
   * roots), the handler's own span on the span-scoped view `invoke` hands to
   * each handler (span linking). The TS stand-in for Swift's
   * `@TaskLocal` ambient span, carried on the kernel *value* instead of the
   * task, so it behaves identically in Node and the browser — see
   * [[span.ts]].
   */
  readonly #ambientSpan: Span | undefined;

  /** @internal Construct via `KernelBuilder.build()`, never directly. */
  constructor(
    handlers: ReadonlyMap<string, ErasedHandler>,
    errorSink: (symbolId: string, error: unknown) => void,
    buffer: Buffer,
    onTrace?: TraceSink,
    ambientSpan?: Span,
    commands?: CommandBus,
  ) {
    this.#handlers = handlers;
    this.#errorSink = errorSink;
    this.buffer = buffer;
    this.#onTrace = onTrace;
    this.#ambientSpan = ambientSpan;
    this.#commands = commands ?? new CommandBus();
  }

  /**
   * A view of this kernel whose public entry points (`call`/`dispatch`/
   * `compose`/`run`) parent their spans under `span` instead of minting flow
   * roots. Shares every piece of live state — handler table, command bus,
   * buffer, error/trace sinks — so it *is* this kernel for every purpose
   * except span parentage. `invoke` hands one to each handler it runs, which
   * is what links a handler's own call-backs to the handler's span
   * (span linking; see [[span.ts]]).
   */
  #scoped(span: Span): Kernel {
    return new Kernel(this.#handlers, this.#errorSink, this.buffer, this.#onTrace, span, this.#commands);
  }

  /**
   * Run the bound handler for `id` and hand back its raw verb. The pipeline
   * runner (`compose`) consumes this directly so a handler's own
   * `next`/`abort`/`divert`/`fail` drives the flow.
   *
   * This is the single chokepoint every `call`/`dispatch` (and
   * every pipe stage) funnels through —
   * wrapping the handler here is all a monitor needs to see the whole graph
   * light up, stage by stage.
   *
   * @internal Not part of the app-facing surface — pipe machinery and the
   * typed `call` wrap it. Exposed (not `#`-private) because
   * `PipeBuilder` stages must funnel through it.
   *
   * `parentSpan`: the enclosing span, threaded in explicitly by
   * whichever internal caller has one (`runStages`, fork). Public entry
   * points (`call`/`dispatch`/`compose`/`run`) pass their own instance's
   * ambient span — `undefined` on the kernel `build()` returned (a top-level
   * call is a flow root), the handler's span on the span-scoped view a
   * running handler receives (span linking); see [[span.ts]] for the
   * design. A span is minted unconditionally (the cost is one
   * `crypto.randomUUID()` call) — mirroring Swift's `traced`, where the
   * record happens once the body returns, so a child's span/parent pair is
   * always observed before its parent's. When `tracing` is on,
   * `onTrace` is then notified with the *input*
   * payload (rendered via `describeTracePayload`) and the resolved verb's
   * `kind`; off, that formatting and the sink call are skipped entirely.
   *
   * A handler that *throws* (rather than resolving to a `fail` verb) is
   * still recorded — as a `'fail'` entry — before the error is rethrown
   * unchanged: `register`-bound handlers have no other way to signal
   * failure than throwing (only `registerVerb` can construct `fail(...)`
   * directly), so without this, every failure from a `register`-bound
   * handler would be invisible to the trace, defeating the point of a
   * devtools trace.
   */
  async invoke(id: string, payload: unknown, parentSpan?: Span): Promise<Verb<unknown>> {
    const handler = this.#handlers.get(id);
    if (handler === undefined) {
      throw new KernelError('unbound', id, `No handler bound for symbol '${id}' — forgotten register?`);
    }
    const span = mintSpan(parentSpan);
    // The handler runs against a span-scoped view of this kernel, so its own
    // call-backs parent under the span just minted — Swift's
    // `Kernel.$span.withValue(span) { body() }`, carried on the kernel value
    // instead of the task (span linking; see [[span.ts]]). Skipped
    // when tracing is off: spans are unobservable then, and the root kernel
    // behaves identically in every other respect.
    const kernel = this.#onTrace === undefined ? this : this.#scoped(span);
    try {
      const verb = await handler(kernel, payload);
      this.#onTrace?.(id, verb.kind, span, describeTracePayload(payload), Date.now());
      return verb;
    } catch (error) {
      this.#onTrace?.(id, 'fail', span, describeTracePayload(payload), Date.now());
      throw error;
    }
  }

  /**
   * Call one symbol and get its typed `O`. A single call is just a one-stage
   * pipeline: invoke the handler, then interpret the verb down to `O`.
   *
   * The no-payload overload is sugar for the many `void`-payload endpoints:
   * `kernel.call(sym)` (Swift's `call(_: Symbol<Void, O>)` extension).
   */
  call<O>(sym: KernelSymbol<void, O>): Promise<O>;
  call<P, O>(sym: KernelSymbol<P, O>, payload: P): Promise<O>;
  async call<P, O>(sym: KernelSymbol<P, O>, payload?: P): Promise<O> {
    const verb = await this.invoke(sym.id, payload, this.#ambientSpan);
    return this.#interpret<O>(verb);
  }

  /**
   * Fire-and-forget command: enqueue on the serial bus and return immediately —
   * no `await`, no return value, no `throws`. The command runs in submission
   * order; if it fails, the error goes to the sink — never to the caller,
   * and never as an unhandled rejection. **Forward-only**: there is no return
   * path by design. For `void` commands whose result is published through
   * state; queries that need a value keep `call`.
   *
   * The `Action` overload is the Redux `dispatch(action)` shape:
   * `dispatch(SimActions.setSpeed(30))` — the same enqueue, with the
   * symbol/payload pair built earlier as data (see `actionsOf`). Runtime
   * discrimination is structural: an action carries `sym`, a symbol never
   * does.
   *
   * Span parentage (span linking): dispatched from inside a handler
   * (through the span-scoped kernel the handler received), the command's span
   * records that handler as its parent — the enqueued closure captures the
   * scoped `this`, so the linkage survives the bus's deferred execution.
   * Deliberately *more* than Swift, whose drain task freezes its task-locals
   * at kernel construction (CommandBus.swift:19-25) and so loses dispatch
   * parentage; here the truthful causal link is free, and cross-platform
   * trace comparisons should expect TS to nest what Swift shows as a root.
   */
  dispatch<P, O>(sym: KernelSymbol<P, O>, payload: P): void;
  dispatch<P, O>(action: Action<P, O>): void;
  dispatch<P, O>(target: KernelSymbol<P, O> | Action<P, O>, payload?: P): void {
    const isAction = 'sym' in target;
    const sym = isAction ? target.sym : target;
    const p = isAction ? target.payload : (payload as P);
    this.#commands.enqueue(async () => {
      try {
        await this.call(sym, p);
      } catch (error) {
        this.#errorSink(sym.id, error);
      }
    });
  }

  /**
   * Run a sealed pipe (or, as sugar, an unsealed builder — Swift has the same
   * convenience) and hand back its final value, typed as the pipe's declared
   * `O`. "Final" means whatever terminated the run: the last stage's `next`,
   * an `abort`'s value, or a diverted-to pipe's own result — every terminator
   * leaves through this single boundary.
   *
   * Boundary cast: deliberately unchecked (`as O`) — Swift
   * re-checks the value here and throws `composeTypeMismatch` on a lying
   * `abort`/`divert`; TS generics are erased, so a mismatch surfaces at the
   * use site instead.
   *
   * The no-payload overload is sugar for `Pipe<void, O>` pipelines,
   * mirroring `call(sym)` — a TS-side symmetry; Swift has no `Void`
   * `compose` convenience.
   */
  compose<O>(target: Pipe<void, O> | PipeBuilder<void, O>): Promise<O>;
  compose<I, O>(target: Pipe<I, O> | PipeBuilder<I, O>, payload: I): Promise<O>;
  async compose<I, O>(target: Pipe<I, O> | PipeBuilder<I, O>, payload?: I): Promise<O> {
    return (await this.runStages(target.erasedStages, payload, this.#ambientSpan)) as O;
  }

  /**
   * Forward-only drive: run the pipe for its effects and in-pipe verbs, then
   * discard the final value — there is no return path. Results are published
   * through `tap`/`effect` (buffer writes); only `next`/`abort`/`divert`/
   * `fail` steer the flow. Because nothing is returned, an `abort`/`divert`
   * value never meets the pipe's `O` at all (`fail` still rejects). The
   * no-payload overload mirrors `compose(pipe)`.
   */
  run(target: Pipe<void, unknown> | PipeBuilder<void, unknown>): Promise<void>;
  run<I>(target: Pipe<I, unknown> | PipeBuilder<I, unknown>, payload: I): Promise<void>;
  async run<I>(target: Pipe<I, unknown> | PipeBuilder<I, unknown>, payload?: I): Promise<void> {
    await this.runStages(target.erasedStages, payload, this.#ambientSpan);
  }

  /**
   * Interpret a single verb down to a typed result — the terminal step shared
   * by `call` (a one-stage pipe) and `compose`'s terminators.
   * `next`/`abort` yield their value; `divert` runs the other pipe (via the
   * same iterative `#runStages`, so a diverted-to loop is still O(1) stack);
   * `fail` throws.
   *
   * Boundary cast: Swift re-checks the terminator's value against `O` here
   * and throws `composeTypeMismatch` on a lie. TS generics are erased, so the
   * `as O` casts are unchecked — a mismatched `abort`/`divert` value surfaces
   * at the use site instead of at this boundary.
   */
  async #interpret<O>(verb: Verb<unknown>): Promise<O> {
    switch (verb.kind) {
      case 'next':
        return verb.value as O;
      case 'abort':
        return verb.value as O;
      case 'divert':
        // Runs under this instance's *own* ambient span (`undefined` on the
        // built kernel): by interpret time the handler that returned this
        // divert has already closed its span, so the diverted-to stages
        // parent under the caller's enclosing span — exactly Swift, where
        // traced's ambient has reverted to the caller's binding when
        // interpret runs (it only wraps invoke's handler call, not the
        // interpretation that follows it).
        return (await this.runStages(verb.diversion.stages, verb.diversion.payload, this.#ambientSpan)) as O;
      case 'fail':
        throw verb.error;
    }
  }

  /**
   * Thread `payload` through `stages`, interpreting each verb. `next` hands
   * the value to the next stage; `abort` returns it; `fail` throws. `divert`
   * **replaces** `stages`/`value` with the target pipe's own and restarts
   * from its first stage — an iteration, not a recursive call. That is the
   * whole point: a pipe that ends by diverting back to a pipe shaped like
   * itself (an agent loop, a stream-processing loop) costs O(1) stack frames
   * no matter how many hops it takes, because there is never a nested async
   * call to unwind — each hop discards the previous one's stage list outright
   * rather than waiting on it.
   *
   * Carried over in full (Swift `runStages`, verbatim) because
   * `call`'s `divert` interpretation already needs it;
   * `compose`/`run` are thin typed wrappers over it.
   *
   * `parentSpan` is constant for the *entire* call, including
   * across a `divert` jump: a divert replaces `stages`/`value` but keeps
   * iterating the same loop, so it is a continuation of this run, not a new
   * one — every stage it visits, before or after a jump, mints its span under
   * the same parent. Every stage — symbol-backed or a fork's branch dispatch
   * — receives it as its third argument and is responsible for forwarding it
   * to `kernel.invoke`/`kernel.runStages` itself; an anonymous verb stage
   * (`.pipe(meta, fn)`) simply has nowhere to put it, since it never reaches
   * `invoke`.
   *
   * Not `#`-private: `PipeBuilder`'s `fork` stage needs to
   * call this directly with the parent it was itself given, rather than
   * going through the public `compose` — which stays a fixed two-argument
   * signature and so has no parameter to carry
   * a parent through. `compose`/`run` call it as their unexported-typed
   * implementation.
   */
  async runStages(initialStages: readonly ErasedStage[], initialPayload: unknown, parentSpan?: Span): Promise<unknown> {
    let stages = initialStages;
    let value = initialPayload;
    let index = 0;
    while (index < stages.length) {
      const stage = stages[index] as ErasedStage;
      const verb = await stage(this, value, parentSpan);
      switch (verb.kind) {
        case 'next':
          value = verb.value;
          index += 1;
          break;
        case 'abort':
          return verb.value;
        case 'divert':
          stages = verb.diversion.stages;
          value = verb.diversion.payload;
          index = 0;
          break;
        case 'fail':
          throw verb.error;
      }
    }
    return value;
  }
}
