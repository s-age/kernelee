import type { Verb } from './verb.js';
import type { Span } from './span.js';
import { defineState, type StateKey } from './buffer.js';

// MARK: - TraceEntry

/**
 * The verb discriminant a trace entry records. Swift keeps a separate
 * `TraceVerb` enum; TS's `Verb.kind` is already the same discriminant, so
 * reusing it (rather than minting a parallel vocabulary) is free.
 */
export type TraceVerbKind = Verb<unknown>['kind'];

/**
 * Notified once per `Kernel.invoke`, right after its handler resolves.
 * Deliberately thin, mirroring `onError`/`KernelErrorState`: the raw sink carries no `id`
 * (`span` already carries `{id, parentId?}`, folding Swift's separate
 * `(span, parent)` pair into one argument) — assigning the monotonic `id`
 * that lands in a `TraceEntry` is `appendTraceEntry`'s job alone, done only
 * once a sink chooses to record into {@link TraceState}.
 */
export type TraceSink = (
  symbolId: string,
  verb: TraceVerbKind,
  span: Span,
  payload: string | undefined,
  timestamp: number,
) => void;

/** One recorded `Kernel.invoke` pass, as stored in {@link TraceState}. */
export interface TraceEntry {
  /** Monotonic within one `TraceState` cell — assigned by {@link appendTraceEntry}. */
  readonly id: number;
  readonly symbolId: string;
  readonly verb: TraceVerbKind;
  readonly span: Span;
  /** Rendered by {@link describeTracePayload}; absent for a `void` payload. */
  readonly payload?: string;
  readonly timestamp: number;
}

// MARK: - TraceState

export interface TraceStateValue {
  readonly entries: readonly TraceEntry[];
}

/**
 * The buffer cell the default trace sink writes into — same `defineState` idiom as
 * every other app state, not a special case wired inside `buffer.ts` (unlike
 * `KernelErrorState`, which is a release feature seeded unconditionally):
 * this cell is only allocated when `KernelBuildOptions.tracing` is on
 * (`KernelBuilder.build`), mirroring Swift's monitor states existing only in
 * DEBUG builds.
 */
export const TraceState: StateKey<TraceStateValue> = defineState<TraceStateValue>('TraceState', { entries: [] });

/**
 * Append one entry, assigning its monotonic `id`, then trim once the ring
 * has overshot `cap` by 25% — Swift's `TraceState.record` batch-trim policy,
 * carried over verbatim: `Array.prototype.shift`-per-append is O(cap) each
 * time, so paying it once per 1.25×`cap` entries (dropping straight to
 * `cap`) is cheaper than paying a smaller O(1)-amortized cost every append.
 */
export function appendTraceEntry(
  state: TraceStateValue,
  entry: Omit<TraceEntry, 'id'>,
  cap: number,
): TraceStateValue {
  const lastId = state.entries.at(-1)?.id;
  const entries = [...state.entries, { ...entry, id: lastId === undefined ? 0 : lastId + 1 }];
  if (entries.length > cap * 1.25) {
    return { entries: entries.slice(entries.length - cap) };
  }
  return { entries };
}

// MARK: - Payload rendering

/** `describeTracePayload`'s truncation point — Swift's `describePayload` cap, carried over. */
const PAYLOAD_CAP = 1024;

/**
 * `JSON.stringify` replacer that summarizes binary buffers instead of
 * enumerating them. A `TypedArray` has no `toJSON`, so `JSON.stringify`
 * walks it as a plain object — one numeric key per element. That makes the
 * render cost O(elements) *before* the {@link PAYLOAD_CAP} slice can bound
 * anything, and it runs on every `invoke` while tracing is on: a payload
 * carrying a whole board (`Uint8Array(3072)`) measured ~0.13ms per render,
 * ×3072 invokes/generation ≈ 400ms/generation at cell granularity.
 * The element values are also the least
 * informative part of a trace line — what a reader needs is *which* buffer
 * and *how big*, which is exactly the fact the runtime already holds in its
 * hand (`constructor.name` + `length`), so summarizing is not lossy
 * truncation but the honest O(1) rendering of it.
 *
 * Returning the summary *from the replacer* is what makes it cheap: the
 * replacer runs before serialization descends into the value, so the
 * per-element walk never starts.
 */
function summarizeBinaryViews(_key: string, value: unknown): unknown {
  if (ArrayBuffer.isView(value)) {
    // TypedArrays report elements (`length`); DataView has no `length`, so
    // its size is its `byteLength`.
    const size = 'length' in value ? (value as { length: number }).length : value.byteLength;
    return `${value.constructor.name}(${size})`;
  }
  if (value instanceof ArrayBuffer) {
    return `ArrayBuffer(${value.byteLength})`;
  }
  return value;
}

/**
 * Render a traced payload to a bounded string. Swift's `dump` (a
 * `Mirror`-based pretty-printer) has no zero-dep TS equivalent, so this
 * falls back through two tiers: `JSON.stringify` for anything serializable,
 * then `String(payload)` for what throws (cycles, functions, `bigint`, …).
 * `undefined` in, `undefined` out — a `void`-payload symbol renders no
 * payload at all rather than the string `"undefined"`.
 *
 * Binary buffers (TypedArrays / `DataView` / `ArrayBuffer`) render as an
 * O(1) `"Uint8Array(3072)"`-style summary, at any nesting depth — see
 * {@link summarizeBinaryViews} for why per-element rendering is both a
 * measured hot-path cost and less informative than the summary.
 */
export function describeTracePayload(payload: unknown): string | undefined {
  if (payload === undefined) {
    return undefined;
  }
  let text: string;
  try {
    text = JSON.stringify(payload, summarizeBinaryViews) ?? String(payload);
  } catch {
    text = String(payload);
  }
  return text.length > PAYLOAD_CAP ? `${text.slice(0, PAYLOAD_CAP)}…` : text;
}
