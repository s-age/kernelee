import { expect, expectTypeOf, test } from 'vitest';
import {
  KernelBuilder,
  actionsOf,
  defineCallable,
  port,
  portK,
  type Action,
  type Kernel,
} from '../src/index.js';

// MARK: - Fixture port (a slice of the task's SimPort)

const SimPort = defineCallable('Action.Sim', {
  setSpeed: portK<number, void>('set genPerSec'),
  play: portK<void, void>('start the tick loop'),
  echo: port<string, string>('echo the payload back (value-returning leaf)'),
});

const SimActions = actionsOf(SimPort);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `condition` holds, bounded so a stuck bus fails instead of hanging. */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 1000; i += 1) {
    if (condition()) return;
    await sleep(1);
  }
  throw new Error('condition never held');
}

// MARK: - actionsOf derivation

/** One creator per spec key — `wire` (the only function on the callable) is skipped. */
test('actionsOfDerivesOneCreatorPerSpecKey', () => {
  expect(Object.keys(SimActions).sort()).toEqual(['echo', 'play', 'setSpeed']);
});

/** A creator pairs the *generated* symbol (same reference) with its payload — an action is data. */
test('creatorPairsTheGeneratedSymbolWithThePayload', () => {
  const action = SimActions.setSpeed(30);
  expect(action.sym).toBe(SimPort.setSpeed);
  expect(action.payload).toBe(30);
});

/** A `void`-payload port derives a no-argument creator, mirroring `call(sym)`'s sugar. */
test('voidPayloadPortDerivesANoArgCreator', () => {
  const action = SimActions.play();
  expect(action.sym).toBe(SimPort.play);
  expect(action.payload).toBeUndefined();
});

// MARK: - dispatch(action)

/** `dispatch(action)` runs the same fire-and-forget path as `dispatch(sym, payload)`. */
test('dispatchAcceptsAnAction', async () => {
  const speeds: number[] = [];
  const builder = new KernelBuilder();
  builder.register(SimPort.setSpeed, (_kernel: Kernel, n: number) => {
    speeds.push(n);
  });
  builder.register(SimPort.play, (_kernel: Kernel, _payload: void) => {});
  builder.register(SimPort.echo, (s) => s);
  const kernel = builder.build();

  kernel.dispatch(SimActions.setSpeed(30));
  kernel.dispatch(SimActions.setSpeed(45));
  await until(() => speeds.length === 2);
  expect(speeds).toEqual([30, 45]); // serial bus: submission order preserved
});

/** A failed action's error goes to the sink with the *symbol's* id — same as the two-arg form. */
test('dispatchedActionFailureRoutesToTheErrorSinkWithTheSymbolId', async () => {
  const errors: string[] = [];
  const builder = new KernelBuilder();
  builder.register(SimPort.setSpeed, (_kernel: Kernel, _n: number) => {
    throw new Error('boom');
  });
  builder.register(SimPort.play, (_kernel: Kernel, _payload: void) => {});
  builder.register(SimPort.echo, (s) => s);
  const kernel = builder.build({
    onError: (symbolId, error) => {
      errors.push(`${symbolId}:${(error as Error).message}`);
    },
  });

  kernel.dispatch(SimActions.setSpeed(1)); // must not throw, must not reject unhandled
  await until(() => errors.length === 1);
  expect(errors[0]).toBe('Action.Sim.setSpeed:boom');
});

// MARK: - Type level

/** Creators carry the port's payload/output types through to the action. */
test('typeLevel: creatorsAreTypedByTheMarkers', () => {
  expectTypeOf(SimActions.setSpeed).toEqualTypeOf<(payload: number) => Action<number, void>>();
  expectTypeOf(SimActions.play).toEqualTypeOf<() => Action<void, void>>();
  expectTypeOf(SimActions.echo).toEqualTypeOf<(payload: string) => Action<string, string>>();
});

/**
 * Compile-time rejections — never invoked; exists so `tsc --noEmit` checks the
 * bodies (the same pattern as callable.test.ts's `_typeOnlyExactness`).
 */
export function _typeOnlyActionConstraints(kernel: Kernel): void {
  // @ts-expect-error payload type mismatch — setSpeed requires a number
  void SimActions.setSpeed('fast');
  // @ts-expect-error a void port's creator takes no arguments
  void SimActions.play(1);
  // @ts-expect-error an action is not a bare payload — the two-argument form rejects an action
  void kernel.dispatch(SimPort.setSpeed, SimActions.setSpeed(1));
}
