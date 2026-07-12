import { expect, test } from 'vitest';
import {
  describePipe,
  next,
  pipeline,
  projectWiringGraph,
  validateWiringGraph,
  symbol,
  KernelBuilder,
  type Kernel,
} from '../src/index.js';

// MARK: - Fixtures

const entryCmd = symbol<number, number>('wiring.entryCmd');
const double = symbol<number, number>('wiring.double');
const stringify = symbol<number, string>('wiring.stringify');

// MARK: - describePipe non-drift

test('describePipeCarriesPipeDescriptorsVerbatim', () => {
  const pipe = pipeline(entryCmd).pipe(double).seal();
  const entry = describePipe('wiring.entryCmd', 'entryThenDouble', pipe, 'demo pipe');
  expect(entry).toEqual({
    key: 'wiring.entryCmd',
    title: 'entryThenDouble',
    stages: pipe.descriptors,
    note: 'demo pipe',
  });
});

// MARK: - divertedFrom + endpoint/divertTarget kind

test('projectWiringGraphFoldsDivertsToIntoDivertedFromAndClassifiesEndpointsByBoundSymbolIds', () => {
  const entryPipe = pipeline(
    { note: 'maybe divert', divertsTo: ['wiring.target'] },
    (_kernel: Kernel, n: number) => next(n),
  ).seal();
  const targetPipe = pipeline(double).seal();

  const entryEntry = describePipe('wiring.entryCmd', 'entryPipe', entryPipe);
  const targetEntry = describePipe('wiring.target', 'targetPipe', targetPipe);

  const builder = new KernelBuilder();
  builder.register(entryCmd, (n) => n);
  builder.register(double, (n) => n * 2);
  // `boundSymbolIds` is read from the builder — no kernel/build() needed for a static projection.

  const doc = projectWiringGraph([entryEntry, targetEntry], builder.boundSymbolIds);

  const entryNode = doc.endpoints.find((e) => e.key === 'wiring.entryCmd')!;
  const targetNode = doc.endpoints.find((e) => e.key === 'wiring.target')!;

  expect(entryNode.kind).toBe('endpoint'); // 'wiring.entryCmd' is bound
  expect(targetNode.kind).toBe('divertTarget'); // 'wiring.target' names a Pipe, not a bound symbol id
  expect(targetNode.divertedFrom).toEqual(['wiring.entryCmd']);
  expect(entryNode.divertedFrom).toEqual([]);
});

// MARK: - fork branches fold into symbols/divertedFrom

test('projectWiringGraphWalksForkBranchesForSymbolUsageAndDivertsTo', () => {
  const branchA = pipeline(double).seal();
  const branchB = pipeline(
    { note: 'branch diverts too', divertsTo: ['wiring.target'] },
    (_kernel: Kernel, n: number) => next(n),
  ).seal();
  const forkPipe = pipeline(entryCmd).fork(branchA, branchB).seal();
  const targetPipe = pipeline(stringify).seal();

  const forkEntry = describePipe('wiring.fork', 'forkPipe', forkPipe);
  const targetEntry = describePipe('wiring.target', 'targetPipe', targetPipe);

  const builder = new KernelBuilder();
  builder.register(entryCmd, (n) => n);
  builder.register(double, (n) => n * 2);
  builder.register(stringify, (n) => `${n}`);
  const boundSymbolIds = builder.boundSymbolIds;

  const doc = projectWiringGraph([forkEntry, targetEntry], boundSymbolIds);

  const doubleSymbol = doc.symbols.find((s) => s.symbolId === 'wiring.double')!;
  expect(doubleSymbol.bound).toBe(true);
  expect(doubleSymbol.usedByEndpoints).toEqual(['wiring.fork']); // found inside the fork's branch, not just top-level stages

  const targetNode = doc.endpoints.find((e) => e.key === 'wiring.target')!;
  expect(targetNode.divertedFrom).toEqual(['wiring.fork']); // folded from branchB, nested inside the fork stage
});

// MARK: - unresolved divert targets

test('projectWiringGraphCollectsDivertsToStringsThatMatchNoCatalogKey', () => {
  const entryPipe = pipeline(
    { note: 'diverts to nowhere cataloged', divertsTo: ['wiring.ghost', 'wiring.ghost'] },
    (_kernel: Kernel, n: number) => next(n),
  ).seal();
  const entryEntry = describePipe('wiring.entryCmd', 'entryPipe', entryPipe);

  const builder = new KernelBuilder();
  builder.register(entryCmd, (n) => n);
  const doc = projectWiringGraph([entryEntry], builder.boundSymbolIds);

  expect(doc.unresolvedDivertTargets).toEqual(['wiring.ghost']); // deduplicated, not silently dropped
});

// MARK: - unlisted bound symbols

test('projectWiringGraphCollectsBoundSymbolIdsThatMatchNoCatalogKeyOrReferencedSymbol', () => {
  const entryPipe = pipeline(entryCmd).pipe(double).seal();
  const entryEntry = describePipe('wiring.entryCmd', 'entryPipe', entryPipe);

  const builder = new KernelBuilder();
  builder.register(entryCmd, (n) => n);
  builder.register(double, (n) => n * 2);
  // 'wiring.stringify' is bound but appears in no catalog entry's key and no
  // stage's symbolId — a plain Mutator-shaped bound symbol, never diverted to.
  builder.register(stringify, (n) => `${n}`);
  const doc = projectWiringGraph([entryEntry], builder.boundSymbolIds);

  expect(doc.unlistedBoundSymbols).toEqual(['wiring.stringify']);
});

test('projectWiringGraphUnlistedBoundSymbolsIsEmptyWhenEveryBoundIdIsAKeyOrReferencedSymbol', () => {
  const entryPipe = pipeline(entryCmd).pipe(double).seal();
  const entryEntry = describePipe('wiring.entryCmd', 'entryPipe', entryPipe);

  const builder = new KernelBuilder();
  builder.register(entryCmd, (n) => n);
  builder.register(double, (n) => n * 2);
  const doc = projectWiringGraph([entryEntry], builder.boundSymbolIds);

  expect(doc.unlistedBoundSymbols).toEqual([]);
});

test('validateWiringGraphReportsOneUnlistedBoundSymbolIssuePerEntryUnconditionally', () => {
  const entryPipe = pipeline(entryCmd).seal();
  const entryEntry = describePipe('wiring.entryCmd', 'entryPipe', entryPipe);

  const builder = new KernelBuilder();
  builder.register(entryCmd, (n) => n);
  builder.register(double, (n) => n * 2); // bound, but no Pipe/stage ever names it
  const doc = projectWiringGraph([entryEntry], builder.boundSymbolIds);

  expect(validateWiringGraph(doc)).toEqual([{ kind: 'unlistedBoundSymbol', key: 'wiring.double' }]);
});

// MARK: - JSON-serializable

test('projectWiringGraphDocumentSurvivesJSONRoundTrip', () => {
  const forkPipe = pipeline(entryCmd).fork(pipeline(double).seal(), pipeline(stringify).seal()).seal();
  const forkEntry = describePipe('wiring.fork', 'forkPipe', forkPipe, 'demo fork');

  const builder = new KernelBuilder();
  builder.register(entryCmd, (n) => n);
  builder.register(double, (n) => n * 2);
  builder.register(stringify, (n) => `${n}`);
  const doc = projectWiringGraph([forkEntry], builder.boundSymbolIds);

  const json = JSON.stringify(doc); // must not throw — every field is plain data
  expect(JSON.parse(json)).toEqual(doc);
});

// MARK: - validateWiringGraph

test('validateWiringGraphReturnsEmptyArrayForACleanDocument', () => {
  const entryPipe = pipeline(
    { note: 'diverts to a real, referenced target', divertsTo: ['wiring.target'] },
    (_kernel: Kernel, n: number) => next(n),
  ).seal();
  const targetPipe = pipeline(double).seal();

  const entryEntry = describePipe('wiring.entryCmd', 'entryPipe', entryPipe);
  const targetEntry = describePipe('wiring.target', 'targetPipe', targetPipe);

  const builder = new KernelBuilder();
  builder.register(entryCmd, (n) => n);
  builder.register(double, (n) => n * 2);
  const doc = projectWiringGraph([entryEntry, targetEntry], builder.boundSymbolIds);

  expect(validateWiringGraph(doc)).toEqual([]);
});

test('validateWiringGraphReportsUnresolvedDivertTargetsWithReferrers', () => {
  const entryASymbol = symbol<number, number>('wiring.entryA');
  const entryBSymbol = symbol<number, number>('wiring.entryB');
  const entryA = pipeline(entryASymbol)
    .pipe({ note: 'diverts to nowhere cataloged', divertsTo: ['wiring.ghost'] }, (_kernel: Kernel, n: number) =>
      next(n),
    )
    .seal();
  const entryB = pipeline(entryBSymbol)
    .pipe({ note: 'also diverts to the same ghost', divertsTo: ['wiring.ghost'] }, (_kernel: Kernel, n: number) =>
      next(n),
    )
    .seal();

  const entryAEntry = describePipe('wiring.entryA', 'entryA', entryA);
  const entryBEntry = describePipe('wiring.entryB', 'entryB', entryB);

  const builder = new KernelBuilder();
  // Both bound directly to their own catalog keys, so neither is an orphan — isolates this test
  // to the unresolvedDivertTarget check only.
  builder.register(entryASymbol, (n) => n);
  builder.register(entryBSymbol, (n) => n);
  const doc = projectWiringGraph([entryAEntry, entryBEntry], builder.boundSymbolIds);

  expect(validateWiringGraph(doc)).toEqual([
    { kind: 'unresolvedDivertTarget', key: 'wiring.ghost', referrers: ['wiring.entryA', 'wiring.entryB'] },
  ]);
});

test('validateWiringGraphReportsOrphanEntryForADivertTargetWithNoExternalReferrer', () => {
  const orphanPipe = pipeline(double).seal();
  const orphanEntry = describePipe('wiring.orphan', 'orphanPipe', orphanPipe);

  const builder = new KernelBuilder();
  builder.register(double, (n) => n * 2);
  // 'wiring.orphan' is neither bound nor named by any entry's divertsTo — nothing justifies it.
  const doc = projectWiringGraph([orphanEntry], builder.boundSymbolIds);

  expect(validateWiringGraph(doc)).toEqual([{ kind: 'orphanEntry', key: 'wiring.orphan' }]);
});

test('validateWiringGraphExcludesSelfDivertsToWhenCheckingOrphanStatus', () => {
  // A continuation loop whose only `divertsTo` is its own
  // key: `projectWiringGraph`'s own `divertedFrom` fold does not exclude self-references (a
  // graph panel still needs to render the self-loop edge), so this check must exclude it
  // independently — otherwise a self-only loop would wrongly look "referenced".
  const loopPipe = pipeline(
    { note: 'continues itself next tick', divertsTo: ['wiring.loop'] },
    (_kernel: Kernel, n: number) => next(n),
  ).seal();
  const loopEntry = describePipe('wiring.loop', 'loopPipe', loopPipe);

  const builder = new KernelBuilder();
  const doc = projectWiringGraph([loopEntry], builder.boundSymbolIds);

  expect(doc.endpoints[0]!.divertedFrom).toEqual(['wiring.loop']); // projectWiringGraph itself keeps the self-edge
  expect(validateWiringGraph(doc)).toEqual([{ kind: 'orphanEntry', key: 'wiring.loop' }]); // but validation excludes it
});

test('validateWiringGraphNeverFlagsBoundEndpointsAsOrphansRegardlessOfDivertedFrom', () => {
  const entryPipe = pipeline(entryCmd).seal();
  const entryEntry = describePipe('wiring.entryCmd', 'entryPipe', entryPipe);

  const builder = new KernelBuilder();
  builder.register(entryCmd, (n) => n);
  // Bound, and named by no one's divertsTo — still not an orphan, since dispatch itself justifies it.
  const doc = projectWiringGraph([entryEntry], builder.boundSymbolIds);

  expect(validateWiringGraph(doc)).toEqual([]);
});
