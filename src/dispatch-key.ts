// MARK: - DispatchKey (typed divert-target token)

/**
 * A type-carrying token that identifies one divert target — the `divert`-side
 * counterpart of `KernelSymbol`. Minted once, referenced from two places that
 * used to have no link between them at all: a pipe's typed `divertsTo` map
 * (see `pipe.ts`'s `DivertTargets`/`DivertChannel`) and the binder call that
 * makes the target real (`KernelBuilder.flow`). `tsc` checks both sides
 * against the *same* `P`, so a typo, a rename, or a payload-shape drift
 * between "what a stage declares it might divert to" and "what `flow()`
 * actually bound" is a compile error instead of a silent runtime mismatch —
 * closing the gap `docs/wiring-graph.md` documents as a real bug that has
 * happened: a `divertsTo` string that names a *real but wrong* key passes
 * every existing check silently, because a free-string `divertsTo` entry has
 * no binder at all. `KernelSymbol` avoids that class of bug for `invoke`
 * targets via `Kernel`'s handler table; `DispatchKey` + `KernelBuilder.flow`
 * (see that method's own doc comment, including the alternative considered
 * and rejected for it) gives `divert` targets the same two-part treatment: a
 * typed token, plus a kernel-level binding.
 *
 * Structurally identical to `KernelSymbol` (`key`/`description`/`__phantom`)
 * by design — a divert target and an invoke target are the same shape of
 * problem (a name with no binder), so the fix is the same shape too. The
 * field is called `key`, not `id`, only to keep talking about the same noun
 * `StageDescriptor.divertsTo` (a `readonly string[]` of plain "keys") and
 * `PipeDescriptorEntry.key` already use — nothing else about the shape
 * differs from `KernelSymbol`.
 *
 * Deliberately dependency-free (no imports) — `verb.ts` (for `keyedDiversion`)
 * and `pipe.ts` (for the typed divert channel) both need this module, and a
 * leaf module with nothing to import from either of them cannot itself
 * create an import cycle no matter which of the two reaches for it first.
 */
export interface DispatchKey<in P> {
  readonly key: string;
  readonly description?: string;
  /**
   * Phantom brand — **never present at runtime** (nothing here assigns it;
   * it exists purely at the type level). Exists only so `P` participates in
   * assignability — a `DispatchKey<number>` is not interchangeable with a
   * `DispatchKey<string>` — mirroring `KernelSymbol.__phantom`. Contravariant
   * only (a `payload) => void` shape, not `KernelSymbol.__phantom`'s
   * `(payload) => O`): a divert target *consumes* a payload but has no typed
   * "return" of its own to pin — the diverted-to pipe's own output type
   * already governs what `divert` ultimately resolves to, same as the
   * untyped `Diversion` shape today.
   */
  readonly __phantom?: (payload: P) => void;
}

/**
 * Mint a dispatch key — the divert-side counterpart of `symbol()`.
 *
 * ```ts
 * const retryFlow = dispatchKey<RetryPayload>('flows.retry', 'retries the fetch with backoff');
 * ```
 */
export function dispatchKey<P>(key: string, description?: string): DispatchKey<P> {
  return description === undefined ? { key } : { key, description };
}
