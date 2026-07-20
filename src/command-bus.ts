/**
 * A serial, fire-and-forget command queue — the "mutex" behind
 * `Kernel.dispatch`.
 *
 * `enqueue` returns immediately (the caller's stack stays shallow); the work
 * runs strictly one at a time in submission order. That ordering is the point:
 * two commands fired back to back never interleave, so an authoritative
 * reload can't race a create that was submitted just before it. Each work item
 * owns its own error handling — the bus only sequences.
 *
 * The implementation is a serial promise chain: each `enqueue` appends to
 * `queue`, so a work item starts only after its predecessor settles — even
 * when the predecessor is async, a later submission never overtakes it.
 *
 * (Time-travel hooks — suspend/resume draining — are not implemented.)
 */
export class CommandBus {
  #queue: Promise<void> = Promise.resolve();

  enqueue(work: () => Promise<void>): void {
    // `Kernel.dispatch` wraps every command in try/catch and routes failures
    // to the error sink, so `work` should never reject. The trailing catch is
    // a safety net (e.g. a throwing sink): without it one rejection would
    // poison the chain and silently drop every later command.
    this.#queue = this.#queue.then(work).catch(() => {});
  }
}
