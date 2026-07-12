// MARK: - Span

/**
 * One node's identity in the call tree `Kernel.invoke` rebuilds as data.
 *
 * Swift pairs a `@TaskLocal static var span: UUID?` with `traced`'s
 * `withValue` (Kernel+Trace.swift:18,36 in swift-kernelee): every nested
 * `invoke` — including a composing handler's own follow-up `kernel.call`, and
 * `async let`/`TaskGroup` fan-out, which inherits task-locals at creation —
 * sees its enclosing invoke as `parent` for free, with zero threading at the
 * call sites. TS has no ambient-execution-context primitive that behaves the
 * same in both Node and the browser: `AsyncLocalStorage` exists, but only on
 * Node, so relying on it would make trace completeness silently depend on
 * which runtime a given `kernel.call` happens to execute in — a strictly
 * worse failure mode for a devtools feature than a *documented, uniform* gap.
 *
 * Decision: thread the parent explicitly as a plain function argument,
 * confined to the call sites the framework itself controls — `Kernel.invoke`,
 * `Kernel.runStages` (the pipe-stage loop, including its divert jump) and
 * `fork`'s branch dispatch. Changing handler signatures to carry a span was
 * rejected — it would break every `register`/`registerVerb` handler's shape
 * for a devtools-only concern.
 *
 * For a *user* handler calling back into `kernel.call`/`dispatch`/`compose`/
 * `run` from its own body, the channel already exists — a composing handler
 * receives the kernel as its first argument.
 * `Kernel.invoke` hands each handler a *span-scoped view* of the kernel
 * (same handler table, command bus, buffer and sinks; only the ambient span
 * differs), and the four public entry points parent their spans under their
 * own instance's ambient span. Handler signatures are untouched — the scoping
 * rides on the value every handler is already given. This is Swift's
 * `Kernel.$span.withValue(span) { body() }` carried on the kernel *value*
 * instead of the task, so it is runtime-independent by construction — no
 * `AsyncLocalStorage`, no Node/browser divergence. Two edges of the design:
 * - A handler that ignores its `kernel` parameter and calls back through a
 *   kernel reference captured *from outside* bypasses the scoped view and
 *   still mints roots — call through the parameter. (Swift's task-locals
 *   have no such edge; this is the residual, documented cost of having no
 *   ambient context.)
 * - `dispatch` links too, which is deliberately *more* than Swift: the Swift
 *   drain task's task-locals freeze at kernel construction
 *   (CommandBus.swift:19-25), losing dispatch parentage, while the TS bus
 *   carries closures that capture the scoped kernel — the causally truthful
 *   link is free here, so we keep it.
 */
export interface Span {
  readonly id: string;
  /** The enclosing span, or `undefined` at a flow root — mirrors Swift's `parent: UUID?`. */
  readonly parentId?: string;
}

/**
 * Open a new span linked to `parent` (`undefined` for a flow root).
 * `crypto.randomUUID()` mirrors Swift's `UUID()`: collision-safe and, unlike
 * `AsyncLocalStorage`, a standard global present in both Node and the browser
 * — no dependency added, no runtime-specific branch.
 */
export function mintSpan(parent?: Span): Span {
  return parent === undefined ? { id: crypto.randomUUID() } : { id: crypto.randomUUID(), parentId: parent.id };
}
