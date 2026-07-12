/**
 * A type-carrying token that identifies one callable endpoint.
 *
 * `KernelSymbol` is a *phantom-typed* descriptor: it stores only a string `id`
 * (plus an optional `description`) at runtime, but its generic parameters pin
 * the payload and output types at compile time. `Kernel.call` is generic over
 * those parameters, so passing the wrong payload — or assigning the result to
 * the wrong type — is a compile error. The string `id` is what the kernel uses
 * to look up the bound handler.
 *
 * The symbol *constants* built from it — `Storage.Notes.fetchAll` etc. —
 * typically live in a shared contract module alongside the payload/output
 * types they reference.
 *
 * `description` is the part's documentation as data: a symbol generator can
 * lift a doc comment here so "what this part does" travels with the symbol,
 * without a separate, drift-prone lookup. `undefined` for an undocumented or
 * hand-written symbol.
 *
 * Named `KernelSymbol` (not `Symbol`) to avoid colliding with the ECMAScript
 * global `Symbol`.
 */
export interface KernelSymbol<in P, out O> {
  readonly id: string;
  readonly description?: string;
  /**
   * Phantom brand — **never present at runtime**. It exists only so `P` and
   * `O` participate in assignability (a `KernelSymbol<number, string>` is not
   * interchangeable with a `KernelSymbol<string, number>`). The function shape
   * makes `P` contravariant and `O` covariant, mirroring a callable endpoint.
   */
  readonly __phantom?: (payload: P) => O;
}

/**
 * Mint a symbol. The Swift counterpart is `Symbol<P, O>.init(_:description:)`.
 *
 * ```ts
 * const fetchAll = symbol<void, Note[]>('storage.notes.fetchAll');
 * ```
 */
export function symbol<P, O>(id: string, description?: string): KernelSymbol<P, O> {
  return description === undefined ? { id } : { id, description };
}
