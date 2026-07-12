import { expect, test } from 'vitest';
import {
  fail,
  fixedArity,
  next,
  pipeline,
  runtimeArity,
  symbol,
  KernelBuilder,
  type Kernel,
} from '../src/index.js';

// MARK: - Fixtures (Swift ForkTests.swift)

const identity = symbol<number, number>('fork.identity');
const double = symbol<number, number>('fork.double');
const square = symbol<number, number>('fork.square');
const stringify = symbol<number, string>('fork.stringify');
/** A verb-returning leaf: `fail`s on a negative input, to drive fork's fail-fast path. */
const guarded = symbol<number, number>('fork.guarded');
/**
 * Sleeps, then records that it ran to completion. Swift's `slow` also probes
 * *cancellation* (`slow:cancelled`); JS has no task cancellation, so the TS
 * fixture can only ever complete — which is exactly the semantic divergence
 * the settles-on-first-rejection tests pin down.
 */
const slow = symbol<number, number>('fork.slow');

class Boom extends Error {}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `condition` holds, bounded so a stuck branch fails instead of hanging. */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 1000; i += 1) {
    if (condition()) return;
    await sleep(1);
  }
  throw new Error('condition never held');
}

/** Build a kernel wired with the leaf fixtures — the Swift `makeKernel(probe:)` idiom. */
function makeKernel(hits: string[]): Kernel {
  const builder = new KernelBuilder();
  builder.register(identity, (n) => n);
  builder.register(double, (n) => n * 2);
  builder.register(square, (n) => n * n);
  builder.register(stringify, (n) => `${n}`);
  builder.registerVerb(guarded, (n) => (n < 0 ? fail(new Boom()) : next(n)));
  builder.register(slow, async (n) => {
    await sleep(30);
    hits.push('slow:completed');
    return n;
  });
  return builder.build();
}

// MARK: - Tuple overloads (2/3/4) — success, order preserved

/**
 * Beyond the Swift assertions (values + order), this proves *actual*
 * concurrency: each branch records its start before sleeping, so if fork ran
 * branches sequentially the second start would come after the first end.
 */
test('forkTwoRunsBranchesConcurrentlyAndPreservesOrder', async () => {
  const events: string[] = [];
  const kernel = makeKernel([]);
  const traced = (name: string, ms: number) =>
    pipeline({ note: name }, async (_kernel: Kernel, n: number) => {
      events.push(`${name}:start`);
      await sleep(ms);
      events.push(`${name}:end`);
      return next(n);
    });

  const pipe = pipeline(identity)
    .fork(traced('a', 20).pipe(double).seal(), traced('b', 20).pipe(stringify).seal())
    .seal();
  const [a, b] = await kernel.compose(pipe, 3);
  expect(a).toBe(6);
  expect(b).toBe('3');
  // Both branches started before either ended — they overlapped in time.
  expect(events.slice(0, 2)).toEqual(['a:start', 'b:start']);
});

test('forkThreeAndFourBuildHeterogeneousTuples', async () => {
  const kernel = makeKernel([]);

  const pipe3 = pipeline(identity)
    .fork(pipeline(double).seal(), pipeline(square).seal(), pipeline(stringify).seal())
    .seal();
  const [a, b, c] = await kernel.compose(pipe3, 3);
  expect(a).toBe(6);
  expect(b).toBe(9);
  expect(c).toBe('3');

  const pipe4 = pipeline(identity)
    .fork(pipeline(double).seal(), pipeline(square).seal(), pipeline(stringify).seal(), pipeline(identity).seal())
    .seal();
  const [w, x, y, z] = await kernel.compose(pipe4, 4);
  expect(w).toBe(8);
  expect(x).toBe(16);
  expect(y).toBe('4');
  expect(z).toBe(4);
});

test('forkDescriptorNestsEachBranchsOwnStages', () => {
  const branchA = pipeline(double).pipe(stringify).seal(); // 2 stages: double -> stringify
  const branchB = pipeline(square).seal(); // 1 stage: square
  const pipe = pipeline(identity).fork(branchA, branchB).seal();

  const forkDescriptor = pipe.descriptors[1]!; // [0] identity leaf, [1] fork
  expect(forkDescriptor.kind).toBe('fork(branches)');
  expect(forkDescriptor.branches).toHaveLength(2);
  expect(forkDescriptor.branches![0]!.map((d) => d.kind)).toEqual(branchA.descriptors.map((d) => d.kind));
  expect(forkDescriptor.branches![0]!.map((d) => d.symbolId)).toEqual(branchA.descriptors.map((d) => d.symbolId));
  expect(forkDescriptor.branches![1]!.map((d) => d.kind)).toEqual(branchB.descriptors.map((d) => d.kind));
  expect(forkDescriptor.branches![1]!.map((d) => d.symbolId)).toEqual(branchB.descriptors.map((d) => d.symbolId));
});

test('forkOutputFlowsIntoMapWithoutADedicatedCombinator', async () => {
  const kernel = makeKernel([]);
  // The "transistor" is just `.map` reading the fork's tuple — no fork-specific join API.
  const pipe = pipeline(identity)
    .fork(pipeline(double).seal(), pipeline(square).seal())
    .map(([a, b]) => a + b)
    .seal();
  expect(await kernel.compose(pipe, 3)).toBe(15); // 6 + 9
});

// MARK: - Array overload — homogeneous, unbounded, order preserved

test('forkArrayCollectsHomogeneousBranchesInOrder', async () => {
  const kernel = makeKernel([]);
  const pipe = pipeline(identity)
    .fork([pipeline(double).seal(), pipeline(square).seal(), pipeline(identity).seal()])
    .seal();
  const results = await kernel.compose(pipe, 3);
  expect(results).toEqual([6, 9, 3]);
});

// MARK: - Fail-fast

test('forkFailFastSkipsDownstreamOnBranchFailure', async () => {
  const hits: string[] = [];
  const kernel = makeKernel(hits);
  const pipe = pipeline(identity)
    .fork(pipeline(guarded).seal(), pipeline(double).seal())
    .effect((_kernel, _value) => {
      hits.push('downstream');
    })
    .seal();
  await expect(kernel.compose(pipe, -1)).rejects.toBeInstanceOf(Boom);
  expect(hits).toEqual([]);
});

/**
 * Swift: `forkFailFastCancelsTheStillRunningSibling` — structured concurrency
 * *cancels* `slow` (the probe records `slow:cancelled`, never
 * `slow:completed`). Renamed here because the TS half of that guarantee is
 * deliberately smaller: `Promise.all` settles on the first rejection — the
 * caller observes the same fail-fast — but JS has no task cancellation, so
 * the sibling **runs to completion in the background** and its result is
 * discarded. This test pins both halves of that divergence.
 */
test('forkFailFastSettlesOnFirstRejection', async () => {
  const hits: string[] = [];
  const kernel = makeKernel(hits);
  // `guarded` fails instantly; `slow` sleeps 30ms. The fork must reject now…
  const pipe = pipeline(identity).fork(pipeline(guarded).seal(), pipeline(slow).seal()).seal();
  await expect(kernel.compose(pipe, -1)).rejects.toBeInstanceOf(Boom);
  expect(hits).toEqual([]); // …before the sibling finishes (fail-fast half)
  // …but the sibling was NOT cancelled: it completes later (no-cancel half).
  await until(() => hits.includes('slow:completed'));
  expect(hits).toEqual(['slow:completed']);
});

/**
 * Swift: `forkArrayFailFastCancelsTheStillRunningSiblings` — same rename as
 * above. Swift needs this second proof because tuples (`async let`) and
 * arrays (`withThrowingTaskGroup`) are distinct concurrency code paths; the
 * TS port compiles both shapes to one `Promise.all` stage, so this pins the
 * array *overload* rather than a different runtime path.
 */
test('forkArrayFailFastSettlesOnFirstRejection', async () => {
  const hits: string[] = [];
  const kernel = makeKernel(hits);
  const pipe = pipeline(identity).fork([pipeline(guarded).seal(), pipeline(slow).seal()]).seal();
  await expect(kernel.compose(pipe, -1)).rejects.toBeInstanceOf(Boom);
  expect(hits).toEqual([]);
  await until(() => hits.includes('slow:completed'));
  expect(hits).toEqual(['slow:completed']);
});

// MARK: - Branch arity (static descriptor)

test('arrayForkStampsFixedArityFromTheBuiltBranchCountByDefault', () => {
  const branches = [0, 1, 2].map(() => pipeline(double).seal());
  const pipe = pipeline(identity).fork(branches).seal();
  const fork = pipe.descriptors.at(-1)!;
  expect(fork.kind).toBe('fork(branches)');
  expect(fork.branchArity).toEqual(fixedArity(3));
});

test('arrayForkRecordsRuntimeArityWhenTheDefinitionSiteDeclaresIt', () => {
  // A probe construction (1 branch) whose definition site knows the array is
  // sized per invocation: the descriptor must say runtime, not fixed(1).
  const pipe = pipeline(identity)
    .fork([pipeline(double).seal()], runtimeArity)
    .seal();
  expect(pipe.descriptors.at(-1)!.branchArity).toEqual(runtimeArity);
});

test('tupleForksStampTheirStructuralArity', () => {
  const two = pipeline(identity).fork(pipeline(double).seal(), pipeline(stringify).seal()).seal();
  expect(two.descriptors.at(-1)!.branchArity).toEqual(fixedArity(2));
  const three = pipeline(identity)
    .fork(pipeline(double).seal(), pipeline(square).seal(), pipeline(stringify).seal())
    .seal();
  expect(three.descriptors.at(-1)!.branchArity).toEqual(fixedArity(3));
  const four = pipeline(identity)
    .fork(pipeline(double).seal(), pipeline(square).seal(), pipeline(stringify).seal(), pipeline(identity).seal())
    .seal();
  expect(four.descriptors.at(-1)!.branchArity).toEqual(fixedArity(4));
});

test('nonForkStagesCarryNoBranchArity', () => {
  const sink = symbol<number, void>('fork.sink');
  const pipe = pipeline(identity)
    .map((n) => n)
    .tap(sink)
    .seal();
  expect(pipe.descriptors.every((d) => d.branchArity === undefined)).toBe(true);
});

// MARK: - Optional meta note (the relief valve — Swift `fork(note:)`)

test('forkLiftsAnOptionalMetaNoteIntoTheDescriptorAcrossEveryShape', () => {
  // `fork` needs the note valve least (its branches self-describe), but the
  // one thing they never carry — *why fan out here* — still deserves a
  // channel. Every shape (2/3/4-tuple, array, array+arity) must route a
  // leading `meta` into `descriptor.note`.
  const two = pipeline(identity).fork({ note: 'why two' }, pipeline(double).seal(), pipeline(square).seal()).seal();
  const three = pipeline(identity)
    .fork({ note: 'why three' }, pipeline(double).seal(), pipeline(square).seal(), pipeline(stringify).seal())
    .seal();
  const four = pipeline(identity)
    .fork(
      { note: 'why four' },
      pipeline(double).seal(),
      pipeline(square).seal(),
      pipeline(stringify).seal(),
      pipeline(identity).seal(),
    )
    .seal();
  const array = pipeline(identity)
    .fork({ note: 'why array' }, [pipeline(double).seal(), pipeline(square).seal()])
    .seal();
  const arrayArity = pipeline(identity)
    .fork({ note: 'why runtime array' }, [pipeline(double).seal()], runtimeArity)
    .seal();

  expect(two.descriptors.at(-1)!.note).toBe('why two');
  expect(three.descriptors.at(-1)!.note).toBe('why three');
  expect(four.descriptors.at(-1)!.note).toBe('why four');
  expect(array.descriptors.at(-1)!.note).toBe('why array');
  expect(arrayArity.descriptors.at(-1)!.note).toBe('why runtime array');
});

test('forkLeavesNoteUndefinedWhenMetaOmittedAcrossEveryShape', () => {
  // Regression guard for the `hasMeta` runtime discrimination: the pre-
  // existing shapes (no leading meta) must still stamp `note: undefined`.
  const two = pipeline(identity).fork(pipeline(double).seal(), pipeline(square).seal()).seal();
  const array = pipeline(identity).fork([pipeline(double).seal()], runtimeArity).seal();

  expect(two.descriptors.at(-1)!.note).toBeUndefined();
  expect(array.descriptors.at(-1)!.note).toBeUndefined();
});

test('forkMetaOverloadReadsArityFromTheRightSlotAndPreservesBranchStructure', () => {
  // The off-by-one hotspot: with a leading meta, `arity` becomes args[1], not
  // args[0]. The meta and non-meta array+arity calls must agree on both
  // `branchArity` and `branches` — the note must not shift or corrupt the
  // branch structure it rides alongside.
  const branches = () => [pipeline(double).seal(), pipeline(square).seal(), pipeline(identity).seal()];
  const withMeta = pipeline(identity).fork({ note: 'runtime fan-out' }, branches(), runtimeArity).seal();
  const withoutMeta = pipeline(identity).fork(branches(), runtimeArity).seal();

  const metaFork = withMeta.descriptors.at(-1)!;
  const plainFork = withoutMeta.descriptors.at(-1)!;

  // arity read from args[1] under meta, args[1] (…of the shifted slice) without.
  expect(metaFork.branchArity).toEqual(runtimeArity);
  expect(metaFork.branchArity).toEqual(plainFork.branchArity);
  // Branch structure is identical — meta injection left it untouched.
  expect(metaFork.branches!.map((b) => b.map((d) => d.kind))).toEqual(
    plainFork.branches!.map((b) => b.map((d) => d.kind)),
  );
  expect(metaFork.branches!.map((b) => b.map((d) => d.symbolId))).toEqual(
    plainFork.branches!.map((b) => b.map((d) => d.symbolId)),
  );
});

test('forkMetaArrayDefaultsToFixedArityFromTheBuiltCountJustLikeTheNonMetaShape', () => {
  // Meta present, arity omitted: the descriptor must still record
  // fixedArity(branches.length) — args[1] is undefined, not misread as arity.
  const withMeta = pipeline(identity)
    .fork({ note: 'fixed fan-out' }, [pipeline(double).seal(), pipeline(square).seal()])
    .seal();
  expect(withMeta.descriptors.at(-1)!.branchArity).toEqual(fixedArity(2));
});

test('forkMetaTupleAndArrayStillRunAndPreserveOrder', async () => {
  // The meta overload shares the one #forkStage run path — a leading note must
  // not disturb execution or order preservation.
  const kernel = makeKernel([]);
  const tuple = pipeline(identity)
    .fork({ note: 'tuple' }, pipeline(double).seal(), pipeline(stringify).seal())
    .seal();
  const [a, b] = await kernel.compose(tuple, 3);
  expect(a).toBe(6);
  expect(b).toBe('3');

  const array = pipeline(identity)
    .fork({ note: 'array' }, [pipeline(double).seal(), pipeline(square).seal(), pipeline(identity).seal()])
    .seal();
  expect(await kernel.compose(array, 3)).toEqual([6, 9, 3]);
});

// MARK: - TS additions (no Swift counterpart)

/** Fork accepts unsealed builders as branches — the same sugar `compose` has. */
test('forkAcceptsUnsealedBuildersAsBranches', async () => {
  const kernel = makeKernel([]);
  const pipe = pipeline(identity)
    .fork(pipeline(double), pipeline(stringify)) // builders, not sealed pipes
    .seal();
  const [a, b] = await kernel.compose(pipe, 5);
  expect(a).toBe(10);
  expect(b).toBe('5');
});
