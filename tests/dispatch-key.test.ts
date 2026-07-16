import { expect, test } from 'vitest';
import {
  abort,
  dispatchKey,
  divert,
  keyedDiversion,
  next,
  pipeline,
  projectWiringGraph,
  symbol,
  KernelBuilder,
  KernelError,
  type DispatchKey,
  type Kernel,
  type Verb,
} from '../src/index.js';

// MARK: - Fixtures

const double = symbol<number, number>('dispatchKey.double');

// MARK: - dispatchKey minting

test('dispatchKeyMintsAKeyWithAnOptionalDescription', () => {
  const described = dispatchKey<number>('flow.described', 'retries with a smaller payload');
  expect(described).toEqual({ key: 'flow.described', description: 'retries with a smaller payload' });

  const bare = dispatchKey<number>('flow.bare');
  expect(bare).toEqual({ key: 'flow.bare' });
  expect('description' in bare).toBe(false); // omitted, not merely undefined — mirrors `symbol()`
});

// MARK: - Typed channel end-to-end

test('typedDivertChannelResolvesThroughFlowAndTheDivertedPipesResultBecomesTheRunsResult', async () => {
  const retryFlow = dispatchKey<number>('flow.e2e.retry', 'doubles a positive-flipped payload');
  const retryPipe = pipeline(double).seal();

  const entryPipe = pipeline(
    { note: 'divert negatives to the retry flow', divertsTo: { retry: retryFlow } },
    (_kernel: Kernel, n: number, diverts): Verb<number> => (n < 0 ? diverts.retry(-n) : next(n)),
  ).seal();

  const builder = new KernelBuilder();
  builder.register(double, (n) => n * 2);
  builder.flow(retryFlow, 'retryPipe', retryPipe);
  const kernel = builder.build();

  // Positive payload: no divert, flows straight through.
  expect(await kernel.compose(entryPipe, 5)).toBe(5);
  // Negative payload: diverts to retryFlow with the flipped payload; retryPipe's
  // own result (double) becomes the run's result.
  expect(await kernel.compose(entryPipe, -5)).toBe(10);

  // The descriptor's `divertsTo` carries the same string key the legacy tier
  // would — the JSON shape never changes between tiers.
  expect(entryPipe.descriptors[0]!.divertsTo).toEqual(['flow.e2e.retry']);
});

// MARK: - Self-divert continuation loop (iterative jump via the key form)

test('selfDivertingKeyLoopIteratesRatherThanRecursing', async () => {
  const iterations = 50_000;
  const countdown = dispatchKey<number>('flow.countdown');
  const countdownPipe = pipeline(
    { note: 'counts down to zero via a self key-divert', divertsTo: { loop: countdown } },
    (_kernel: Kernel, n: number, diverts): Verb<number> => (n <= 0 ? abort(n) : diverts.loop(n - 1)),
  ).seal();

  const builder = new KernelBuilder();
  builder.flow(countdown, 'countdownPipe', countdownPipe);
  const kernel = builder.build();

  // A high iteration count is the regression guard: if the key form ever
  // regressed to a recursive `compose` per hop this would blow the stack or
  // become dramatically slower, mirroring `compose.test.ts`'s
  // `divertLoopIsIterativeNotRecursive` for the stages form.
  expect(await kernel.compose(countdownPipe, iterations)).toBe(0);
});

// MARK: - build() typed-divert completeness assertion

test('buildThrowsWhenARegisteredFlowDeclaresATypedKeyNothingBoundAndNamesIt', () => {
  const missing = dispatchKey<number>('flow.missing.target');
  const entryKey = dispatchKey<number>('flow.missing.entry');
  const entryPipe = pipeline(
    { note: 'declares an unbound typed target', divertsTo: { go: missing } },
    (_kernel: Kernel, n: number, diverts): Verb<number> => diverts.go(n),
  ).seal();

  const builder = new KernelBuilder();
  builder.flow(entryKey, 'entryPipe', entryPipe);

  expect(() => builder.build()).toThrow(/flow\.missing\.target/);
  expect(() => builder.build()).toThrow(/flow\.missing\.entry/); // names the declaring flow too
});

test('buildSucceedsOnceTheDeclaredTypedKeyIsAlsoBoundViaFlow', () => {
  const target = dispatchKey<number>('flow.bound.target');
  const entryKey = dispatchKey<number>('flow.bound.entry');
  const targetPipe = pipeline(double).seal();
  const entryPipe = pipeline(
    { note: 'declares a now-bound typed target', divertsTo: { go: target } },
    (_kernel: Kernel, n: number, diverts): Verb<number> => diverts.go(n),
  ).seal();

  const builder = new KernelBuilder();
  builder.register(double, (n) => n * 2);
  builder.flow(entryKey, 'entryPipe', entryPipe);
  builder.flow(target, 'targetPipe', targetPipe);

  expect(() => builder.build()).not.toThrow();
});

// MARK: - fork-branch aggregation

test('buildAssertionSeesATypedKeyDeclaredInsideAForkBranchAndThrowsWhenUnbound', () => {
  const missing = dispatchKey<number>('flow.fromBranch.missing');
  const branchWithTypedDivert = pipeline(
    { note: 'branch declares a typed target', divertsTo: { toMissing: missing } },
    (_kernel: Kernel, n: number, diverts): Verb<number> => diverts.toMissing(n),
  ).seal();
  const otherBranch = pipeline(double).seal();
  const forkKey = dispatchKey<number>('flow.fork.entry');
  const forkPipe = pipeline(double).fork(branchWithTypedDivert, otherBranch).map(([a, b]) => a + b).seal();

  const builder = new KernelBuilder();
  builder.register(double, (n) => n * 2);
  builder.flow(forkKey, 'forkPipe', forkPipe);

  // The fork stage aggregates the branch's typed key into its own
  // `typedDivertKeys`, so `Pipe.declaredTypedDivertKeys`'s flat walk over the
  // fork pipe still finds it — a branch declaration must not be invisible to
  // the build()-time check just because it is one fork level down.
  expect(() => builder.build()).toThrow(/flow\.fromBranch\.missing/);
  expect(() => builder.build()).toThrow(/flow\.fork\.entry/);
});

// MARK: - flow() collision

test('flowThrowsOnADuplicateKeyMatchingBindsDuplicateRegisterDiscipline', () => {
  const key = dispatchKey<number>('flow.dup');
  const pipeA = pipeline(double).seal();
  const pipeB = pipeline(double).seal();

  const builder = new KernelBuilder();
  builder.register(double, (n) => n * 2);
  builder.flow(key, 'first', pipeA);

  expect(() => builder.flow(key, 'second', pipeB)).toThrow(/already bound/);
  expect(() => builder.flow(key, 'second', pipeB)).toThrow(/flow\.dup/);
});

// MARK: - Runtime unknown-key throw (the safety net build() cannot reach)

test('composingAnUnregisteredPipesTypedDivertToAnUnboundKeyThrowsAtRuntime', async () => {
  const orphan = dispatchKey<number>('flow.orphan');
  // `orphanPipe` is deliberately never handed to `builder.flow(...)` — its
  // typed declaration is therefore invisible to `build()`'s assertion (see
  // `KernelBuilder.flow`'s own "honest ceiling" doc comment); the runtime
  // throw is the safety net for exactly this case.
  const orphanEntryPipe = pipeline(
    { note: 'diverts to an unbound key', divertsTo: { go: orphan } },
    (_kernel: Kernel, n: number, diverts): Verb<number> => diverts.go(n),
  ).seal();

  const builder = new KernelBuilder();
  const kernel = builder.build(); // build() itself does not throw: nothing registered orphanEntryPipe

  await expect(kernel.compose(orphanEntryPipe, 1)).rejects.toThrow(/flow\.orphan/);
  await expect(kernel.compose(orphanEntryPipe, 1)).rejects.toThrow(/KernelBuilder\.flow/);
  // The unknown-key throw speaks the kernel's own failure vocabulary: an
  // unbound divert key is the flow-table twin of an unbound symbol id at
  // invoke — same class ('miswired machinery'), same code.
  await expect(kernel.compose(orphanEntryPipe, 1)).rejects.toBeInstanceOf(KernelError);
  await expect(kernel.compose(orphanEntryPipe, 1)).rejects.toMatchObject({
    code: 'unbound',
    symbolId: 'flow.orphan',
  });
});

test('keyedDiversionOnAnUnboundKeyThrowsAtRuntimeTooNotOnlyTheChannel', async () => {
  const orphan: DispatchKey<number> = dispatchKey<number>('flow.orphan.keyed');
  const jump = symbol<number, number>('dispatchKey.jump');

  const builder = new KernelBuilder();
  builder.registerVerb(jump, (n) => divert(keyedDiversion(orphan, n)));
  const kernel = builder.build();

  await expect(kernel.call(jump, 1)).rejects.toThrow(/flow\.orphan\.keyed/);
  await expect(kernel.call(jump, 1)).rejects.toBeInstanceOf(KernelError);
  await expect(kernel.call(jump, 1)).rejects.toMatchObject({
    code: 'unbound',
    symbolId: 'flow.orphan.keyed', // carries the DispatchKey.key in the symbolId slot — see KernelError's field doc
  });
});

// MARK: - boundFlowKeys (the divert-side twin of boundSymbolIds)

test('boundFlowKeysReflectsFlowCallsAndHandsBackASnapshotCopy', () => {
  const aKey = dispatchKey<number>('flow.keys.a');
  const bKey = dispatchKey<number>('flow.keys.b');
  const builder = new KernelBuilder();
  builder.register(double, (n) => n * 2);

  expect(builder.boundFlowKeys.size).toBe(0); // empty before any flow()

  builder.flow(aKey, 'aPipe', pipeline(double).seal());
  builder.flow(bKey, 'bPipe', pipeline(double).seal());
  expect(builder.boundFlowKeys).toEqual(new Set(['flow.keys.a', 'flow.keys.b']));

  // Same snapshot semantics as `boundSymbolIds` (both getters mint a fresh
  // `Set` per read): mutating the returned set must not leak back into the
  // builder's own flow table.
  const snapshot = builder.boundFlowKeys as Set<string>;
  snapshot.add('flow.keys.smuggled');
  expect(builder.boundFlowKeys.has('flow.keys.smuggled')).toBe(false);
  expect(builder.boundFlowKeys).toEqual(new Set(['flow.keys.a', 'flow.keys.b']));
});

// MARK: - flowCatalog integration (projectWiringGraph)

test('flowCatalogFeedsProjectWiringGraphWithResolvedDivertedFromAndDivertTargetKind', () => {
  const bKey = dispatchKey<number>('flow.catalog.b');
  const aKey = dispatchKey<number>('flow.catalog.a');
  const bPipe = pipeline(double).seal();
  const aPipe = pipeline(
    { note: 'maybe divert to b', divertsTo: { toB: bKey } },
    (_kernel: Kernel, n: number, diverts): Verb<number> => (n < 0 ? diverts.toB(-n) : next(n)),
  ).seal();

  const builder = new KernelBuilder();
  builder.register(double, (n) => n * 2);
  builder.flow(aKey, 'aPipe', aPipe);
  builder.flow(bKey, 'bPipe', bPipe);
  builder.build();

  const doc = projectWiringGraph(builder.flowCatalog, builder.boundSymbolIds, builder.guardCatalog);
  const aEntry = doc.endpoints.find((e) => e.key === 'flow.catalog.a')!;
  const bEntry = doc.endpoints.find((e) => e.key === 'flow.catalog.b')!;

  // Neither key is a *symbol* id (only 'dispatchKey.double' is bound as a
  // symbol) — both flow-bound keys read as divertTarget, not endpoint.
  expect(aEntry.kind).toBe('divertTarget');
  expect(bEntry.kind).toBe('divertTarget');
  expect(bEntry.divertedFrom).toEqual(['flow.catalog.a']);
  expect(doc.unresolvedDivertTargets).toEqual([]); // the typed declaration resolved cleanly
});

// MARK: - Legacy tier untouched

test('legacyFreeStringDivertsToStillBuildsTheSameDescriptorWithNoThirdArgBehaviorChange', async () => {
  const kernel = new KernelBuilder().build();
  const pipe = pipeline(
    { note: 'legacy unchecked tier', divertsTo: ['free.string.target'] },
    (_kernel: Kernel, n: number) => next(n),
  ).seal();

  expect(pipe.descriptors[0]!.divertsTo).toEqual(['free.string.target']);
  expect(pipe.descriptors[0]!.kind).toBe('pipe(closure)');
  // No `typedDivertKeys` accrue from a free-string declaration, so build()'s
  // typed-divert assertion has nothing to say about this pipe even though it
  // was never flow()-registered.
  expect(await kernel.compose(pipe, 7)).toBe(7);
});

// MARK: - Type-level exactness (compile-time only; never invoked)

/**
 * Compile-time exactness — never invoked; it exists so tsc checks the
 * bodies. Each `@ts-expect-error` pins one rejection: a green
 * `tsc --noEmit` proves the miswiring *fails to compile*. Mirrors
 * `tests/callable.test.ts`'s `_typeOnlyExactness` idiom.
 */
export function _typeOnlyExactness(builder: KernelBuilder): void {
  const key = dispatchKey<number>('flow.typeOnly.target');
  const numberPipe = pipeline(double).seal(); // Pipe<number, number>
  builder.flow(key, 'ok', numberPipe); // compiles: Input matches the key's P

  const stringSymbol = symbol<string, string>('flow.typeOnly.stringSym');
  const stringPipe = pipeline(stringSymbol).seal(); // Pipe<string, string>
  // @ts-expect-error wrong pipe Input — flow's P (number) must match the pipe's Input (string)
  builder.flow(key, 'bad', stringPipe);

  pipeline(
    { note: 'type-only', divertsTo: { go: key } },
    (_kernel: Kernel, n: number, diverts) => {
      // @ts-expect-error wrong payload type on the channel — `go` is pinned to number by `key`
      diverts.go('not-a-number');
      return next(n);
    },
  );
}
