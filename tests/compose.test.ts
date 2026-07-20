import { expect, test } from 'vitest';
import {
  abort,
  divert,
  diversion,
  fail,
  next,
  pipeline,
  symbol,
  KernelBuilder,
  type Kernel,
  type Verb,
} from '../src/index.js';

// MARK: - Fixtures (fork excluded)

const increment = symbol<number, number>('test.increment');
const stringify = symbol<number, string>('test.stringify');
const length = symbol<string, number>('test.length');
const erase = symbol<number, void>('test.erase');
/** A verb-returning leaf: the *Driver* decides the verb (`fail` on negative). */
const guarded = symbol<number, number>('test.guarded');
/** A side-effecting leaf for `.tap`: `void` output, `fail` on negative. */
const guardedSink = symbol<number, void>('test.guardedSink');

class Boom extends Error {}

/** Build a kernel wired with the leaf fixtures. */
function makeKernel(): Kernel {
  const builder = new KernelBuilder();
  builder.register(increment, (n) => n + 1);
  builder.register(stringify, (n) => `${n}`);
  builder.register(length, (s) => s.length);
  builder.register(erase, () => {});
  builder.registerVerb(guarded, (n) => (n < 0 ? fail(new Boom()) : next(n * 2)));
  builder.registerVerb(guardedSink, (n) => (n < 0 ? fail(new Boom()) : next(undefined)));
  return builder.build();
}

// MARK: - next chain (the load-bearing static guarantee)

test('nextChainsReturnIntoNextPayload', async () => {
  const kernel = makeKernel();
  // 9 -> +1 -> 10 -> "10" -> length -> 2
  const pipe = pipeline(increment).pipe(stringify).pipe(length).seal();
  const result: number = await kernel.compose(pipe, 9);
  expect(result).toBe(2);
});

test('builderCanBeComposedWithoutExplicitSeal', async () => {
  const kernel = makeKernel();
  const result = await kernel.compose(pipeline(increment).pipe(increment), 40);
  expect(result).toBe(42);
});

/**
 * TS has no boundary cast at all, so the guarantee here is "a void-output
 * pipe resolves, and resolves to undefined".
 */
test('voidOutputRoundTrips', async () => {
  const kernel = makeKernel();
  const pipe = pipeline(increment).pipe(erase).seal(); // Pipe<number, void>
  await expect(kernel.compose(pipe, 0)).resolves.toBeUndefined();
});

// MARK: - Verb-returning handlers (the Driver owns the verb)
// (verbReturningHandlerIsInterpretedByCall is already ported in
// tests/call.test.ts — same name, same assertions.)

test('verbReturningHandlerDrivesThePipe', async () => {
  const kernel = makeKernel();
  const hits: string[] = [];
  // No wrapper closure: `guarded`'s own fail/next controls the pipe.
  const pipe = pipeline(guarded)
    .pipe({ note: 'probe' }, (_kernel, n) => {
      hits.push('downstream');
      return next(n);
    })
    .seal();

  expect(await kernel.compose(pipe, 5)).toBe(10); // next(10) -> downstream
  expect(hits).toEqual(['downstream']);

  await expect(kernel.compose(pipe, -1)).rejects.toBeInstanceOf(Boom); // handler fail -> pipe throws
  expect(hits).toEqual(['downstream']); // failing handler skipped downstream
});

// MARK: - tap / map / effect (declarative chain links)

test('tapRunsTheSymbolButForwardsTheOriginalValue', async () => {
  const kernel = makeKernel();
  // increment -> 6, tap(guardedSink) runs for effect, original 6 keeps flowing
  const pipe = pipeline(increment)
    .tap(guardedSink)
    .map((n) => n + 100)
    .seal();
  expect(await kernel.compose(pipe, 5)).toBe(106);
});

test('tapHonorsAFailFromTheTappedDriver', async () => {
  const kernel = makeKernel();
  const hits: string[] = [];
  const pipe = pipeline(increment)
    .tap(guardedSink) // -9 < 0 -> fail
    .effect((_kernel, _n) => {
      hits.push('downstream');
    })
    .seal();
  await expect(kernel.compose(pipe, -10)).rejects.toBeInstanceOf(Boom);
  expect(hits).toEqual([]);
});

test('mapTransformsAndEffectPassesThrough', async () => {
  const kernel = makeKernel();
  const hits: string[] = [];
  const pipe = pipeline(increment) // 0 -> 1
    .effect((_kernel, n) => {
      hits.push(`eff:${n}`);
    })
    .map((n) => n + 1) // 1 -> 2
    .seal();
  expect(await kernel.compose(pipe, 0)).toBe(2);
  expect(hits).toEqual(['eff:1']);
});

// MARK: - run (forward-only, no return path)

test('runDrivesForwardAndStopsOnAbortWithoutAnOutputType', async () => {
  const kernel = makeKernel();
  const hits: string[] = [];
  const pipe = pipeline(increment)
    .effect((_kernel, n) => {
      hits.push(`eff:${n}`);
    })
    .pipe({ note: 'abort past 100' }, (_kernel, n) => (n > 100 ? abort(n) : next(n)))
    .effect((_kernel, n) => {
      hits.push(`after:${n}`);
    })
    .seal();

  await kernel.run(pipe, 5); // 6, eff:6, next, after:6
  expect(hits).toEqual(['eff:6', 'after:6']);

  await kernel.run(pipe, 200); // 201, eff:201, abort -> stop
  expect(hits).toEqual(['eff:6', 'after:6', 'eff:201']);
});

/**
 * TS never checks the boundary (the cast is deliberately unchecked) — an
 * Int abort would silently mismatch a String output. The guarantee that
 * survives is forward-only-ness itself:
 * `run` discards the final value — the abort's 999
 * never comes back.
 */
test('runNeedsNoBoundaryCastSoAbortIsTypeFree', async () => {
  const kernel = makeKernel();
  const pipe = pipeline(increment)
    .pipe({ note: 'abort with a number despite the string output' }, (_kernel: Kernel, _n: number): Verb<string> => abort(999))
    .seal(); // Pipe<number, string>
  await expect(kernel.run(pipe, 0)).resolves.toBeUndefined();
});

// MARK: - abort

test('abortStopsAndReturnsItsValue', async () => {
  const kernel = makeKernel();
  const hits: string[] = [];
  const pipe = pipeline(increment)
    .pipe({ note: 'abort past 100' }, (_kernel, n) => (n > 100 ? abort(n) : next(n)))
    .pipe({ note: 'probe' }, (_kernel, n) => {
      hits.push('downstream');
      return next(n);
    })
    .seal(); // Pipe<number, number>

  const aborted = await kernel.compose(pipe, 200); // 201 > 100 -> abort(201)
  expect(aborted).toBe(201);
  expect(hits).toEqual([]); // downstream never ran

  const passed = await kernel.compose(pipe, 5); // 6 -> next -> downstream -> 6
  expect(passed).toBe(6);
  expect(hits).toEqual(['downstream']);
});

// MARK: - divert

test('divertDiscardsRestAndRunsTheOtherPipe', async () => {
  const kernel = makeKernel();
  const hits: string[] = [];
  const alt = pipeline(increment).pipe(increment).seal(); // +2

  const main = pipeline(increment)
    .pipe({ note: 'always divert' }, (_kernel, _n): Verb<number> => divert(diversion(alt, 1000)))
    .pipe({ note: 'probe' }, (_kernel, n) => {
      hits.push('after-divert');
      return next(n);
    })
    .seal();

  const result = await kernel.compose(main, 0); // diverted: 1000 -> +2 -> 1002
  expect(result).toBe(1002);
  expect(hits).toEqual([]); // post-divert stage discarded
});

test('runAlsoDivertsWithoutReturningAValue', async () => {
  const kernel = makeKernel();
  const hits: string[] = [];
  const alt = pipeline({ note: 'alt' }, (_kernel: Kernel, n: number): Verb<number> => {
    hits.push(`alt:${n}`);
    return next(n);
  }).seal();

  const main = pipeline(increment)
    .pipe({ note: 'always divert' }, (_kernel, _n): Verb<number> => divert(diversion(alt, 999)))
    .pipe({ note: 'probe' }, (_kernel, n) => {
      hits.push('after-divert');
      return next(n);
    })
    .seal();

  await kernel.run(main, 0);
  expect(hits).toEqual(['alt:999']); // post-divert stage discarded here too
});

/**
 * `loopStep` diverts back to a freshly-built one-stage pipe of itself
 * (PipelineA -> SwitchA -> PipelineA -> SwitchA -> ... -> abort) — a loop
 * built entirely from `divert`, no dedicated loop construct. `compose` must
 * run this as *iteration* (swap the stage list, keep going), not as a nested
 * `compose` call per hop — otherwise a long-running agent/stream loop would
 * grow one (async) stack frame per hop and eventually choke. A high iteration
 * count here is the regression guard: if `divert` ever goes back to
 * recursing, this either blows the stack / heap or gets dramatically slower.
 */
test('divertLoopIsIterativeNotRecursive', async () => {
  const iterations = 100_000;
  const loopStep = symbol<number, number>('test.loopStep');
  const builder = new KernelBuilder();
  builder.registerVerb(loopStep, (n) =>
    n >= iterations ? abort(n) : divert(diversion(pipeline(loopStep).seal(), n + 1)),
  );
  const kernel = builder.build();

  const result = await kernel.compose(pipeline(loopStep).seal(), 0);
  expect(result).toBe(iterations);
});

// MARK: - fail

test('failThrowsOutOfCompose', async () => {
  const kernel = makeKernel();
  const hits: string[] = [];
  const pipe = pipeline(increment)
    .pipe({ note: 'always fail' }, (_kernel, _n): Verb<number> => fail(new Boom()))
    .pipe({ note: 'probe' }, (_kernel, n) => {
      hits.push('downstream');
      return next(n);
    })
    .seal();

  await expect(kernel.compose(pipe, 0)).rejects.toBeInstanceOf(Boom);
  expect(hits).toEqual([]);
});

// The TS boundary cast is unchecked — there is no composeTypeMismatch check.

// MARK: - void-input sugar (symmetry with `call(sym)`)

test('voidInputPipeComposesAndRunsWithoutAPayload', async () => {
  const seed = symbol<void, number>('test.seed');
  const builder = new KernelBuilder();
  builder.register(seed, () => 41);
  builder.register(increment, (n) => n + 1);
  const kernel = builder.build();

  const pipe = pipeline(seed).pipe(increment).seal(); // Pipe<void, number>
  expect(await kernel.compose(pipe)).toBe(42);
  await expect(kernel.run(pipe)).resolves.toBeUndefined();
});

// MARK: - Static shape (descriptors)

test('builtPipeExposesItsStaticShapeWithoutRunning', () => {
  // No kernel, no execution — building the pipe records each stage's
  // descriptor, so a wiring graph can read the topology back without running
  // anything. (TS generics are erased, so `flows`/`inputType` type-name
  // fields don't exist in the port.)
  const pipe = pipeline(increment) // pipe(symbol)  number -> number
    .pipe(stringify) //               pipe(symbol)  number -> string
    .map((s) => s.length) //          map           string -> number
    .seal();

  expect(pipe.descriptors.map((d) => d.kind)).toEqual(['pipe(symbol)', 'pipe(symbol)', 'map(closure)']);
  expect(pipe.descriptors.map((d) => d.symbolId)).toEqual([
    'test.increment',
    'test.stringify',
    undefined,
  ]);
});

test('tapAndVerbStagesAreLabelledInTheDescriptor', () => {
  const pipe = pipeline(increment) // pipe(symbol)  number -> number
    .tap(erase) //                    tap(symbol)   side-effect, number flows through
    .pipe({ note: 'identity' }, (_kernel, n) => next(n)) // pipe(meta, verbFn) anonymous
    .seal();

  expect(pipe.descriptors.map((d) => d.kind)).toEqual(['pipe(symbol)', 'tap(symbol)', 'pipe(closure)']);
  expect(pipe.descriptors.map((d) => d.symbolId)).toEqual(['test.increment', 'test.erase', undefined]);
});

test('symbolDescriptionFlowsIntoTheDescriptor', () => {
  // A documented symbol carries its description; the pipe builder lifts it
  // into the stage descriptor's `note` (anonymous `map` carries none unless
  // given an optional `StageMeta` — this call omits it).
  const documented = symbol<number, number>('test.documented', 'doubles the input');
  const pipe = pipeline(documented)
    .map((n) => n + 1)
    .seal();

  expect(pipe.descriptors.map((d) => d.note)).toEqual(['doubles the input', undefined]);
});

test('mapAndEffectLiftAnOptionalMetaNoteIntoTheDescriptor', () => {
  // map/effect carry no symbol and no verb, so their only "what this does"
  // channel is the optional StageMeta note — the relief valve verb stages are
  // forced to fill. Supplied here, it must reach `descriptor.note`; the
  // arity, not a flag, picks the meta overload.
  const pipe = pipeline(increment)
    .map({ note: 'projects to a label' }, (n) => `${n}`) // map(meta, transform)
    .effect({ note: 'persists the label' }, (_kernel, _s) => {}) // effect(meta, run)
    .seal();

  expect(pipe.descriptors.map((d) => d.kind)).toEqual(['pipe(symbol)', 'map(closure)', 'effect(closure)']);
  expect(pipe.descriptors.map((d) => d.note)).toEqual([
    undefined, // the increment leaf is undocumented
    'projects to a label',
    'persists the label',
  ]);
});

test('tapLiftsAnOptionalMetaNoteOverTheSymbolDescription', () => {
  // tap(symbol) is the one symbol-backed stage with an author note channel:
  // the symbol's description says WHAT it does, the site's note says why it
  // is tapped HERE — when both exist the author's note wins, and omitting
  // meta keeps the plain transcription.
  const documented = symbol<number, void>('test.save', 'persists the value');
  const pipe = pipeline(increment)
    .tap({ note: 'disk first — do not update state if the save fails' }, documented)
    .tap(documented)
    .seal();

  expect(pipe.descriptors.map((d) => d.kind)).toEqual(['pipe(symbol)', 'tap(symbol)', 'tap(symbol)']);
  expect(pipe.descriptors.map((d) => d.note)).toEqual([
    undefined,
    'disk first — do not update state if the save fails',
    'persists the value',
  ]);
});

test('mapAndEffectLeaveNoteUndefinedWhenMetaOmitted', () => {
  // Regression guard for the non-breaking arity dispatch: the classic
  // single-argument shapes must still stamp `note: undefined`.
  const pipe = pipeline(increment)
    .map((n) => `${n}`) // map(transform) — the pre-existing shape
    .effect((_kernel, _s) => {}) // effect(run) — the pre-existing shape
    .seal();

  expect(pipe.descriptors.map((d) => d.note)).toEqual([undefined, undefined, undefined]);
});

test('divertsToNamesCandidateTargetsOnAnonymousVerbStages', () => {
  // `divert`'s actual target is runtime-decided and can't be derived, but an
  // author can name candidates for a wiring graph to render as jump links.
  const entry = pipeline(
    { note: 'maybe divert', divertsTo: ['Circuit.Slideshow.create'] },
    (_kernel: Kernel, n: number): Verb<number> => next(n),
  )
    .pipe(
      { note: 'maybe divert too', divertsTo: ['Circuit.Slideshow.open', 'Circuit.Slideshow.delete'] },
      (_kernel, n) => next(n),
    )
    .map((n) => n + 1) // map never diverts — carries no divertsTo
    .seal();

  expect(entry.descriptors.map((d) => d.divertsTo)).toEqual([
    ['Circuit.Slideshow.create'],
    ['Circuit.Slideshow.open', 'Circuit.Slideshow.delete'],
    [],
  ]);
});

// `next()` — the zero-argument overload.
// A pipe that carries no value should say so in its own cursor TYPE, not carry an
// `undefined` the author never wrote. Both spellings must run identically; only the
// static type (and therefore `StageEntry.flows`) differs.
test('next() continues a void pipe with the same runtime verb as next(undefined)', () => {
  expect(next()).toEqual({ kind: 'next', value: undefined });
  expect(next()).toEqual(next(undefined));
});

test('next() types the cursor as void, next(undefined) as undefined', () => {
  const voidVerb: Verb<void> = next();
  const undefinedVerb: Verb<undefined> = next(undefined);
  // Compile-time is the assertion; these keep the bindings live at runtime.
  expect(voidVerb.kind).toBe('next');
  expect(undefinedVerb.kind).toBe('next');
  // `Verb<undefined>` is assignable to `Verb<void>` (value is covariant), not vice
  // versa — so a `void` pipe accepts either, and this overload costs no expressiveness.
  const widened: Verb<void> = undefinedVerb;
  expect(widened.kind).toBe('next');
});
