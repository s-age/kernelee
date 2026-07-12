import type { Kernel } from './kernel.js';
import type { KernelSymbol } from './symbol.js';
import { next, type ErasedStage, type Verb } from './verb.js';

// MARK: - Branch arity (fork's static fan-out declaration)

/**
 * How many branches a `fork` stage fans out to — as *declared*, not merely as
 * built. The distinction matters to introspection consumers: a pipe value can
 * be constructed purely for cataloguing, and then its `branches` array holds
 * however many branches that one construction happened to build — which says
 * nothing about production. `fixed` promises the arity is structural (every
 * construction builds exactly `count`); `runtime` says the branch array is
 * sized per invocation and the built count is incidental.
 *
 * Swift's `BranchArity` enum (`.fixed(Int)` / `.runtime`), as a discriminated
 * union with the {@link fixedArity} / {@link runtimeArity} constructors.
 */
export type BranchArity =
  /** Structurally fixed fan-out — every construction builds exactly `count`
   * branches (the tuple `fork` overloads, or an array `fork` whose input is
   * constant). */
  | { readonly kind: 'fixed'; readonly count: number }
  /** The branch array is sized per invocation (a fan-out over a runtime
   * list); the descriptor's `branches` show one construction, not the
   * production arity. Declared at the definition site via the array `fork`'s
   * optional `arity` argument. */
  | { readonly kind: 'runtime' };

/** Declare a structurally fixed fan-out of `count` branches — Swift `.fixed(count)`. */
export function fixedArity(count: number): BranchArity {
  return { kind: 'fixed', count };
}

/** Declare a per-invocation branch count — Swift `.runtime`. */
export const runtimeArity: BranchArity = { kind: 'runtime' };

// MARK: - Stage descriptor (static shape, for introspection)

/**
 * Which builder method minted a stage, paired with its operand shape — a
 * compound literal, not a bare verb. The method half (`pipe`/`tap`/`map`/
 * `effect`/`fork`) declares the causal kind the stage brings into the flow;
 * the operand half (`symbol`/`function`/`closure`/`branches`) declares
 * **which channel the stage's identity lives in**:
 *
 * - `symbol` — routed through `kernel.invoke` (the chokepoint: traceable,
 *   joinable by id). Identity is `symbolId`.
 * - `function` — runs the author's function directly (opaque to
 *   invoke-level tracing), but the function was passed *by name* (a bare
 *   identifier, or a named `function` expression) — its `fn.name` was
 *   captured at construction. Identity is `handlerName` (paired with the
 *   call site).
 * - `closure` — runs directly, same as `function`, but the handler is an
 *   inline anonymous arrow (or unnamed function expression) — there is no
 *   `fn.name` to capture. Identity is **absent**; only the author's `note`
 *   (prose) stands in for it.
 * - `branches` — fans out to sub-`Pipe`s.
 *
 * `function` vs `closure` is not a style choice recorded after the fact — it
 * is the *same* `fn.name` check that also fills {@link StageDescriptor.handlerName},
 * evaluated once at construction: a stage is `(function)` if and only if
 * `handlerName` is present. This pairing (like `symbol`/`branches`) is
 * always an explicit token stamped at construction, never derived from
 * `symbolId`'s presence — a stage's routing is a declaration, not an
 * inference.
 *
 * There is no `pipe(closure)` counterpart with an adapt step:
 * payload-shaping is its own visible node (`.map(adapt).pipe(sym)`), not a
 * hidden second argument — see the removed `pipeAdapt`/`tapAdapt` kinds this
 * vocabulary superseded.
 *
 * Swift's `StageDescriptor.Kind`, adapted vocabulary (TS split the method
 * from the operand where Swift's `verb` stayed a single flat case).
 */
export type StageKind =
  | 'pipe(symbol)'
  | 'pipe(function)'
  | 'pipe(closure)'
  | 'tap(symbol)'
  | 'map(function)'
  | 'map(closure)'
  | 'effect(function)'
  | 'effect(closure)'
  | 'fork(branches)';

/**
 * The static shape of one pipe stage — the part that depends neither on the
 * value flowing nor on any captured payload. Each `PipeBuilder` method stamps
 * it at construction, so a built `Pipe` can be read back as a graph
 * (`Pipe.descriptors`) *without being run*.
 *
 * What is *not* here is what isn't static: the non-`next` verbs a stage can
 * emit (`fail`/`abort`/`divert`) live inside opaque closures / bound handlers.
 * `divert` gets one deliberate exception (`divertsTo`): its actual target is
 * runtime-decided and can never be derived, but an author can still name the
 * candidates.
 *
 * Deliberately slimmer than Swift's `StageDescriptor`:
 * - no `wireSite` — Swift captures `#filePath`/`#line` at the `.pipe`/`.map`
 *   call; TS has no compile-time source-location default arguments, and the
 *   port decided against faking one (a deliberate design decision).
 * - no `flows`/`inputType` — Swift renders `"\(Next.self)"`; TS generics are
 *   erased, so there is no runtime type name to record.
 */
export interface StageDescriptor {
  readonly kind: StageKind;
  /**
   * The dotted symbol id this stage invokes (`Layer.Device.method`), or
   * `undefined` for a stage whose kind isn't a `symbol` operand
   * (`pipe(function)`/`pipe(closure)`/`map(function)`/`map(closure)`/
   * `effect(function)`/`effect(closure)`).
   */
  readonly symbolId?: string;
  /**
   * "What this part does": for a symbol stage, the symbol's `description`
   * (which a symbol generator can fill from the port method's doc comment);
   * for an anonymous `pipe(function)`/`pipe(closure)` stage, the author's
   * `note` ({@link VerbStageMeta.note}, required — a dispatch point earns a
   * forced channel); for `map(function)`/`map(closure)`/`effect(function)`/
   * `effect(closure)`/`fork(branches)`, the author's optional
   * {@link StageMeta.note} (a relief valve, not a requirement — those kinds
   * are already legible as a bare `kind` with no note at all — and, for the
   * `(function)` variants, a `handlerName` besides). `undefined` for an
   * undocumented symbol, or a `map`/`effect`/`fork` stage whose author
   * declined the optional note (a `pipe` stage's `note` is required, so that
   * case never arises there). (Swift folds both into
   * `StageDescriptor.description`; the TS field is named after the
   * anonymous-stage `note` that most often fills it.)
   */
  readonly note?: string;
  /**
   * `pipe(closure)` only: dispatch keys this stage *might* `divert` to, named
   * by the author — unlike anything else here, this is not derived (the
   * actual target is decided by a runtime condition inside the closure).
   * Convention-level accuracy: a stale entry just fails to resolve to a real
   * pipeline at render time. Empty for every other kind.
   */
  readonly divertsTo: readonly string[];
  /**
   * `fork(branches)` only: each branch's own `descriptors` (it is a sub
   * `Pipe`), in the order they were forked. `undefined` for every other kind.
   * (Swift defaults this to `[]` on non-fork stages; the TS port spells "not
   * a fork" as absence, matching `branchArity`.)
   */
  readonly branches?: readonly (readonly StageDescriptor[])[];
  /**
   * `fork(branches)` only: the declared fan-out arity — `fixedArity(n)` (the
   * default: the branch count at construction) or `runtimeArity` when the
   * definition site declares the branch array is sized per invocation,
   * making the built `branches` a sample rather than the structure.
   * `undefined` for every other kind.
   */
  readonly branchArity?: BranchArity;
  /**
   * The `.name` of the *function* that drives an anonymous `pipe`/`map`/
   * `effect` stage — the identifier at its definition site, e.g.
   * `.effect(sleepForSpeed)` records `'sleepForSpeed'`. Present if and only
   * if `kind` is the `(function)` operand (`pipe(function)`/`map(function)`/
   * `effect(function)`) — `undefined` when the handler is an inline anonymous
   * arrow or unnamed function expression (empty `fn.name`, `kind` the
   * `(closure)` operand instead), and never present on symbol-backed stages
   * (`pipe(symbol)`/`tap(symbol)`) — those already carry identity in
   * {@link symbolId}, so a second address would be redundant.
   *
   * `kind` and `handlerName` are cast from the **same** `fn.name` check,
   * evaluated once at construction — a `(function)` kind with an absent
   * `handlerName`, or a `(closure)` kind with one present, cannot arise.
   *
   * This is **not new vocabulary**: it adds no verb beyond the `function`/
   * `closure` operand split above. It is a fact the runtime already holds in
   * its hand — the handler function is passed *by value* to the builder, so
   * `fn.name` is free to read at construction and cannot be derived from
   * anything else already on the descriptor (an anonymous stage has no
   * `symbolId`, and `note` is prose, not an identifier). The runtime
   * declares it; a scanner need not re-derive it.
   */
  readonly handlerName?: string;
}

// MARK: - Pipe stage (descriptor + erased run)

/**
 * One pipeline step: its static `descriptor` plus the type-erased `run`
 * closure. The erasure is safe because construction (`PipeBuilder.pipe`) pins
 * both ends via the `KernelSymbol` / `Verb<Next>` signatures — the same
 * discipline as `KernelBuilder`'s casts. Swift counterpart: `PipeStage`.
 *
 * @internal Not exported from the package index — `Diversion` and the
 * kernel's stage runner consume only the `run` half (`ErasedStage`).
 */
export interface PipeStage {
  readonly descriptor: StageDescriptor;
  readonly run: ErasedStage;
}

// MARK: - Anonymous verb stage vocabulary

/**
 * A verb-returning anonymous stage — the self-describing rule. It receives
 * the kernel (to make its own calls) and the flowing value, and decides
 * `next`/`abort`/`divert`/`fail`.
 *
 * Single signature (no leaf/composing split), so a lambda argument is
 * contextually typed — `.pipe(meta, (kernel, cursor) => …)` needs no
 * parameter annotations when the cursor type is already pinned by the chain.
 * (At the `pipeline(meta, fn)` *entry* nothing pins `P` yet, so there the
 * lambda's parameters must be annotated.)
 */
export type VerbStageFn<Cursor, Next> = (
  kernel: Kernel,
  cursor: Cursor,
) => Verb<Next> | Promise<Verb<Next>>;

/**
 * Labels an anonymous verb stage. Anonymous stages carry no symbol, hence no
 * lifted description — `note` says what the guard/rule does, and doubles as
 * the runtime discriminator that tells `.pipe(meta, fn)` apart from
 * `.pipe(symbol)` (which is why it is required where Swift's `note:` is
 * optional). `divertsTo` optionally names the dispatch key(s) the stage might
 * `divert` to — see {@link StageDescriptor.divertsTo}.
 */
export interface VerbStageMeta {
  readonly note: string;
  readonly divertsTo?: readonly string[];
}

// MARK: - Optional stage meta (map/effect/fork)

/**
 * Optional annotation for the three anonymous stages that carry no symbol
 * *and* no verb of their own — `map`/`effect`/`fork`. Deliberately the
 * opposite cardinality of {@link VerbStageMeta.note}: a `verb` stage is a
 * dispatch point (it can `abort`/`divert`/`fail`), so it earns a
 * symbol-grade channel and `note` is forced to fill it, standing in for the
 * lifted `description` a symbol stage gets for free. `map`/`effect`/`fork`
 * dispatch nothing — each is *always* legible as its bare `kind` on the
 * graph (a `map` stage reads as "a map" with or without prose) — so this
 * `note` is a relief valve, not a gate: supply it when the stage's *intent*
 * isn't obvious from its shape (why this transform, why this effect, why
 * fan out here), omit it otherwise. `fork` needs it least of the three: its
 * `branches` are themselves descriptor trees (symbol/`note`-bearing
 * sub-pipes), so only the fork's own "why fan out at this point" ever goes
 * unaccounted for — everything the branches *do* is already tokenized.
 *
 * Swift already has this: `PipeBuilder.map`/`.effect` and every `fork`
 * overload (`Pipe.swift`/`PipeBuilder+Fork.swift`) take a trailing
 * `note: String? = nil` labeled parameter — Swift's `note` has been optional
 * across *every* stage-building method (`pipe`/`tap`/`map`/`effect`/`fork`)
 * from the start, including the anonymous-verb-equivalent `pipe(note:, …)`
 * (see the "required where Swift's `note:` is optional" remark on
 * {@link VerbStageMeta}). This TS type is a **capability catch-up**, not a
 * TS-only extension: TS already matched Swift for `verb` (by choosing
 * *required*, deliberately, for the discriminator reason above); it did not
 * yet match Swift for `map`/`effect`/`fork`, where TS had no note channel at
 * all. No new Swift-side work follows from this — only a shape difference
 * remains (a leading `{ note }` object here vs. a trailing labeled
 * parameter there, and Swift's `note:` still rides along with its
 * `#filePath`/`#line` capture, which this port already declined to fake —
 * see {@link StageDescriptor}'s "no `wireSite`" note above).
 */
export interface StageMeta {
  readonly note?: string;
}

// MARK: - Fork branch

/**
 * What `fork` accepts as one branch: a sealed `Pipe` or, as sugar, an
 * unsealed `PipeBuilder` (fork seals it on the spot — same convenience as
 * `kernel.compose(builder, …)`; Swift's `fork` takes sealed `Pipe`s only).
 * `Cursor` is the forking pipe's current value — every branch receives it —
 * and `R` is that branch's own result.
 */
export type ForkBranch<Cursor, R> = Pipe<Cursor, R> | PipeBuilder<Cursor, R>;

// MARK: - Pipe

/**
 * A sealed pipeline: a list of stages whose phantom `I`/`O` pin the payload
 * you feed in and the result you get back. Built by `PipeBuilder` (via
 * {@link pipeline}), run by `Kernel.compose` / `Kernel.run`, jumped to by
 * `divert(diversion(pipe, payload))`.
 */
export class Pipe<in I, out O> {
  /**
   * Phantom brand — **never present at runtime** (`declare` emits nothing).
   * Exists only so `I`/`O` participate in assignability, mirroring
   * `KernelSymbol.__phantom`.
   */
  declare readonly __phantom?: (input: I) => O;

  /** @internal The sealed stage list — descriptors plus erased runs. */
  readonly stages: readonly PipeStage[];
  /**
   * @internal The `run` halves only — the exact shape `Kernel.#runStages`
   * iterates and `Diversion.stages` stores. Computed once at seal.
   */
  readonly erasedStages: readonly ErasedStage[];

  /** @internal Construct via `PipeBuilder.seal()`, never directly. */
  constructor(stages: readonly PipeStage[]) {
    this.stages = stages;
    this.erasedStages = stages.map((stage) => stage.run);
  }

  /**
   * The static shape of the pipe, stage by stage — readable without running
   * anything (no kernel, no execution). This is the data a wiring graph
   * renders: topology derived from the real pipeline, not hand-authored.
   */
  get descriptors(): readonly StageDescriptor[] {
    return this.stages.map((stage) => stage.descriptor);
  }
}

// MARK: - Builder

/**
 * Builds a pipe left-to-right, UNIX-pipe style. `Cursor` is the type
 * currently flowing through the pipe; each `pipe(...)` advances it. The chain
 * constraint "previous Return == next Payload" is enforced by the method
 * signatures: `KernelSymbol<Cursor, Next>` / `(kernel, cursor) => Verb<Next>`
 * will not type-check unless the next stage consumes exactly what the current
 * one produces.
 *
 * Immutable — every method returns a new builder, so a prefix can be shared
 * and extended in two directions without aliasing.
 */
export class PipeBuilder<in Input, out Cursor> {
  /** Phantom brand — never present at runtime; see {@link Pipe.__phantom}. */
  declare readonly __phantom?: (input: Input) => Cursor;

  readonly #stages: readonly PipeStage[];

  /** @internal Construct via {@link pipeline}, never directly. */
  constructor(stages: readonly PipeStage[]) {
    this.#stages = stages;
  }

  /**
   * @internal The `run` halves, for `Kernel.compose`/`run`'s builder sugar —
   * composing an unsealed builder must behave exactly like sealing first.
   */
  get erasedStages(): readonly ErasedStage[] {
    return this.#stages.map((stage) => stage.run);
  }

  #appending<Next>(stage: PipeStage): PipeBuilder<Input, Next> {
    return new PipeBuilder<Input, Next>([...this.#stages, stage]);
  }

  /**
   * Append a leaf symbol. Its bound handler's verb drives the pipe directly —
   * through `kernel.invoke`, the single chokepoint: a plain handler flows
   * through (`next`), a verb-returning handler can `abort`/`divert`/`fail`
   * from here without any wrapper at this layer.
   *
   * There is no `pipe(symbol, adapt)` shape: payload-shaping ahead of a
   * symbol stage is its own visible node — `.map(adapt).pipe(sym)` — so the
   * graph shows the transform, not a hidden second argument.
   *
   * Second shape — `pipe(meta, verbFn)`: an anonymous verb-returning stage
   * (see {@link VerbStageFn}). Runs its closure directly, **not** through
   * `kernel.invoke` — same as Swift, where only symbol-backed stages hit the
   * chokepoint (that is what makes a trace read as symbol traffic).
   */
  pipe<Next>(symbol: KernelSymbol<Cursor, Next>): PipeBuilder<Input, Next>;
  pipe<Next>(meta: VerbStageMeta, stage: VerbStageFn<Cursor, Next>): PipeBuilder<Input, Next>;
  pipe(
    first: KernelSymbol<never, unknown> | VerbStageMeta,
    second?: (kernel: Kernel, cursor: never) => Verb<unknown> | Promise<Verb<unknown>>,
  ): PipeBuilder<Input, unknown> {
    if ('id' in first) {
      const sym = first;
      return this.#appending({
        descriptor: { kind: 'pipe(symbol)', symbolId: sym.id, note: sym.description, divertsTo: [] },
        run: (kernel, value, parentSpan) => kernel.invoke(sym.id, value, parentSpan),
      });
    }
    const stage = second as VerbStageFn<unknown, unknown>;
    const handlerName = handlerNameOf(stage);
    return this.#appending({
      descriptor: {
        kind: handlerName === undefined ? 'pipe(closure)' : 'pipe(function)',
        note: first.note,
        divertsTo: first.divertsTo ?? [],
        handlerName,
      },
      run: (kernel, value) => stage(kernel, value),
    });
  }

  /**
   * Run a side-effecting symbol on the current value and keep that value
   * flowing — a pipe "tap"/"tee". The symbol's `void` output is discarded so
   * the cursor is unchanged, but its verb still governs the pipe (a `fail`
   * from the handler stops it; an `abort`/`divert` terminates with *its*
   * value/target, exactly as in any other stage). Lets a persist step read
   * like a chain link: `pipeline(create).tap(save)`.
   *
   * There is no `tap(symbol, adapt)` shape — and, unlike `pipe`'s dropped
   * adapt overload, `.map(project).tap(sym)` is NOT its equivalent (the map
   * would REPLACE the cursor with the projection, and tap forwards whatever
   * cursor it saw). When the tapped symbol cannot take the cursor as-is,
   * either reshape the symbol's input to the cursor type, or `fork` and let
   * the untouched payload ride its own branch.
   *
   * Optional leading `meta` ({@link StageMeta}) — the author's site context
   * ("why tap *here*"); when supplied it wins over the symbol's own
   * `description` in the descriptor (Swift's `note ?? description`). Same
   * non-breaking arity-based dispatch as `.map`/`.effect`.
   */
  tap(symbol: KernelSymbol<Cursor, void>): PipeBuilder<Input, Cursor>;
  tap(meta: StageMeta, symbol: KernelSymbol<Cursor, void>): PipeBuilder<Input, Cursor>;
  tap(
    first: StageMeta | KernelSymbol<Cursor, void>,
    second?: KernelSymbol<Cursor, void>,
  ): PipeBuilder<Input, Cursor> {
    const meta = second === undefined ? undefined : (first as StageMeta);
    const symbol = (second === undefined ? first : second) as KernelSymbol<Cursor, void>;
    return this.#appending({
      descriptor: {
        kind: 'tap(symbol)',
        symbolId: symbol.id,
        note: meta?.note ?? symbol.description,
        divertsTo: [],
      },
      run: async (kernel, value, parentSpan) => {
        const verb = await kernel.invoke(symbol.id, value, parentSpan);
        return verb.kind === 'next' ? next(value) : verb; // discard void, forward the original
      },
    });
  }

  /**
   * Pure **synchronous** transform of the flowing value — a projection step
   * with no I/O and no kernel calls (e.g. a DTO projection). Anything
   * effectful belongs in `.effect`/`.tap`; anything async in a `.pipe` stage —
   * a `Promise` returned here would flow *as the value*, which the cursor
   * type will faithfully (and unhelpfully) report.
   *
   * Optional leading `meta` ({@link StageMeta}) opens the same `note` relief
   * valve `verb` stages are forced to use — non-breaking (existing
   * `.map(transform)` callers are untouched; the arity, not a flag, picks the
   * overload).
   */
  map<Next>(transform: (cursor: Cursor) => Next): PipeBuilder<Input, Next>;
  map<Next>(meta: StageMeta, transform: (cursor: Cursor) => Next): PipeBuilder<Input, Next>;
  map(
    first: ((cursor: Cursor) => unknown) | StageMeta,
    second?: (cursor: Cursor) => unknown,
  ): PipeBuilder<Input, unknown> {
    const meta = second === undefined ? undefined : (first as StageMeta);
    const transform = (second === undefined ? first : second) as (cursor: Cursor) => unknown;
    const handlerName = handlerNameOf(transform);
    return this.#appending({
      descriptor: {
        kind: handlerName === undefined ? 'map(closure)' : 'map(function)',
        note: meta?.note,
        divertsTo: [],
        handlerName,
      },
      run: (_kernel, value) => next(transform(value as Cursor)),
    });
  }

  /**
   * Effectful passthrough: run an effect on the value (e.g. a buffer write),
   * then keep the same value flowing. A thrown error propagates out of the
   * pipe (there is no verb to catch it into).
   *
   * Optional leading `meta` ({@link StageMeta}) — same relief valve as
   * `.map`, same non-breaking arity-based dispatch.
   */
  effect(run: (kernel: Kernel, cursor: Cursor) => void | Promise<void>): PipeBuilder<Input, Cursor>;
  effect(
    meta: StageMeta,
    run: (kernel: Kernel, cursor: Cursor) => void | Promise<void>,
  ): PipeBuilder<Input, Cursor>;
  effect(
    first: StageMeta | ((kernel: Kernel, cursor: Cursor) => void | Promise<void>),
    second?: (kernel: Kernel, cursor: Cursor) => void | Promise<void>,
  ): PipeBuilder<Input, Cursor> {
    const meta = second === undefined ? undefined : (first as StageMeta);
    const run = (second === undefined ? first : second) as (
      kernel: Kernel,
      cursor: Cursor,
    ) => void | Promise<void>;
    const handlerName = handlerNameOf(run);
    return this.#appending({
      descriptor: {
        kind: handlerName === undefined ? 'effect(closure)' : 'effect(function)',
        note: meta?.note,
        divertsTo: [],
        handlerName,
      },
      run: async (kernel, value) => {
        await run(kernel, value as Cursor);
        return next(value);
      },
    });
  }

  /**
   * Fan the current value out to N independent branches (each a sub `Pipe`
   * run via `kernel.compose`), run them concurrently, and collect their
   * results into an order-preserving tuple (heterogeneous overloads, 2–4
   * branches — matching Swift's overload set) or array (homogeneous overload,
   * unbounded). `.map`/`.pipe` on the tuple/array output is the "transistor"
   * that recombines the branches — no dedicated join combinator exists.
   *
   * Branch verbs, exactly as in Swift (each branch is a full `compose`):
   * a branch's `abort` terminates *that branch* and its value becomes the
   * branch's slot in the result — the fork keeps going; a branch's `divert`
   * runs the target pipe and *its* result fills the slot; a branch's `fail`
   * rejects the whole fork (and thereby the enclosing pipe) — downstream
   * stages never run.
   *
   * **Fail-fast semantics differ from Swift in resources, not in results.**
   * Swift's structured concurrency (`async let` / task group) *cancels* the
   * still-running siblings the moment one branch throws. JS has no task
   * cancellation: `Promise.all` settles on the first rejection — the fork
   * (and the pipe) fails just as fast — but **the sibling branches keep
   * running to completion in the background**; their results (or their own
   * later rejections) are discarded. Branches should therefore be safe to
   * complete uselessly. AbortSignal plumbing is deliberately out of scope
   * (future work).
   *
   * The array overload's `arity` is the definition site's declaration of what
   * the branch count *means* (see {@link BranchArity}): omitted, the
   * descriptor records `fixedArity(branches.length)`; pass {@link runtimeArity}
   * when the array is sized per invocation, so introspection consumers don't
   * mistake one construction's count for structure. (Tuple overloads always
   * stamp their structural arity.)
   *
   * Every shape also has an optional-leading-`meta` twin ({@link StageMeta}):
   * `fork` is the stage that needs the note relief valve least (its
   * `branches` are self-describing sub-`Pipe`s), but the one thing they never
   * carry — *why fan out here at all* — still deserves a channel. Non-
   * breaking: the runtime tells the two families apart by *shape*, not by an
   * extra flag — `meta` is a plain `{ note?: string }` object, never a `Pipe`/
   * `PipeBuilder` instance nor an array, so it can never be mistaken for a
   * branch or a branch list.
   */
  fork<R1, R2>(
    b1: ForkBranch<Cursor, R1>,
    b2: ForkBranch<Cursor, R2>,
  ): PipeBuilder<Input, [R1, R2]>;
  fork<R1, R2>(
    meta: StageMeta,
    b1: ForkBranch<Cursor, R1>,
    b2: ForkBranch<Cursor, R2>,
  ): PipeBuilder<Input, [R1, R2]>;
  fork<R1, R2, R3>(
    b1: ForkBranch<Cursor, R1>,
    b2: ForkBranch<Cursor, R2>,
    b3: ForkBranch<Cursor, R3>,
  ): PipeBuilder<Input, [R1, R2, R3]>;
  fork<R1, R2, R3>(
    meta: StageMeta,
    b1: ForkBranch<Cursor, R1>,
    b2: ForkBranch<Cursor, R2>,
    b3: ForkBranch<Cursor, R3>,
  ): PipeBuilder<Input, [R1, R2, R3]>;
  fork<R1, R2, R3, R4>(
    b1: ForkBranch<Cursor, R1>,
    b2: ForkBranch<Cursor, R2>,
    b3: ForkBranch<Cursor, R3>,
    b4: ForkBranch<Cursor, R4>,
  ): PipeBuilder<Input, [R1, R2, R3, R4]>;
  fork<R1, R2, R3, R4>(
    meta: StageMeta,
    b1: ForkBranch<Cursor, R1>,
    b2: ForkBranch<Cursor, R2>,
    b3: ForkBranch<Cursor, R3>,
    b4: ForkBranch<Cursor, R4>,
  ): PipeBuilder<Input, [R1, R2, R3, R4]>;
  fork<R>(
    branches: ReadonlyArray<ForkBranch<Cursor, R>>,
    arity?: BranchArity,
  ): PipeBuilder<Input, R[]>;
  fork<R>(
    meta: StageMeta,
    branches: ReadonlyArray<ForkBranch<Cursor, R>>,
    arity?: BranchArity,
  ): PipeBuilder<Input, R[]>;
  fork(
    first:
      | ForkBranch<never, unknown>
      | ReadonlyArray<ForkBranch<never, unknown>>
      | StageMeta,
    ...rest: readonly (
      | ForkBranch<never, unknown>
      | ReadonlyArray<ForkBranch<never, unknown>>
      | BranchArity
      | undefined
    )[]
  ): PipeBuilder<Input, unknown> {
    // `meta` is never a `Pipe`/`PipeBuilder` (a branch) nor an array (a
    // branch list) — that shape gap is what lets the optional leading `meta`
    // twin coexist with every existing call, no flag required.
    const hasMeta = !Array.isArray(first) && !(first instanceof Pipe) && !(first instanceof PipeBuilder);
    const meta = hasMeta ? (first as StageMeta) : undefined;
    const args = hasMeta ? rest : [first, ...rest];

    if (Array.isArray(args[0])) {
      const pipes = (args[0] as ReadonlyArray<ForkBranch<never, unknown>>).map(sealBranch);
      const arity = args[1] as BranchArity | undefined;
      return this.#forkStage(pipes, arity ?? fixedArity(pipes.length), meta);
    }
    const pipes = (args as readonly ForkBranch<never, unknown>[]).map(sealBranch);
    return this.#forkStage(pipes, fixedArity(pipes.length), meta);
  }

  /**
   * The one fork stage both shapes compile to. Swift needs two runtime
   * strategies (`async let` for tuples, `withThrowingTaskGroup` for arrays —
   * `async let` can't express a dynamic arity); `Promise.all` covers both,
   * and a JS "tuple" *is* an array, so tuple and array overloads share this
   * single code path. Order preservation is `Promise.all`'s own guarantee:
   * results land by submission index, never by completion order.
   *
   * Branches run through `kernel.runStages` directly, not the
   * public `compose` — `compose` is a fixed two-argument signature
   * with no slot for the
   * `parentSpan` this stage was itself given. `runStages` is `compose`'s own
   * unexported-typed implementation, so this is exactly what `compose` would
   * do, plus the parent thread — every span a branch's stages mint nests
   * under whatever this fork stage's own invocation nested under, same as any
   * other stage in the enclosing pipe.
   */
  #forkStage(
    pipes: readonly Pipe<unknown, unknown>[],
    branchArity: BranchArity,
    meta?: StageMeta,
  ): PipeBuilder<Input, unknown> {
    return this.#appending({
      descriptor: {
        kind: 'fork(branches)',
        note: meta?.note,
        divertsTo: [],
        branches: pipes.map((pipe) => pipe.descriptors),
        branchArity,
      },
      run: async (kernel, value, parentSpan) =>
        next(await Promise.all(pipes.map((pipe) => kernel.runStages(pipe.erasedStages, value, parentSpan)))),
    });
  }

  /** Freeze the builder. `Output` is whatever is flowing now (`Cursor`). */
  seal(): Pipe<Input, Cursor> {
    return new Pipe<Input, Cursor>(this.#stages);
  }
}

/** Normalize a fork branch: a builder is sealed on the spot, a pipe passes through. */
function sealBranch(branch: ForkBranch<never, unknown>): Pipe<unknown, unknown> {
  return (branch instanceof Pipe ? branch : branch.seal()) as Pipe<unknown, unknown>;
}

/**
 * The identifier a runtime already holds for a handler function — its
 * `fn.name`, read straight off the value passed to the builder. A named
 * function (`function f(){}`, `const f = () => {}`) yields `'f'`; an inline
 * anonymous arrow yields `''`, which we report as `undefined` (no identity to
 * record). A non-function (a `KernelSymbol`) is never named here — its
 * `symbolId` is its address. See {@link StageDescriptor.handlerName}.
 */
function handlerNameOf(handler: unknown): string | undefined {
  return typeof handler === 'function' && handler.name !== '' ? handler.name : undefined;
}

// MARK: - Entry points

/**
 * Begin a pipeline.
 *
 * - `pipeline(symbol)` — with a leaf symbol: the pipe's `Input` is the
 *   symbol's payload type; the symbol's bound handler supplies the first
 *   verb (through `kernel.invoke`, like every symbol stage).
 * - `pipeline(meta, verbFn)` — with an anonymous verb-returning stage.
 *   Nothing pins `P` here (unlike `.pipe(meta, fn)`, where the chain fixes
 *   the cursor), so the lambda's parameters must be annotated:
 *   `pipeline({ note: 'guard' }, (kernel: Kernel, n: number) => …)`.
 */
export function pipeline<P, O>(symbol: KernelSymbol<P, O>): PipeBuilder<P, O>;
export function pipeline<P, O>(meta: VerbStageMeta, stage: VerbStageFn<P, O>): PipeBuilder<P, O>;
export function pipeline<P, O>(
  first: KernelSymbol<P, O> | VerbStageMeta,
  stage?: VerbStageFn<P, O>,
): PipeBuilder<P, O> {
  if ('id' in first) {
    const sym = first;
    return new PipeBuilder<P, O>([
      {
        descriptor: { kind: 'pipe(symbol)', symbolId: sym.id, note: sym.description, divertsTo: [] },
        run: (kernel, value, parentSpan) => kernel.invoke(sym.id, value, parentSpan),
      },
    ]);
  }
  const fn = stage as VerbStageFn<unknown, unknown>;
  const handlerName = handlerNameOf(fn);
  return new PipeBuilder<P, O>([
    {
      descriptor: {
        kind: handlerName === undefined ? 'pipe(closure)' : 'pipe(function)',
        note: first.note,
        divertsTo: first.divertsTo ?? [],
        handlerName,
      },
      run: (kernel, value) => fn(kernel, value),
    },
  ]);
}
