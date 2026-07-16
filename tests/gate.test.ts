import { expect, test } from 'vitest';
import {
  abort,
  declareGate,
  dispatchKey,
  divert,
  fail,
  keyedDiversion,
  next,
  pipeline,
  symbol,
  BufferError,
  GateError,
  KernelBuilder,
  KernelError,
  TraceState,
  type Kernel,
} from '../src/index.js';

class Boom extends Error {}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `condition` holds, bounded so a stuck bus fails instead of hanging — same idiom as `dispatch.test.ts`/`fork.test.ts`. */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 1000; i += 1) {
    if (condition()) return;
    await sleep(1);
  }
  throw new Error('condition never held');
}

// MARK: - Single gate, allow / veto

test('singleGateAllowNextLetsTheOriginalHandlerRunUnchanged', async () => {
  const target = symbol<number, number>('gate.allow.target');
  const allow = declareGate<number>('guard:allow', () => next());

  const builder = new KernelBuilder();
  builder.register(target, (n) => n * 2);
  builder.guard(target, allow);
  const kernel = builder.build();

  expect(await kernel.call(target, 21)).toBe(42);
});

test('vetoViaFailPropagatesAsFailAndTheOriginalNeverRuns', async () => {
  const target = symbol<number, number>('gate.veto.fail.target');
  let originalRan = false;
  const veto = declareGate<number>('guard:veto.fail', () => fail(new Boom('nope')));

  const builder = new KernelBuilder();
  builder.register(target, (n) => {
    originalRan = true;
    return n;
  });
  builder.guard(target, veto);
  const kernel = builder.build();

  await expect(kernel.call(target, 1)).rejects.toBeInstanceOf(Boom);
  expect(originalRan).toBe(false);
});

test('vetoViaDivertDivertsTheEnclosingFlowToTheKeyedTarget', async () => {
  const target = symbol<number, number>('gate.veto.divert.target');
  const rescueSym = symbol<number, number>('gate.veto.divert.rescueSym');
  const rescueFlow = dispatchKey<number>('gate.veto.divert.rescueFlow');
  const divertGate = declareGate<number>('guard:veto.divert', (_kernel: Kernel, n: number) =>
    divert(keyedDiversion(rescueFlow, n * 100)),
  );

  const builder = new KernelBuilder();
  builder.register(target, (n) => n); // never runs — the gate vetoes before it
  builder.register(rescueSym, (n) => n + 1);
  builder.flow(rescueFlow, 'rescuePipe', pipeline(rescueSym).seal());
  builder.guard(target, divertGate);
  const kernel = builder.build();

  const entryPipe = pipeline(target).seal();
  expect(await kernel.compose(entryPipe, 5)).toBe(501); // 5*100, then rescuePipe's +1
});

test('vetoViaAbortIsNotStructurallyBlockedThoughDiscouraged', async () => {
  const target = symbol<number, number>('gate.veto.abort.target');
  let originalRan = false;
  const abortGate = declareGate<number>('guard:veto.abort', () => abort(-1));

  const builder = new KernelBuilder();
  builder.register(target, (n) => {
    originalRan = true;
    return n;
  });
  builder.guard(target, abortGate);
  const kernel = builder.build();

  expect(await kernel.call(target, 5)).toBe(-1);
  expect(originalRan).toBe(false);
});

// MARK: - Multi-gate fold (registration order, short-circuit)

test('multiGateFoldRunsInRegistrationOrderAndShortCircuitsOnFirstVeto', async () => {
  const target = symbol<number, number>('gate.fold.target');
  const calls: string[] = [];
  const first = declareGate<number>('guard:fold.first', () => {
    calls.push('first');
    return next();
  });
  const second = declareGate<number>('guard:fold.second', () => {
    calls.push('second');
    return fail(new Boom('vetoed'));
  });
  const third = declareGate<number>('guard:fold.third', () => {
    calls.push('third');
    return next();
  });

  const builder = new KernelBuilder();
  builder.register(target, (n) => n);
  builder.guard(target, first);
  builder.guard(target, second);
  builder.guard(target, third);
  const kernel = builder.build();

  await expect(kernel.call(target, 1)).rejects.toBeInstanceOf(Boom);
  expect(calls).toEqual(['first', 'second']); // third never runs
});

// MARK: - Same GateRef guarding multiple targets

test('sameGateRefGuardingMultipleTargetsRunsPerTargetInvokeButRegistersOnce', async () => {
  const targetA = symbol<number, number>('gate.group.a');
  const targetB = symbol<number, number>('gate.group.b');
  let runs = 0;
  const shared = declareGate<number>('guard:group.shared', () => {
    runs += 1;
    return next();
  });

  const builder = new KernelBuilder();
  builder.register(targetA, (n) => n + 1);
  builder.register(targetB, (n) => n + 2);
  builder.guard(targetA, shared);
  builder.guard(targetB, shared);
  const kernel = builder.build(); // must not throw — the shared gate id is deduplicated before registering

  expect(await kernel.call(targetA, 1)).toBe(2);
  expect(await kernel.call(targetB, 1)).toBe(3);
  expect(runs).toBe(2); // once per invoke, not once per guard() call
});

// MARK: - declareGate id ledger

test('reDeclareGateWithTheSameIdThrowsGateError', () => {
  declareGate<number>('guard:dup.reDeclareGateTest', () => next());
  expect(() => declareGate<number>('guard:dup.reDeclareGateTest', () => next())).toThrow(GateError);
  try {
    declareGate<number>('guard:dup.reDeclareGateTest', () => next());
  } catch (error) {
    expect(error).toBeInstanceOf(GateError);
    expect((error as GateError).code).toBe('duplicateGateId');
    expect((error as GateError).gateId).toBe('guard:dup.reDeclareGateTest');
  }
});

// MARK: - build()-time completeness (unbound target)

test('guardOnATargetNeverRegisteredThrowsKernelErrorUnboundAtBuild', () => {
  const target = symbol<number, number>('gate.unbound.target');
  const gate = declareGate<number>('guard:unbound.target', () => next());

  const builder = new KernelBuilder();
  builder.guard(target, gate); // no register() for `target`

  expect(() => builder.build()).toThrow(KernelError);
  try {
    builder.build();
  } catch (error) {
    expect((error as KernelError).code).toBe('unbound');
    expect((error as KernelError).symbolId).toBe('gate.unbound.target');
  }
});

test('gateIdCollidingWithAnAlreadyBoundSymbolIdThrowsKernelErrorDuplicateAtBuild', () => {
  const target = symbol<number, number>('gate.collision.target');
  const squatter = symbol<number, number>('guard:collision.clash'); // a hand-minted symbol squatting on the gate's id
  const gate = declareGate<number>('guard:collision.clash', () => next());

  const builder = new KernelBuilder();
  builder.register(target, (n) => n);
  builder.register(squatter, (n) => n);
  builder.guard(target, gate);

  expect(() => builder.build()).toThrow(KernelError);
  try {
    builder.build();
  } catch (error) {
    expect((error as KernelError).code).toBe('duplicate');
    expect((error as KernelError).symbolId).toBe('guard:collision.clash');
  }
});

// MARK: - Idempotent duplicate guard()

test('duplicateGuardOfTheSameTargetGateRefPairIsIdempotent', async () => {
  const target = symbol<number, number>('gate.idempotent.target');
  let runs = 0;
  const gate = declareGate<number>('guard:idempotent', () => {
    runs += 1;
    return next();
  });

  const builder = new KernelBuilder();
  builder.register(target, (n) => n);
  builder.guard(target, gate);
  builder.guard(target, gate); // duplicate (target, gate) pair — absorbed, not a second fold entry
  expect(builder.guardCatalog).toEqual([{ targetId: target.id, gateIds: [gate.id] }]);

  const kernel = builder.build();
  await kernel.call(target, 1);
  expect(runs).toBe(1); // the gate ran exactly once per invoke, not twice
});

// MARK: - guardCatalog

test('guardCatalogReflectsPerTargetRegistrationOrder', () => {
  const target = symbol<number, number>('gate.catalog.target');
  const g1 = declareGate<number>('guard:catalog.g1', () => next());
  const g2 = declareGate<number>('guard:catalog.g2', () => next());

  const builder = new KernelBuilder();
  builder.register(target, (n) => n);
  builder.guard(target, g1);
  builder.guard(target, g2);

  expect(builder.guardCatalog).toEqual([{ targetId: target.id, gateIds: [g1.id, g2.id] }]);
});

// MARK: - Re-entrancy

test('gateCallingItsOwnTargetPassesThroughWithoutReRunningTheGate', async () => {
  const target = symbol<number, number>('gate.reentrant.self');
  let gateRuns = 0;
  let originalRuns = 0;
  const selfGate = declareGate<number>('guard:reentrant.self', async (kernel: Kernel, n: number) => {
    gateRuns += 1;
    if (n > 0) {
      await kernel.call(target, n - 1); // recurse into the SAME guarded target
    }
    return next();
  });

  const builder = new KernelBuilder();
  builder.register(target, (n) => {
    originalRuns += 1;
    return n;
  });
  builder.guard(target, selfGate);
  const kernel = builder.build();

  await kernel.call(target, 1);
  expect(gateRuns).toBe(1); // only the outermost call ran the gate
  expect(originalRuns).toBe(2); // the pass-through recursive call, plus the outer allow
});

test('gateCallingADifferentGuardedTargetStillRunsThatTargetsGate', async () => {
  const targetA = symbol<number, number>('gate.reentrant.a');
  const targetB = symbol<number, number>('gate.reentrant.b');
  let gateBRuns = 0;
  const gateA = declareGate<number>('guard:reentrant.a', async (kernel: Kernel, n: number) => {
    await kernel.call(targetB, n);
    return next();
  });
  const gateB = declareGate<number>('guard:reentrant.b', () => {
    gateBRuns += 1;
    return next();
  });

  const builder = new KernelBuilder();
  builder.register(targetA, (n) => n);
  builder.register(targetB, (n) => n * 10);
  builder.guard(targetA, gateA);
  builder.guard(targetB, gateB);
  const kernel = builder.build();

  expect(await kernel.call(targetA, 3)).toBe(3);
  expect(gateBRuns).toBe(1);
});

test('originalHandlersOwnSelfRecursionPassesThroughWithoutReRunningTheGate', async () => {
  const target = symbol<number, number>('gate.reentrant.recursion');
  let gateRuns = 0;
  const gate = declareGate<number>('guard:reentrant.recursion', () => {
    gateRuns += 1;
    return next();
  });

  const builder = new KernelBuilder();
  // Composing handler: recurses into its own symbol down to 0.
  builder.register(target, async (kernel: Kernel, n: number): Promise<number> =>
    n <= 0 ? 0 : 1 + (await kernel.call(target, n - 1)),
  );
  builder.guard(target, gate);
  const kernel = builder.build();

  expect(await kernel.call(target, 3)).toBe(3);
  expect(gateRuns).toBe(1); // only the outermost call ran the gate; every self-recursive level passed through
});

// MARK: - Trace-independence (marker works identically with tracing off)

test('reEntrancyAndCrossTargetGatingBothWorkWithTracingExplicitlyOff', async () => {
  const targetA = symbol<number, number>('gate.traceOff.a');
  const targetB = symbol<number, number>('gate.traceOff.b');
  let gateARuns = 0;
  let gateBRuns = 0;
  const gateA = declareGate<number>('guard:traceOff.a', async (kernel: Kernel, n: number) => {
    gateARuns += 1;
    await kernel.call(targetA, n); // self re-entrancy — must NOT re-run gateA
    await kernel.call(targetB, n); // cross-target — must still run gateB
    return next();
  });
  const gateB = declareGate<number>('guard:traceOff.b', () => {
    gateBRuns += 1;
    return next();
  });

  const builder = new KernelBuilder();
  builder.register(targetA, (n) => n);
  builder.register(targetB, (n) => n);
  builder.guard(targetA, gateA);
  builder.guard(targetB, gateB);
  const kernel = builder.build({ tracing: false });

  await kernel.call(targetA, 1);
  expect(gateARuns).toBe(1); // the self re-entrant call did not re-run gateA
  expect(gateBRuns).toBe(1); // the cross-target call still ran gateB once
  expect(() => kernel.buffer.read(TraceState)).toThrowError(BufferError); // confirms tracing is truly off
});

// MARK: - Tracing on: executed gates trace, short-circuited ones don't

test('tracingOnRecordsExecutedGatesAndOmitsShortCircuitedOnes', async () => {
  const target = symbol<number, number>('gate.trace.target');
  const allow = declareGate<number>('guard:trace.allow', () => next());
  const veto = declareGate<number>('guard:trace.veto', () => fail(new Boom('vetoed')));
  const neverRuns = declareGate<number>('guard:trace.never', () => next());

  const builder = new KernelBuilder();
  builder.register(target, (n) => n);
  builder.guard(target, allow);
  builder.guard(target, veto);
  builder.guard(target, neverRuns);
  const kernel = builder.build({ tracing: true });

  await expect(kernel.call(target, 1)).rejects.toBeInstanceOf(Boom);

  const { entries } = kernel.buffer.read(TraceState);
  const symbolIds = entries.map((e) => e.symbolId);
  expect(symbolIds).toContain(allow.id);
  expect(symbolIds).toContain(veto.id);
  expect(symbolIds).not.toContain(neverRuns.id); // short-circuited: never invoked, so no trace entry

  const vetoEntry = entries.find((e) => e.symbolId === veto.id);
  expect(vetoEntry?.verb).toBe('fail');
  const allowEntry = entries.find((e) => e.symbolId === allow.id);
  expect(allowEntry?.verb).toBe('next');
  // The gate's span nests under the target's own span (span linking through
  // the ordinary `invoke` chokepoint) — never a flow root of its own.
  const targetEntry = entries.find((e) => e.symbolId === target.id);
  expect(allowEntry?.span.parentId).toBe(targetEntry?.span.id);
});

// MARK: - Causal boundary (marker drop): dispatch

test('guardedHandlerDispatchingToItsOwnSymbolReRunsItsGateOnTheDispatchedFlow', async () => {
  const target = symbol<number, void>('gate.boundary.dispatch');
  let gateRuns = 0;
  const hits: number[] = [];
  const gate = declareGate<number>('guard:boundary.dispatch', () => {
    gateRuns += 1;
    return next();
  });

  const builder = new KernelBuilder();
  builder.register(target, (kernel: Kernel, n: number) => {
    hits.push(n);
    if (n === 1) {
      kernel.dispatch(target, 2); // fire-and-forget: starts a NEW causal flow
    }
  });
  builder.guard(target, gate);
  const kernel = builder.build();

  await kernel.call(target, 1);
  await until(() => hits.length === 2);

  expect(hits).toEqual([1, 2]);
  // The marker was dropped at the dispatch boundary: the dispatched flow's
  // own invoke of `target` re-ran the gate rather than passing through.
  expect(gateRuns).toBe(2);
});

// MARK: - Causal boundary (marker drop): fork

test('guardedHandlerForkingToItsOwnSymbolReRunsItsGateOnEachBranch', async () => {
  const target = symbol<number, number>('gate.boundary.fork');
  let gateRuns = 0;
  const gate = declareGate<number>('guard:boundary.fork', () => {
    gateRuns += 1;
    return next();
  });
  // An identity entry stage (never itself invokes `target`), fanning out to
  // two branches that each invoke `target` directly — isolates the fork
  // boundary itself from any extra invoke the entry stage might otherwise add.
  const forkPipe = pipeline({ note: 'fan out to target twice' }, (_kernel: Kernel, cursor: number) => next(cursor))
    .fork(pipeline(target), pipeline(target))
    .seal();

  const builder = new KernelBuilder();
  // Composing: the *outer* call (n=1) forks two branches that each call the
  // same guarded symbol directly (n=0, so they don't recurse further).
  builder.register(target, async (kernel: Kernel, n: number): Promise<number> => {
    if (n === 0) return 0;
    await kernel.compose(forkPipe, n - 1);
    return n;
  });
  builder.guard(target, gate);
  const kernel = builder.build();

  expect(await kernel.call(target, 1)).toBe(1);
  // Outer call (1) + two fork branches (each n=0) = 3 gate executions — a
  // fork branch is a new causal flow, so the marker dropped and each branch
  // re-hit the gate rather than passing through.
  expect(gateRuns).toBe(3);
});

// MARK: - next(value) ignored in v1

test('gateNextWithAValueIsIgnoredOriginalReceivesTheOriginalPayload', async () => {
  const target = symbol<number, number>('gate.nextValue.target');
  const rewrite = declareGate<number>('guard:nextValue', () => next(999));

  const builder = new KernelBuilder();
  builder.register(target, (n) => n);
  builder.guard(target, rewrite);
  const kernel = builder.build();

  expect(await kernel.call(target, 7)).toBe(7); // not 999
});
