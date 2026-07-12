import { expect, test } from 'vitest';
import { next, pipeline, symbol, type Kernel } from '../src/index.js';

// MARK: - Fixtures

const entry = symbol<number, number>('handlerName.entry');
const sideEffect = symbol<number, void>('handlerName.sideEffect');

/** A named handler, so `fn.name === 'sleepForSpeed'` is readable at construction. */
async function sleepForSpeed(_kernel: Kernel, _n: number): Promise<void> {
  // no-op
}

/** A named pure transform. */
function double(n: number): number {
  return n * 2;
}

/** A named verb rule. */
function guard(_kernel: Kernel, n: number) {
  return next(n);
}

// MARK: - Named function handlers are declared by the runtime

test('effectStampsTheNamedFunctionsIdentityAsHandlerName', () => {
  const pipe = pipeline(entry).effect(sleepForSpeed).seal();
  const effectStage = pipe.descriptors[1]!;
  expect(effectStage.kind).toBe('effect(function)');
  expect(effectStage.handlerName).toBe('sleepForSpeed');
});

test('mapStampsTheNamedTransformsIdentity', () => {
  const pipe = pipeline(entry).map(double).seal();
  const mapStage = pipe.descriptors[1]!;
  expect(mapStage.kind).toBe('map(function)');
  expect(mapStage.handlerName).toBe('double');
});

test('verbStagesStampTheirNamedRuleBothAtEntryAndMidChain', () => {
  const pipe = pipeline({ note: 'entry guard' }, guard)
    .pipe({ note: 'mid guard' }, guard)
    .seal();
  const entryStage = pipe.descriptors[0]!;
  const midStage = pipe.descriptors[1]!;
  expect(entryStage.kind).toBe('pipe(function)');
  expect(entryStage.handlerName).toBe('guard');
  expect(midStage.kind).toBe('pipe(function)');
  expect(midStage.handlerName).toBe('guard');
});

// MARK: - Inline anonymous handlers carry no identity

test('inlineAnonymousArrowLeavesHandlerNameUndefined', () => {
  const pipe = pipeline(entry)
    .effect(async () => {})
    .map((n) => n + 1)
    .pipe({ note: 'inline guard' }, (_kernel, n) => next(n))
    .seal();
  const effectStage = pipe.descriptors[1]!;
  const mapStage = pipe.descriptors[2]!;
  const verbStage = pipe.descriptors[3]!;
  expect(effectStage.kind).toBe('effect(closure)');
  expect(effectStage.handlerName).toBeUndefined();
  expect(mapStage.kind).toBe('map(closure)');
  expect(mapStage.handlerName).toBeUndefined();
  expect(verbStage.kind).toBe('pipe(closure)');
  expect(verbStage.handlerName).toBeUndefined();
});

// MARK: - Symbol-backed stages keep identity in symbolId, not handlerName

test('symbolBackedStagesNeverStampHandlerNameBecauseSymbolIdIsTheirAddress', () => {
  const pipe = pipeline(entry).tap(sideEffect).seal();
  const pipeStage = pipe.descriptors[0]!;
  const tapStage = pipe.descriptors[1]!;

  // pipeline(symbol): a `KernelSymbol` is not a function, so no handlerName.
  expect(pipeStage.kind).toBe('pipe(symbol)');
  expect(pipeStage.symbolId).toBe('handlerName.entry');
  expect(pipeStage.handlerName).toBeUndefined();

  // .tap(symbol): same — symbolId carries identity, handlerName stays absent.
  expect(tapStage.kind).toBe('tap(symbol)');
  expect(tapStage.symbolId).toBe('handlerName.sideEffect');
  expect(tapStage.handlerName).toBeUndefined();
});
