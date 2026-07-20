import { expect, test } from 'vitest';
import {
  declareGate,
  fail,
  next,
  pipeline,
  symbol,
  KernelBuilder,
  KernelError,
  type Kernel,
} from '../src/index.js';

// MARK: - Fixtures

const identity = symbol<number, number>('fork.identity');
const double = symbol<number, number>('fork.double');
const square = symbol<number, number>('fork.square');
const stringify = symbol<number, string>('fork.stringify');
/** A verb-returning leaf: `fail`s on a negative input, to drive fork's fail-fast path. */
const guarded = symbol<number, number>('fork.guarded');
/**
 * Sleeps, then records that it ran to completion. JS has no task
 * cancellation, so this fixture can only ever complete — which is exactly
 * the behavior the settles-on-first-rejection tests pin down.
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

/** Build a kernel wired with the leaf fixtures. */
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
 * This proves *actual* concurrency (beyond values + order): each branch
 * records its start before sleeping, so if fork ran branches sequentially
 * the second start would come after the first end.
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
 * `Promise.all` settles on the first rejection — the caller observes
 * fail-fast — but JS has no task cancellation, so
 * the sibling **runs to completion in the background** and its result is
 * discarded. This test pins both halves of that behavior.
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
 * TS compiles both tuple and array shapes to one `Promise.all` stage, so
 * this test exists to pin the array *overload* specifically, not a
 * different runtime code path.
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

// MARK: - Optional meta note (the relief valve)

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

  expect(two.descriptors.at(-1)!.note).toBe('why two');
  expect(three.descriptors.at(-1)!.note).toBe('why three');
  expect(four.descriptors.at(-1)!.note).toBe('why four');
  expect(array.descriptors.at(-1)!.note).toBe('why array');
});

test('forkLeavesNoteUndefinedWhenMetaOmittedAcrossEveryShape', () => {
  // Regression guard for the `hasMeta` runtime discrimination: the pre-
  // existing shapes (no leading meta) must still stamp `note: undefined`.
  const two = pipeline(identity).fork(pipeline(double).seal(), pipeline(square).seal()).seal();
  const array = pipeline(identity).fork([pipeline(double).seal()]).seal();

  expect(two.descriptors.at(-1)!.note).toBeUndefined();
  expect(array.descriptors.at(-1)!.note).toBeUndefined();
});

test('forkMetaArrayPreservesBranchStructureUnderTheLeadingNote', () => {
  // The off-by-one hotspot the leading-meta twin must avoid: with a leading
  // meta, the branches array becomes args[1], not args[0] — the note must
  // not shift or corrupt the branch structure it rides alongside.
  const branches = () => [pipeline(double).seal(), pipeline(square).seal(), pipeline(identity).seal()];
  const withMeta = pipeline(identity).fork({ note: 'fan-out' }, branches()).seal();
  const withoutMeta = pipeline(identity).fork(branches()).seal();

  const metaFork = withMeta.descriptors.at(-1)!;
  const plainFork = withoutMeta.descriptors.at(-1)!;

  expect(metaFork.branches!.map((b) => b.map((d) => d.kind))).toEqual(
    plainFork.branches!.map((b) => b.map((d) => d.kind)),
  );
  expect(metaFork.branches!.map((b) => b.map((d) => d.symbolId))).toEqual(
    plainFork.branches!.map((b) => b.map((d) => d.symbolId)),
  );
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

// MARK: - Builder-sugar branches

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

// MARK: - branch/meta discrimination is a positive contract (plain-object
// meta, this-instance branches)

/** A class instance that quacks like a `PipeBuilder` (a stand-in for a duplicate-kernelee-copy builder). */
class ForeignishBuilder {
  seal() {
    return pipeline(double).seal();
  }
}

/** A class instance that quacks like a sealed `Pipe` (a stand-in for a duplicate-kernelee-copy Pipe). */
class FakePipe {
  stages: unknown[] = [];
  erasedStages: unknown[] = [];
}

test('forkRejectsAForeignBuilderInLeadingPositionInsteadOfSwallowingItAsMeta', () => {
  // Old behavior: a class instance that isn't THIS module's Pipe/PipeBuilder
  // fell into the `meta` bucket unnoticed and the branch silently vanished.
  // New behavior: `isStageMeta` rejects it as meta (it's a class instance,
  // not a plain data object), so it falls through to `sealBranch`, which
  // rejects it loudly.
  expect(() => {
    pipeline(identity).fork(new ForeignishBuilder() as never, pipeline(square).seal());
  }).toThrow(/Pipe or PipeBuilder created by this kernelee instance/);
});

test('forkRejectsAForeignPipeInABranchPosition', () => {
  expect(() => {
    pipeline(identity).fork(pipeline(double).seal(), new FakePipe() as never);
  }).toThrow(/an instance of FakePipe/);
});

test('forkAcceptsAPlainObjectAsLeadingMetaButRejectsTheSameShapeAsABranch', () => {
  // Residual gap (documented, not a bug): a plain-object branch-like value in
  // the LEADING position is indistinguishable from an empty `{}` meta and is
  // still absorbed as meta.
  const asMeta = pipeline(identity).fork({ stages: [] } as never, pipeline(double).seal(), pipeline(square).seal()).seal();
  expect(asMeta.descriptors.at(-1)!.note).toBeUndefined();
  expect(asMeta.descriptors.at(-1)!.branches).toHaveLength(2);

  // The same shape in a non-leading (branch) position is not meta — it must
  // be a real Pipe/PipeBuilder, so it is rejected loudly.
  expect(() => {
    pipeline(identity).fork(pipeline(double).seal(), { stages: [] } as never);
  }).toThrow(/an instance of Object/);
});

test('forkRejectsNullAndUndefinedBranchesWithADiagnosticInsteadOfACrypticCrash', () => {
  expect(() => {
    pipeline(identity).fork(pipeline(double).seal(), null as never);
  }).toThrow(/received null/);
  expect(() => {
    pipeline(identity).fork(pipeline(double).seal(), undefined as never);
  }).toThrow(/received undefined/);
});

test('spawnEnforcesTheSameStrictBranchContract', () => {
  expect(() => {
    pipeline(identity).spawn({ note: 'x' }, new ForeignishBuilder() as never);
  }).toThrow(/Pipe or PipeBuilder created by this kernelee instance/);
});

test('metaPositiveShapeRegressionGuardAcrossPlainObjectVariants', () => {
  // Every one of these is a plain data object — none is a class instance —
  // so each must still be recognized as `meta`, not misfiled as a branch.
  const empty = pipeline(identity).fork({}, pipeline(double).seal(), pipeline(square).seal()).seal();
  expect(empty.descriptors.at(-1)!.note).toBeUndefined();

  const frozen = pipeline(identity)
    .fork(Object.freeze({ note: 'frozen' }), pipeline(double).seal(), pipeline(square).seal())
    .seal();
  expect(frozen.descriptors.at(-1)!.note).toBe('frozen');

  const nullProto = pipeline(identity)
    .fork(Object.assign(Object.create(null), { note: 'null-proto' }), pipeline(double).seal(), pipeline(square).seal())
    .seal();
  expect(nullProto.descriptors.at(-1)!.note).toBe('null-proto');
});

// MARK: - fork(symbol) — dynamic fan-out (Symbol × N)

test('forkSymbolFansOutConcurrentlyAndPreservesOrder', async () => {
  const events: string[] = [];
  const timedEcho = symbol<{ tag: string; ms: number }, string>('fork.symbol.timedEcho');
  const builder = new KernelBuilder();
  builder.register(timedEcho, async ({ tag, ms }) => {
    events.push(`${tag}:start`);
    await sleep(ms);
    events.push(`${tag}:end`);
    return tag;
  });
  const kernel = builder.build();

  const pipe = pipeline({ note: 'entry' }, (_kernel: Kernel, _payload: void) =>
    next([
      { tag: 'a', ms: 20 },
      { tag: 'b', ms: 20 },
    ]),
  )
    .fork(timedEcho)
    .seal();

  const results = await kernel.compose(pipe);
  expect(results).toEqual(['a', 'b']); // order preserved regardless of completion order
  // Both elements started before either finished — genuine concurrency, not
  // a sequential N-times invoke loop.
  expect(events.slice(0, 2)).toEqual(['a:start', 'b:start']);
});

/**
 * Same fail-fast / no-cancellation split as the existing `fork(branches)`
 * tests (`forkFailFastSettlesOnFirstRejection` etc.) — `fork(symbol)` reuses
 * the identical `Promise.all` join, just fanning one symbol over payload
 * elements instead of N distinct branch pipes over the one shared cursor.
 */
test('forkSymbolFailFastSettlesOnFirstRejectionWhileSiblingCompletesInBackground', async () => {
  const hits: string[] = [];
  const flaky = symbol<{ tag: string }, string>('fork.symbol.flaky');
  const builder = new KernelBuilder();
  builder.registerVerb(flaky, async ({ tag }) => {
    if (tag === 'boom') return fail(new Boom());
    await sleep(30);
    hits.push(`${tag}:completed`);
    return next(tag);
  });
  const kernel = builder.build();

  const pipe = pipeline({ note: 'entry' }, (_kernel: Kernel, _payload: void) =>
    next([{ tag: 'boom' }, { tag: 'slow' }]),
  )
    .fork(flaky)
    .seal();

  await expect(kernel.compose(pipe)).rejects.toBeInstanceOf(Boom);
  expect(hits).toEqual([]); // rejects before the sibling settles
  await until(() => hits.includes('slow:completed'));
  expect(hits).toEqual(['slow:completed']); // …but the sibling was not cancelled
});

test('forkSymbolRejectsAnEmptyPayloadArrayWithAKernelError', async () => {
  const builder = new KernelBuilder();
  builder.register(double, (n) => n * 2);
  const kernel = builder.build();

  const pipe = pipeline({ note: 'entry' }, (_kernel: Kernel, _payload: void) => next([] as number[]))
    .fork(double)
    .seal();

  const rejection = kernel.compose(pipe);
  await expect(rejection).rejects.toBeInstanceOf(KernelError);
  await expect(rejection).rejects.toThrow(/empty fan-out/);
  await expect(rejection).rejects.toMatchObject({ code: 'emptyFanOut', symbolId: 'fork.double' });
});

/**
 * `fork(symbol)` funnels each element through the identical `kernel.invoke`
 * chokepoint a `.pipe(sym)` stage uses, so a guard on the fanned-out target
 * applies once per element — not once for the whole fork.
 */
test('forkSymbolAppliesItsTargetsGatePerElementAtTheSameChokepointAsPipeSym', async () => {
  const target = symbol<number, number>('fork.symbol.gated');
  let gateRuns = 0;
  const vetoNegative = declareGate<number>('guard:fork.symbol.gated', (_kernel: Kernel, n: number) => {
    gateRuns += 1;
    return n < 0 ? fail(new Boom()) : next();
  });

  const builder = new KernelBuilder();
  builder.register(target, (n) => n * 2);
  builder.guard(target, vetoNegative);
  const kernel = builder.build();

  const okPipe = pipeline({ note: 'entry' }, (_kernel: Kernel, _payload: void) => next([1, 2, 3]))
    .fork(target)
    .seal();
  expect(await kernel.compose(okPipe)).toEqual([2, 4, 6]);
  expect(gateRuns).toBe(3); // one gate evaluation per fanned-out element

  gateRuns = 0;
  const vetoPipe = pipeline({ note: 'entry' }, (_kernel: Kernel, _payload: void) => next([1, -1, 3]))
    .fork(target)
    .seal();
  await expect(kernel.compose(vetoPipe)).rejects.toBeInstanceOf(Boom);
});

test('forkSymbolDescriptorCarriesOnlyKindSymbolIdNoBranchesNoUntrackedBranches', () => {
  const pipe = pipeline(identity)
    .map((n) => [n])
    .fork(double)
    .seal();
  const forkDescriptor = pipe.descriptors.at(-1)!;

  expect(forkDescriptor.kind).toBe('fork(symbol)');
  expect(forkDescriptor.symbolId).toBe('fork.double');
  expect(forkDescriptor.note).toBe(double.description); // `double` carries no description, so undefined
  expect(forkDescriptor.divertsTo).toEqual([]);
  expect(forkDescriptor.branches).toBeUndefined();
  expect(forkDescriptor.untrackedBranches).toBeUndefined();
});
