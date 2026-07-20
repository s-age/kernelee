import { expect, test, vi } from 'vitest';
import {
  abort,
  BufferError,
  KernelBuilder,
  fail,
  symbol,
  TraceState,
  type TraceEntry,
  type TraceSink,
} from '../src/index.js';
import { appendTraceEntry, describeTracePayload, type TraceStateValue } from '../src/trace.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `condition` holds, bounded so a stuck bus fails instead of hanging. */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 1000; i += 1) {
    if (condition()) return;
    await sleep(1);
  }
  throw new Error('condition never held');
}

// MARK: - appendTraceEntry (pure data model)

function entry(symbolId: string): Omit<TraceEntry, 'id'> {
  return { symbolId, verb: 'next', span: { id: 'span-1' }, payload: undefined, timestamp: 0 };
}

test('appendTraceEntry assigns a monotonic id starting at 0', () => {
  let state: TraceStateValue = { entries: [] };
  state = appendTraceEntry(state, entry('a'), 300);
  state = appendTraceEntry(state, entry('b'), 300);
  state = appendTraceEntry(state, entry('c'), 300);

  expect(state.entries.map((e) => e.id)).toEqual([0, 1, 2]);
  expect(state.entries.map((e) => e.symbolId)).toEqual(['a', 'b', 'c']);
});

test('appendTraceEntry keeps entries under cap*1.25 untouched', () => {
  let state: TraceStateValue = { entries: [] };
  for (let i = 0; i < 5; i += 1) {
    state = appendTraceEntry(state, entry(`s${i}`), 4); // cap 4, threshold 5 — not yet exceeded
  }
  expect(state.entries).toHaveLength(5);
});

test('appendTraceEntry trims to cap once cap*1.25 is exceeded, keeping the most recent and monotonic ids', () => {
  let state: TraceStateValue = { entries: [] };
  for (let i = 0; i < 6; i += 1) {
    state = appendTraceEntry(state, entry(`s${i}`), 4); // cap 4, threshold 5 — 6th append overshoots
  }
  expect(state.entries).toHaveLength(4);
  // The oldest two (`s0`, `s1`) are dropped; ids stay monotonic across the trim.
  expect(state.entries.map((e) => e.symbolId)).toEqual(['s2', 's3', 's4', 's5']);
  expect(state.entries.map((e) => e.id)).toEqual([2, 3, 4, 5]);
});

// MARK: - describeTracePayload

test('describeTracePayload renders undefined payload as undefined (no "undefined" string)', () => {
  expect(describeTracePayload(undefined)).toBeUndefined();
});

test('describeTracePayload JSON-renders a serializable payload', () => {
  expect(describeTracePayload({ n: 1 })).toBe('{"n":1}');
  expect(describeTracePayload(42)).toBe('42');
});

test('describeTracePayload falls back to String() for a non-serializable payload', () => {
  const circular: { self?: unknown } = {};
  circular.self = circular;
  expect(describeTracePayload(circular)).toBe(String(circular));

  const fn = () => 1;
  expect(describeTracePayload(fn)).toBe(String(fn));
});

test('describeTracePayload caps at 1024 chars with an ellipsis', () => {
  const long = 'x'.repeat(2000);
  const rendered = describeTracePayload(long);
  expect(rendered).toHaveLength(1025); // 1024 chars + the ellipsis mark
  expect(rendered?.endsWith('…')).toBe(true);
});

test('describeTracePayload summarizes binary buffers as O(1) name(size), at any depth', () => {
  // Nested in a payload object — the hot-path shape (a board-carrying DTO):
  // the summary must land where the field is, not replace the whole payload.
  const cells = new Uint8Array(3072);
  expect(describeTracePayload({ cells, width: 64, start: 0 })).toBe(
    '{"cells":"Uint8Array(3072)","width":64,"start":0}',
  );
  // Top-level, other element widths, DataView (no length → byteLength), raw ArrayBuffer.
  expect(describeTracePayload(new Float64Array(8))).toBe('"Float64Array(8)"');
  expect(describeTracePayload(new DataView(new ArrayBuffer(12)))).toBe('"DataView(12)"');
  expect(describeTracePayload(new ArrayBuffer(7))).toBe('"ArrayBuffer(7)"');
});

// MARK: - Kernel wiring

const echo = symbol<number, number>('trace.echo');

test('tracing off: TraceState is never allocated, and invoke pays no sink cost', async () => {
  const builder = new KernelBuilder();
  builder.register(echo, (n: number) => n);
  const kernel = builder.build(); // tracing defaults to false

  await kernel.call(echo, 1);

  expect(() => kernel.buffer.read(TraceState)).toThrowError(BufferError);
  try {
    kernel.buffer.read(TraceState);
  } catch (error) {
    expect((error as BufferError).code).toBe('unallocated');
  }
});

test('tracing on with no custom sink: the default sink records every invoke into TraceState', async () => {
  const builder = new KernelBuilder();
  builder.register(echo, (n: number) => n);
  const kernel = builder.build({ tracing: true });

  await kernel.call(echo, 7);

  const { entries } = kernel.buffer.read(TraceState);
  expect(entries).toHaveLength(1);
  expect(entries[0]?.symbolId).toBe(echo.id);
  expect(entries[0]?.verb).toBe('next');
  expect(entries[0]?.payload).toBe('7');
  expect(entries[0]?.span.parentId).toBeUndefined();
  expect(typeof entries[0]?.timestamp).toBe('number');
});

test('an injected onTrace replaces the default sink entirely — TraceState stays empty', async () => {
  const hits: Array<{ symbolId: string }> = [];
  const onTrace: TraceSink = (symbolId) => hits.push({ symbolId });

  const builder = new KernelBuilder();
  builder.register(echo, (n: number) => n);
  const kernel = builder.build({ tracing: true, onTrace });

  await kernel.call(echo, 1);

  expect(hits).toHaveLength(1);
  expect(hits[0]?.symbolId).toBe(echo.id);
  expect(kernel.buffer.read(TraceState).entries).toHaveLength(0);
});

test('traceCap is honored by the default sink', async () => {
  const builder = new KernelBuilder();
  builder.register(echo, (n: number) => n);
  const kernel = builder.build({ tracing: true, traceCap: 4 });

  for (let i = 0; i < 6; i += 1) {
    await kernel.call(echo, i);
  }

  expect(kernel.buffer.read(TraceState).entries).toHaveLength(4);
});

test('an injected onTrace without tracing:true is never called — tracing is the single master switch', async () => {
  const hits: unknown[] = [];
  const onTrace: TraceSink = () => hits.push(undefined);

  const builder = new KernelBuilder();
  builder.register(echo, (n: number) => n);
  const kernel = builder.build({ onTrace }); // tracing defaults to false

  await kernel.call(echo, 1);

  expect(hits).toHaveLength(0);
  expect(() => kernel.buffer.read(TraceState)).toThrowError(BufferError);
});

// MARK: - Failure paths are still recorded

const boom = symbol<number, number>('trace.boom');
const boomVerb = symbol<number, number>('trace.boomVerb');

test('a handler that throws is still recorded, as a "fail" entry, before the error rethrows', async () => {
  const builder = new KernelBuilder();
  builder.register(boom, () => {
    throw new Error('kaboom');
  });
  const kernel = builder.build({ tracing: true });

  await expect(kernel.call(boom, 1)).rejects.toThrow('kaboom');

  const { entries } = kernel.buffer.read(TraceState);
  expect(entries).toHaveLength(1);
  expect(entries[0]?.symbolId).toBe(boom.id);
  expect(entries[0]?.verb).toBe('fail');
  expect(entries[0]?.payload).toBe('1');
});

test('an explicit fail(...) verb is recorded as "fail" too, same as a thrown error', async () => {
  const builder = new KernelBuilder();
  builder.registerVerb(boomVerb, () => fail(new Error('explicit fail')));
  const kernel = builder.build({ tracing: true });

  await expect(kernel.call(boomVerb, 2)).rejects.toThrow('explicit fail');

  const { entries } = kernel.buffer.read(TraceState);
  expect(entries).toHaveLength(1);
  expect(entries[0]?.verb).toBe('fail');
});

// MARK: - onTrace containment: observation never changes program behavior

test('a sink that throws is contained per-call, not latched: the call still resolves, and the next call is traced normally', async () => {
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    let calls = 0;
    const seen: string[] = [];
    const onTrace: TraceSink = (symbolId) => {
      calls += 1;
      if (calls === 1) throw new Error('sink boom');
      seen.push(symbolId);
    };
    const builder = new KernelBuilder();
    builder.register(echo, (n: number) => n);
    const kernel = builder.build({ tracing: true, onTrace });

    await expect(kernel.call(echo, 1)).resolves.toBe(1); // resolves, not rejected, despite the sink throwing
    expect(errorSpy).toHaveBeenCalledTimes(1);

    await expect(kernel.call(echo, 2)).resolves.toBe(2); // containment is per-call, not a one-shot latch
    expect(seen).toEqual([echo.id]);
  } finally {
    errorSpy.mockRestore();
  }
});

test('a sink that throws does not mask the handler\'s own thrown error', async () => {
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const onTrace: TraceSink = () => {
      throw new Error('sink boom');
    };
    const builder = new KernelBuilder();
    builder.register(boom, () => {
      throw new Error('kaboom');
    });
    const kernel = builder.build({ tracing: true, onTrace });

    await expect(kernel.call(boom, 1)).rejects.toThrow('kaboom'); // the handler's error, never the sink's
    expect(errorSpy).toHaveBeenCalledTimes(1);
  } finally {
    errorSpy.mockRestore();
  }
});

test('a sink that throws does not phantom-fail a successful dispatch — the injected error sink is never called', async () => {
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const errors: string[] = [];
    const onTrace: TraceSink = () => {
      throw new Error('sink boom');
    };
    const ok = symbol<number, void>('trace.dispatchOk');
    const builder = new KernelBuilder();
    builder.register(ok, () => {});
    const kernel = builder.build({
      tracing: true,
      onTrace,
      onError: (symbolId, error) => {
        errors.push(`${symbolId}:${(error as Error).message}`);
      },
    });

    kernel.dispatch(ok, 1);
    await until(() => errorSpy.mock.calls.length >= 1); // wait for the sink's containment to have run
    expect(errors).toHaveLength(0); // no phantom failure reached the error sink
  } finally {
    errorSpy.mockRestore();
  }
});

const evilPayload = {
  toJSON(): never {
    throw new Error('boom-json');
  },
  toString(): never {
    throw new Error('boom-string');
  },
};

test('a payload that defeats both rendering tiers degrades to <unrenderable> rather than dropping the entry', async () => {
  const passthrough = symbol<unknown, unknown>('trace.evilPayload');
  const builder = new KernelBuilder();
  builder.register(passthrough, (p: unknown) => p);
  const kernel = builder.build({ tracing: true });

  await expect(kernel.call(passthrough, evilPayload)).resolves.toBe(evilPayload);

  const { entries } = kernel.buffer.read(TraceState);
  expect(entries).toHaveLength(1);
  expect(entries[0]?.verb).toBe('next');
  expect(entries[0]?.payload).toBe('<unrenderable>');
});

test('a payload that defeats both rendering tiers still records the "fail" entry, with <unrenderable> payload', async () => {
  const boomEvil = symbol<unknown, void>('trace.boomEvilPayload');
  const builder = new KernelBuilder();
  builder.register(boomEvil, () => {
    throw new Error('kaboom');
  });
  const kernel = builder.build({ tracing: true });

  await expect(kernel.call(boomEvil, evilPayload)).rejects.toThrow('kaboom');

  const { entries } = kernel.buffer.read(TraceState);
  expect(entries).toHaveLength(1);
  expect(entries[0]?.verb).toBe('fail');
  expect(entries[0]?.payload).toBe('<unrenderable>');
});

// MARK: - abort/fail desc surfaces on the trace entry (additive)

const abortWithDesc = symbol<number, number>('trace.abortWithDesc');
const abortWithoutDesc = symbol<number, number>('trace.abortWithoutDesc');
const failWithDesc = symbol<number, number>('trace.failWithDesc');

test('an abort(value, desc) verb is recorded with its desc on the trace entry', async () => {
  const builder = new KernelBuilder();
  builder.registerVerb(abortWithDesc, () => abort(-1, 'guard tripped'));
  const kernel = builder.build({ tracing: true });

  await expect(kernel.call(abortWithDesc, 1)).resolves.toBe(-1);

  const { entries } = kernel.buffer.read(TraceState);
  expect(entries).toHaveLength(1);
  expect(entries[0]?.verb).toBe('abort');
  expect(entries[0]?.desc).toBe('guard tripped');
});

test('an abort(value) verb with no desc leaves the desc property absent on the trace entry', async () => {
  const builder = new KernelBuilder();
  builder.registerVerb(abortWithoutDesc, () => abort(-1));
  const kernel = builder.build({ tracing: true });

  await expect(kernel.call(abortWithoutDesc, 1)).resolves.toBe(-1);

  const { entries } = kernel.buffer.read(TraceState);
  expect(entries).toHaveLength(1);
  expect(entries[0]?.verb).toBe('abort');
  expect(entries[0]?.desc).toBeUndefined();
  expect('desc' in entries[0]!).toBe(false);
});

test('a fail(error, desc) verb is recorded with its desc on the trace entry', async () => {
  const builder = new KernelBuilder();
  builder.registerVerb(failWithDesc, () => fail(new Error('kaboom'), 'validation failed'));
  const kernel = builder.build({ tracing: true });

  await expect(kernel.call(failWithDesc, 1)).rejects.toThrow('kaboom');

  const { entries } = kernel.buffer.read(TraceState);
  expect(entries).toHaveLength(1);
  expect(entries[0]?.verb).toBe('fail');
  expect(entries[0]?.desc).toBe('validation failed');
});

test('a thrown error (not an explicit fail(...)) still records with no desc', async () => {
  const boomNoDesc = symbol<number, number>('trace.boomNoDesc');
  const builder = new KernelBuilder();
  builder.register(boomNoDesc, () => {
    throw new Error('kaboom');
  });
  const kernel = builder.build({ tracing: true });

  await expect(kernel.call(boomNoDesc, 1)).rejects.toThrow('kaboom');

  const { entries } = kernel.buffer.read(TraceState);
  expect(entries).toHaveLength(1);
  expect(entries[0]?.desc).toBeUndefined();
  expect('desc' in entries[0]!).toBe(false);
});
