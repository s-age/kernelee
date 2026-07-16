import { expect, test } from 'vitest';
import {
  describePipe,
  fail,
  next,
  pipeline,
  projectWiringGraph,
  symbol,
  KernelBuilder,
  type Kernel,
  type Verb,
} from '../src/index.js';

// Detached / untracked fork branch — `fork([tracked], [untracked])` + `.spawn`.
// Untracked branches run detached: fired-not-joined, results discarded,
// failures → the kernel error sink (never fail-fast the fork), and they
// outlive the fork. See detached-fork-proposal.md §1/§2.

const identity = symbol<number, number>('detached.identity');
const double = symbol<number, number>('detached.double');

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

function makeKernel(onError?: (source: string, error: unknown) => void): Kernel {
  const builder = new KernelBuilder();
  builder.register(identity, (n) => n);
  builder.register(double, (n) => n * 2);
  return builder.build(onError ? { onError } : {});
}

// MARK: - fork([], [x]) launches detached, resolves immediately

test('forkEmptyTrackedFiresUntrackedDetachedAndResolvesWithoutAwaitingIt', async () => {
  const hits: string[] = [];
  const kernel = makeKernel();
  const slow = pipeline({ note: 'slow detached' }, async (_kernel: Kernel, n: number) => {
    await sleep(30);
    hits.push('detached:done');
    return next(n);
  }).seal();

  const pipe = pipeline({ note: 'entry' }, (_kernel: Kernel, n: number) => next(n))
    .fork([], [slow])
    .seal();

  // Zero tracked branches → the fork's cursor is `[]`, resolved at once…
  const result = await kernel.compose(pipe, 3);
  expect(result).toEqual([]);
  expect(hits).toEqual([]); // …BEFORE the detached branch's 30ms sleep completes.

  // …and the detached branch outlives the fork, finishing later.
  await until(() => hits.includes('detached:done'));
  expect(hits).toEqual(['detached:done']);
});

// MARK: - untracked failure → errorSink, never fails the fork nor blocks tracked

test('untrackedBranchFailureRoutesToTheErrorSinkAndNeitherRejectsTheForkNorBlocksTrackedBranches', async () => {
  const sunk: Array<{ source: string; error: unknown }> = [];
  const kernel = makeKernel((source, error) => sunk.push({ source, error }));

  const boom = pipeline({ note: 'boom' }, (_kernel: Kernel, _n: number): Verb<number> => fail(new Boom())).seal();
  const trackedRan: string[] = [];
  const tracked = pipeline({ note: 'tracked' }, (_kernel: Kernel, n: number) => {
    trackedRan.push('tracked');
    return next(n * 2);
  }).seal();

  const pipe = pipeline({ note: 'entry' }, (_kernel: Kernel, n: number) => next(n))
    .fork([tracked], [boom])
    .seal();

  // The fork RESOLVES (does not reject) — the untracked failure is contained…
  const result = await kernel.compose(pipe, 5);
  expect(result).toEqual([10]); // …and only the tracked branch's result lands in the cursor.
  expect(trackedRan).toEqual(['tracked']); // tracked branch ran, unaffected.

  // The detached failure reached the error sink, labelled 'fork.untracked' (no meta note).
  await until(() => sunk.length > 0);
  expect(sunk).toHaveLength(1);
  expect(sunk[0]!.source).toBe('fork.untracked');
  expect(sunk[0]!.error).toBeInstanceOf(Boom);
});

test('untrackedFailureLabelIsTheForkNoteWhenPresent', async () => {
  const sunk: Array<{ source: string; error: unknown }> = [];
  const kernel = makeKernel((source, error) => sunk.push({ source, error }));

  const boom = pipeline({ note: 'boom' }, (_kernel: Kernel, _n: number): Verb<number> => fail(new Boom())).seal();
  const pipe = pipeline({ note: 'entry' }, (_kernel: Kernel, n: number) => next(n))
    .fork({ note: 'telemetry emit' }, [], [boom])
    .seal();

  await kernel.compose(pipe, 1);
  await until(() => sunk.length > 0);
  expect(sunk[0]!.source).toBe('telemetry emit'); // the fork stage's own note becomes the sink source
});

// MARK: - tracked + untracked mix returns only the tracked tuple/array

test('trackedPlusUntrackedReturnsOnlyTheTrackedResultsInOrder', async () => {
  const hits: string[] = [];
  const kernel = makeKernel();
  const a = pipeline({ note: 'a' }, (_kernel: Kernel, n: number) => next(n + 1)).seal();
  const b = pipeline({ note: 'b' }, (_kernel: Kernel, n: number) => next(n + 2)).seal();
  const c = pipeline({ note: 'c detached' }, (_kernel: Kernel, n: number) => {
    hits.push(`detached:${n}`);
    return next(n);
  }).seal();

  const pipe = pipeline({ note: 'entry' }, (_kernel: Kernel, n: number) => next(n))
    .fork([a, b], [c])
    .seal();

  const result = await kernel.compose(pipe, 10);
  expect(result).toEqual([11, 12]); // only the two tracked branches, in order — c's result discarded
  await until(() => hits.length > 0);
  expect(hits).toEqual(['detached:10']); // c still ran (detached), it just contributes no value
});

// MARK: - .spawn forwards the cursor unchanged

test('spawnLaunchesDetachedAndForwardsTheCursorUnchanged', async () => {
  const hits: string[] = [];
  const kernel = makeKernel();
  const logBranch = pipeline({ note: 'log' }, (_kernel: Kernel, n: number) => {
    hits.push(`logged:${n}`);
    return next(n);
  }).seal();

  const pipe = pipeline({ note: 'entry' }, (_kernel: Kernel, n: number) => next(n))
    .spawn(logBranch)
    .map((n) => n + 1) // proves the cursor is still `number`, not `[]`
    .seal();

  const result = await kernel.compose(pipe, 5);
  expect(result).toBe(6); // 5 forwarded through .spawn, then +1
  await until(() => hits.length > 0);
  expect(hits).toEqual(['logged:5']); // the spawned branch saw the same cursor
});

test('spawnAcceptsAnUnsealedBuilderAndAMetaNote', async () => {
  const sunk: Array<{ source: string; error: unknown }> = [];
  const kernel = makeKernel((source, error) => sunk.push({ source, error }));
  const boom = pipeline({ note: 'boom' }, (_kernel: Kernel, _n: number): Verb<number> => fail(new Boom()));

  // Unsealed builder as the branch (sugar, like fork); meta note → sink source.
  const pipe = pipeline({ note: 'entry' }, (_kernel: Kernel, n: number) => next(n))
    .spawn({ note: 'best-effort audit' }, boom)
    .seal();

  const result = await kernel.compose(pipe, 7);
  expect(result).toBe(7); // cursor forwarded despite the branch failing
  await until(() => sunk.length > 0);
  expect(sunk[0]!.source).toBe('best-effort audit');
});

// MARK: - descriptor: untrackedBranches carried, branches unchanged

test('forkDescriptorCarriesUntrackedBranchesSeparatelyFromTrackedBranches', () => {
  const tracked = pipeline(double).seal(); // 1 stage
  const untracked = pipeline(identity).pipe(double).seal(); // 2 stages
  const pipe = pipeline(identity).fork([tracked], [untracked]).seal();

  const fork = pipe.descriptors.at(-1)!;
  expect(fork.kind).toBe('fork(branches)');
  // tracked stays in `branches`, exactly as before
  expect(fork.branches).toHaveLength(1);
  expect(fork.branches![0]!.map((d) => d.symbolId)).toEqual(['detached.double']);
  // untracked lands in the parallel `untrackedBranches` field
  expect(fork.untrackedBranches).toHaveLength(1);
  expect(fork.untrackedBranches![0]!.map((d) => d.symbolId)).toEqual(['detached.identity', 'detached.double']);
});

test('aPlainForkHasNoUntrackedBranchesField_andSpawnHasEmptyTrackedBranches', () => {
  const plain = pipeline(identity).fork(pipeline(double).seal(), pipeline(identity).seal()).seal();
  const plainFork = plain.descriptors.at(-1)!;
  expect(plainFork.untrackedBranches).toBeUndefined(); // absent, not empty — mirrors `branches` on non-forks
  expect(plainFork.branches).toHaveLength(2);

  const spawned = pipeline(identity).spawn(pipeline(double).seal()).seal();
  const spawnFork = spawned.descriptors.at(-1)!;
  expect(spawnFork.kind).toBe('fork(branches)');
  expect(spawnFork.branches).toEqual([]); // zero tracked branches
  expect(spawnFork.untrackedBranches).toHaveLength(1);
  expect(spawnFork.untrackedBranches![0]!.map((d) => d.symbolId)).toEqual(['detached.double']);
});

// MARK: - flattenStages / projectWiringGraph fold untracked-branch edges (no silent drop)

test('projectWiringGraphFoldsSymbolAndDivertsToDeclaredInsideAnUntrackedBranch', () => {
  const entryCmd = symbol<number, number>('wiring.entryCmd');
  const detachedSym = symbol<number, number>('wiring.detachedSym');

  // The untracked branch invokes a symbol AND declares a divertsTo — both are
  // real graph edges that must survive the fold, exactly like a tracked branch.
  const untracked = pipeline(detachedSym)
    .pipe({ note: 'maybe divert', divertsTo: ['wiring.detachedTarget'] }, (_kernel, n) => next(n))
    .seal();
  const forkPipe = pipeline(entryCmd).fork([], [untracked]).seal();
  const targetPipe = pipeline(double).seal();

  const builder = new KernelBuilder();
  builder.register(entryCmd, (n) => n);
  builder.register(detachedSym, (n) => n);
  builder.register(double, (n) => n * 2);

  const doc = projectWiringGraph(
    [describePipe('wiring.entryCmd', 'forkPipe', forkPipe), describePipe('wiring.detachedTarget', 'targetPipe', targetPipe)],
    builder.boundSymbolIds,
    builder.guardCatalog,
  );

  // The detached branch's symbol was folded — attributed to the fork endpoint.
  const symEntry = doc.symbols.find((s) => s.symbolId === 'wiring.detachedSym');
  expect(symEntry).toBeDefined();
  expect(symEntry!.usedByEndpoints).toEqual(['wiring.entryCmd']);

  // The detached branch's divertsTo was folded — the target's divertedFrom names the fork endpoint.
  const targetNode = doc.endpoints.find((e) => e.key === 'wiring.detachedTarget')!;
  expect(targetNode.divertedFrom).toEqual(['wiring.entryCmd']);
});

// MARK: - schemaVersion bumped 4 → 5 → 6

test('projectWiringGraphStampsSchemaVersion6', () => {
  const builder = new KernelBuilder();
  builder.register(double, (n) => n * 2);
  const doc = projectWiringGraph(
    [describePipe('detached.double', 'p', pipeline(double).seal())],
    builder.boundSymbolIds,
    builder.guardCatalog,
  );
  expect(doc.schemaVersion).toBe(6);
});
