import { expect, test } from 'vitest';
import {
  divert,
  diversion,
  fail,
  next,
  pipeline,
  symbol,
  KernelBuilder,
  TraceState,
  type ErasedStage,
  type Kernel,
  type TraceSink,
} from '../src/index.js';
import { mintSpan, type Span } from '../src/span.js';

// MARK: - mintSpan (pure data model)

test('mintSpan with no parent opens a root span', () => {
  const span = mintSpan();
  expect(span.id).toBeTruthy();
  expect(span.parentId).toBeUndefined();
});

test('mintSpan with a parent links parentId to the parent span id', () => {
  const root = mintSpan();
  const child = mintSpan(root);
  expect(child.parentId).toBe(root.id);
  expect(child.id).not.toBe(root.id);
});

test('mintSpan never repeats an id across calls', () => {
  const ids = new Set(Array.from({ length: 50 }, () => mintSpan().id));
  expect(ids.size).toBe(50);
});

// MARK: - Fixtures

const increment = symbol<number, number>('span.increment');
const double = symbol<number, number>('span.double');
const jump = symbol<number, number>('span.jump');

/**
 * Records every `{symbolId, span}` pair `onTrace` observes, in call order.
 * Parentage is read off
 * `span.parentId` (folded into `Span` itself) rather than a separate
 * `parentSpan` argument, since `onTrace`'s signature carries only one span.
 */
function spanRecorder(): {
  hits: Array<{ symbolId: string; span: Span }>;
  onTrace: TraceSink;
} {
  const hits: Array<{ symbolId: string; span: Span }> = [];
  return { hits, onTrace: (symbolId, _verb, span) => hits.push({ symbolId, span }) };
}

/** Build a kernel wired with the increment/double/jump fixtures, observed by `onTrace`. */
function makeKernel(onTrace: TraceSink): Kernel {
  const builder = new KernelBuilder();
  builder.register(increment, (n: number) => n + 1);
  builder.register(double, (n: number) => n * 2);
  builder.registerVerb(jump, () => divert(diversion(pipeline(double).seal(), 5)));
  return builder.build({ tracing: true, onTrace });
}

// MARK: - Propagation through Kernel.invoke/call

test('a bare kernel.call mints a root span (public entry points carry no parent)', async () => {
  const { hits, onTrace } = spanRecorder();
  const kernel = makeKernel(onTrace);

  await kernel.call(increment, 1);

  expect(hits).toHaveLength(1);
  expect(hits[0]?.span.parentId).toBeUndefined();
  expect(hits[0]?.symbolId).toBe(increment.id);
});

test('dispatch mints its own root span and returns it; the command nests one level under it', async () => {
  const { hits, onTrace } = spanRecorder();
  const kernel = makeKernel(onTrace);

  const span = kernel.dispatch(increment, 1);
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(span.parentId).toBeUndefined(); // a top-level dispatch's span is itself a true root
  expect(hits).toHaveLength(1);
  // The returned span carries no trace entry of its own (it's a synthetic
  // root) — the command's own invoke mints a child of it, so the recorded
  // entry's parent is the returned span, not undefined.
  expect(hits[0]?.span.parentId).toBe(span.id);
});

// MARK: - Propagation through Kernel.runStages (compose's pipe-stage loop)

test('sequential pipe stages in one top-level compose are independent roots', async () => {
  const { hits, onTrace } = spanRecorder();
  const kernel = makeKernel(onTrace);

  const result = await kernel.compose(pipeline(increment).pipe(double), 1);

  expect(result).toBe(4); // (1 + 1) * 2
  expect(hits).toHaveLength(2);
  // Neither stage was told about a parent — `compose`'s public signature has
  // no slot to receive one, so both mint as flow roots. See src/span.ts for
  // why this (not chaining stage-to-stage) is the documented, Swift-faithful
  // shape: Swift's own ambient span reverts between sibling stages too.
  expect(hits.every((h) => h.span.parentId === undefined)).toBe(true);
  expect(hits.map((h) => h.span.id)).toEqual([...new Set(hits.map((h) => h.span.id))]); // distinct spans
});

test('runStages forwards a supplied parentSpan to every stage it runs', async () => {
  const { hits, onTrace } = spanRecorder();
  const kernel = makeKernel(onTrace);
  const parent = mintSpan();

  await kernel.runStages(pipeline(increment).pipe(double).seal().erasedStages, 1, parent);

  expect(hits).toHaveLength(2);
  expect(hits.every((h) => h.span.parentId === parent.id)).toBe(true);
});

test('a divert jump keeps the same parentSpan for the diverted-to stages', async () => {
  const { hits, onTrace } = spanRecorder();
  const kernel = makeKernel(onTrace);
  const parent = mintSpan();

  const result = await kernel.runStages(pipeline(jump).seal().erasedStages, 1, parent);

  expect(result).toBe(10); // jump diverts to double(5)
  // `jump` itself, then `double` reached via divert — both under the same
  // run, so both under the same parent (runStages keeps parentSpan constant
  // across a divert, since it's a loop continuation, not a nested call).
  expect(hits).toHaveLength(2);
  expect(hits.every((h) => h.span.parentId === parent.id)).toBe(true);
});

// MARK: - Propagation through fork

test('fork forwards its own parentSpan into every branch, not the public compose path', async () => {
  const { hits, onTrace } = spanRecorder();
  const kernel = makeKernel(onTrace);
  const parent = mintSpan();

  const stages = pipeline(increment)
    .fork(pipeline<number, number>(double), pipeline<number, number>(increment))
    .seal().erasedStages;
  const [doubled, incremented] = (await kernel.runStages(stages, 1, parent)) as [number, number];

  expect(doubled).toBe(4); // (1+1) * 2
  expect(incremented).toBe(3); // (1+1) + 1
  expect(hits).toHaveLength(3); // the leading increment + the two branches
  expect(hits.every((h) => h.span.parentId === parent.id)).toBe(true);
});

test('fork branches mint root spans when the enclosing run has no parent', async () => {
  const { hits, onTrace } = spanRecorder();
  const kernel = makeKernel(onTrace);

  await kernel.compose(
    pipeline(increment).fork(pipeline<number, number>(double), pipeline<number, number>(increment)),
    1,
  );

  expect(hits).toHaveLength(3);
  expect(hits.every((h) => h.span.parentId === undefined)).toBe(true);
});

// MARK: - Handler call-backs through the span-scoped kernel (span linking)

const sum = symbol<number, number>('span.sum');
const orchestrate = symbol<number, number>('span.orchestrate');

test("a composing handler's own kernel.call records the nested call as a child of the handler's span", async () => {
  const { hits, onTrace } = spanRecorder();
  const builder = new KernelBuilder();
  builder.register(increment, (n: number) => n + 1);
  // Mirrors swift-kernelee ComposeTests.invokeBuildsACallTreeFromSpanAndParent:
  // the composing handler calls back twice; both call-backs nest under it.
  builder.register(
    sum,
    async (kernel: Kernel, n: number) => (await kernel.call(increment, n)) + (await kernel.call(increment, n)),
  );
  const kernel = builder.build({ tracing: true, onTrace });

  const result = await kernel.call(sum, 1);

  expect(result).toBe(4);
  const root = hits.find((h) => h.symbolId === sum.id);
  const leaves = hits.filter((h) => h.symbolId === increment.id);
  expect(root?.span.parentId).toBeUndefined();
  expect(leaves).toHaveLength(2);
  expect(leaves.every((leaf) => leaf.span.parentId === root?.span.id)).toBe(true);
  // invoke records once the handler returns, so children are observed first.
  expect(hits[hits.length - 1]?.symbolId).toBe(sum.id);
});

test('nesting composes transitively: a call-back inside a call-back links grandchild → child → root', async () => {
  const { hits, onTrace } = spanRecorder();
  const builder = new KernelBuilder();
  builder.register(increment, (n: number) => n + 1);
  builder.register(sum, (kernel: Kernel, n: number) => kernel.call(increment, n));
  builder.register(orchestrate, (kernel: Kernel, n: number) => kernel.call(sum, n));
  const kernel = builder.build({ tracing: true, onTrace });

  await kernel.call(orchestrate, 1);

  const rootHit = hits.find((h) => h.symbolId === orchestrate.id);
  const midHit = hits.find((h) => h.symbolId === sum.id);
  const leafHit = hits.find((h) => h.symbolId === increment.id);
  expect(rootHit?.span.parentId).toBeUndefined();
  expect(midHit?.span.parentId).toBe(rootHit?.span.id);
  expect(leafHit?.span.parentId).toBe(midHit?.span.id);
});

test("a handler's kernel.compose parents every stage under the handler's span", async () => {
  const { hits, onTrace } = spanRecorder();
  const builder = new KernelBuilder();
  builder.register(increment, (n: number) => n + 1);
  builder.register(double, (n: number) => n * 2);
  builder.register(orchestrate, (kernel: Kernel, n: number) =>
    kernel.compose(pipeline(increment).pipe(double), n),
  );
  const kernel = builder.build({ tracing: true, onTrace });

  const result = await kernel.call(orchestrate, 1);

  expect(result).toBe(4); // (1 + 1) * 2
  const root = hits.find((h) => h.symbolId === orchestrate.id);
  const stages = hits.filter((h) => h.symbolId !== orchestrate.id);
  expect(root?.span.parentId).toBeUndefined();
  expect(stages).toHaveLength(2);
  // Stages stay siblings under the handler (never chained to each other) —
  // the same Swift-faithful flatness the top-level compose test pins above.
  expect(stages.every((stage) => stage.span.parentId === root?.span.id)).toBe(true);
});

test("a handler's kernel.dispatch links the command's span to the handler — beyond Swift, whose drain task cannot", async () => {
  const { hits, onTrace } = spanRecorder();
  let dispatchedSpan: Span | undefined;
  const builder = new KernelBuilder();
  builder.register(increment, (n: number) => n + 1);
  builder.register(sum, (kernel: Kernel, n: number) => {
    dispatchedSpan = kernel.dispatch(increment, n);
    return n;
  });
  const kernel = builder.build({ tracing: true, onTrace });

  await kernel.call(sum, 1);
  await new Promise((resolve) => setTimeout(resolve, 0)); // drain the command bus

  const parent = hits.find((h) => h.symbolId === sum.id);
  const dispatched = hits.find((h) => h.symbolId === increment.id);
  // The enqueued closure captured the handler's span-scoped kernel, so the
  // linkage survives the bus's deferred execution (see Kernel.dispatch's doc
  // for why this deliberately exceeds Swift's dispatch behavior). `dispatch`
  // now mints its own root span first — parented under the handler — and the
  // command's own invoke nests one level further under *that*.
  expect(dispatchedSpan?.parentId).toBe(parent?.span.id);
  expect(dispatched?.span.parentId).toBe(dispatchedSpan?.id);
});

// MARK: - The `flow` correlation contract (dispatch's returned span as root)

test("dispatch's returned span is the single root every recorded entry's parentId chain walks up to (the arch_monitor `flow` correlation)", async () => {
  const builder = new KernelBuilder();
  builder.register(increment, (n: number) => n + 1);
  builder.register(
    sum,
    async (kernel: Kernel, n: number) => (await kernel.call(increment, n)) + (await kernel.call(increment, n)),
  );
  const kernel = builder.build({ tracing: true });

  const span = kernel.dispatch(sum, 1);
  await new Promise((resolve) => setTimeout(resolve, 0)); // drain the command bus

  const { entries } = kernel.buffer.read(TraceState);
  expect(entries.length).toBeGreaterThan(0);
  // Walk each entry's parentId chain (through the *other entries'* spans)
  // until it lands on an id no entry owns — that id must be exactly the
  // span dispatch returned, since the returned span is a synthetic root
  // that carries no trace entry of its own.
  const spanById = new Map(entries.map((e) => [e.span.id, e]));
  for (const entry of entries) {
    let cursor: string | undefined = entry.span.parentId;
    while (cursor !== undefined && spanById.has(cursor)) {
      cursor = spanById.get(cursor)?.span.parentId;
    }
    expect(cursor).toBe(span.id);
  }
});

test('with tracing off, dispatch still returns a Span, and fire-and-forget + error-sink behavior is unchanged', async () => {
  const errors: string[] = [];
  const boom = symbol<number, void>('span.boomOffTracing');
  const builder = new KernelBuilder();
  builder.registerVerb(boom, () => fail(new Error('boom')));
  builder.register(increment, (n: number) => n + 1);
  const kernel = builder.build({ onError: (source, error) => errors.push(`${source}:${(error as Error).message}`) }); // tracing defaults off

  const span = kernel.dispatch(increment, 1);
  expect(span.id).toBeTruthy();
  expect(span.parentId).toBeUndefined();

  kernel.dispatch(boom, 1);
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(errors).toEqual(['span.boomOffTracing:boom']);
});

test('a scoped kernel dispatches onto the same serial bus as the root kernel (submission order holds across views)', async () => {
  const order: string[] = [];
  const record = symbol<string, void>('span.record');
  const fire = symbol<void, void>('span.fire');
  const builder = new KernelBuilder();
  builder.register(record, (tag: string) => {
    order.push(tag);
  });
  builder.register(fire, (kernel: Kernel, _: void) => {
    kernel.dispatch(record, 'from-handler');
  });
  const kernel = builder.build({ tracing: true, onTrace: () => {} });

  await kernel.call(fire);
  kernel.dispatch(record, 'top-level');
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(order).toEqual(['from-handler', 'top-level']);
});

test('a call-back through a captured outer kernel (not the handler parameter) still mints a root — the documented edge', async () => {
  const { hits, onTrace } = spanRecorder();
  const builder = new KernelBuilder();
  builder.register(increment, (n: number) => n + 1);
  builder.register(sum, async (_kernel: Kernel, n: number) => outer.call(increment, n));
  const outer = builder.build({ tracing: true, onTrace });

  await outer.call(sum, 1);

  const leaf = hits.find((h) => h.symbolId === increment.id);
  expect(leaf?.span.parentId).toBeUndefined(); // bypassed the scoped view — no ambient context exists to save it
});

test('with tracing off, handlers receive the kernel itself and everything still works (no scoped view is allocated)', async () => {
  const builder = new KernelBuilder();
  builder.register(increment, (n: number) => n + 1);
  builder.register(sum, async (kernel: Kernel, n: number) => (await kernel.call(increment, n)) * 10);
  const kernel = builder.build(); // tracing defaults off

  expect(await kernel.call(sum, 1)).toBe(20);
});

// MARK: - ErasedStage stays backward-compatible (hand-rolled two-argument stages)

test('a hand-rolled two-argument ErasedStage (no parentSpan parameter) still runs under runStages', async () => {
  const legacyStage: ErasedStage = (_kernel, value) => next((value as number) * 10);
  const kernel = new KernelBuilder().build();

  const result = await kernel.runStages([legacyStage], 3);

  expect(result).toBe(30);
});
