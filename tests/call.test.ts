import { expect, test } from 'vitest';
import {
  abort,
  divert,
  diversion,
  fail,
  next,
  symbol,
  KernelBuilder,
  KernelError,
  type ErasedStage,
  type Kernel,
} from '../src/index.js';

// MARK: - Fixtures

const increment = symbol<number, number>('test.increment');
const stringify = symbol<number, string>('test.stringify');
/** A composing handler: calls `increment` twice through the kernel. */
const twice = symbol<number, number>('test.twice');
/** A verb-returning leaf: the *Driver* decides the verb (`fail` on negative). */
const guarded = symbol<number, number>('test.guarded');
/** A verb-returning leaf that `abort`s on zero — normal early termination. */
const shortCircuit = symbol<number, number>('test.shortCircuit');

class Boom extends Error {}

/** Build a kernel wired with the leaf fixtures — the Swift `makeKernel()` idiom. */
function makeKernel(): Kernel {
  const builder = new KernelBuilder();
  builder.register(increment, (n) => n + 1);
  builder.register(stringify, (n) => `${n}`);
  // Composing handlers annotate their parameters: TS overload resolution
  // cannot contextually type the two-parameter shape (see register's JSDoc).
  builder.register(twice, async (kernel: Kernel, n: number) =>
    kernel.call(increment, await kernel.call(increment, n)),
  );
  builder.registerVerb(guarded, (n) => (n < 0 ? fail(new Boom()) : next(n * 2)));
  builder.registerVerb(shortCircuit, (n) => (n === 0 ? abort(-1) : next(n)));
  return builder.build();
}

// MARK: - Typed round trip

test('callReturnsTheTypedOutputOfALeafHandler', async () => {
  const kernel = makeKernel();
  const incremented: number = await kernel.call(increment, 41);
  expect(incremented).toBe(42);
  const rendered: string = await kernel.call(stringify, 42);
  expect(rendered).toBe('42');
});

test('composingHandlerReceivesTheKernelAndCallsOtherSymbols', async () => {
  const kernel = makeKernel();
  expect(await kernel.call(twice, 40)).toBe(42);
});

// MARK: - Unbound

test('callingAnUnboundSymbolRejectsWithKernelErrorUnbound', async () => {
  const kernel = makeKernel();
  const unbound = symbol<number, number>('test.unbound');
  const attempt = kernel.call(unbound, 1);
  await expect(attempt).rejects.toBeInstanceOf(KernelError);
  await expect(kernel.call(unbound, 1)).rejects.toMatchObject({
    code: 'unbound',
    symbolId: 'test.unbound',
  });
});

// MARK: - Verb-returning handlers (the Driver owns the verb)

/** `call` interprets the handler's verb down to the symbol's output. */
test('verbReturningHandlerIsInterpretedByCall', async () => {
  const kernel = makeKernel();
  expect(await kernel.call(guarded, 3)).toBe(6); // next(6) -> 6
  await expect(kernel.call(guarded, -1)).rejects.toBeInstanceOf(Boom); // fail -> reject
});

/**
 * Swift `interpret` returns an `abort`'s value through the same boundary as
 * `next` — via `call`, a normal early termination is indistinguishable from a
 * completed run.
 */
test('abortAtCallYieldsItsValueAsTheResult', async () => {
  const kernel = makeKernel();
  expect(await kernel.call(shortCircuit, 5)).toBe(5); // next passes through
  expect(await kernel.call(shortCircuit, 0)).toBe(-1); // abort(-1) is the result
});

// MARK: - divert at call (Swift interpret: run the diverted-to stages, iteratively)

test('divertAtCallRunsTheDivertedStagesAndReturnsTheirResult', async () => {
  const addOne: ErasedStage = (_kernel, value) => next((value as number) + 1);
  const double: ErasedStage = (_kernel, value) => next((value as number) * 2);
  const jump = symbol<number, number>('test.jump');
  const builder = new KernelBuilder();
  builder.registerVerb(jump, (n) => divert(diversion([addOne, double], n)));
  const kernel = builder.build();

  expect(await kernel.call(jump, 10)).toBe(22); // 10 -> +1 -> 11 -> *2 -> 22
});

/**
 * A diverted-to stage list that diverts back to itself is spliced into the
 * same iteration (stages/value replaced, index reset) — the agent-loop shape
 * `divert` exists for. The loop terminates through a plain `abort`.
 */
test('divertLoopIteratesUntilAStageAborts', async () => {
  const loop: ErasedStage[] = [];
  loop.push((_kernel, value) => {
    const n = value as number;
    return n >= 1000 ? abort(n) : divert(diversion(loop, n * 2));
  });
  const spin = symbol<number, number>('test.spin');
  const builder = new KernelBuilder();
  builder.registerVerb(spin, (n) => divert(diversion(loop, n)));
  const kernel = builder.build();

  expect(await kernel.call(spin, 1)).toBe(1024); // 1 -> 2 -> ... -> 1024 (>= 1000)
});

/** A `fail` inside a diverted-to stage throws out of the originating `call`. */
test('failInsideADivertedStageRejectsTheCall', async () => {
  const explode: ErasedStage = () => fail(new Boom());
  const jump = symbol<number, number>('test.jump.fail');
  const builder = new KernelBuilder();
  builder.registerVerb(jump, (n) => divert(diversion([explode], n)));
  const kernel = builder.build();

  await expect(kernel.call(jump, 1)).rejects.toBeInstanceOf(Boom);
});

// MARK: - void-payload sugar

test('voidPayloadSymbolIsCallableWithoutAPayload', async () => {
  const ping = symbol<void, string>('test.ping');
  const builder = new KernelBuilder();
  builder.register(ping, () => 'pong');
  const kernel = builder.build();

  expect(await kernel.call(ping)).toBe('pong');
});
