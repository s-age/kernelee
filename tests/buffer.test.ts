import { expect, test } from 'vitest';
import {
  defineState,
  fail,
  symbol,
  BufferBuilder,
  BufferError,
  KernelBuilder,
  KernelErrorState,
} from '../src/index.js';

// MARK: - Fixtures

/**
 * Throwaway app states — any value shape works as a buffer cell. Minted at
 * module scope (one `defineState` per shape, in the module that owns it):
 * the id ledger is module-global, so a per-test mint would throw
 * `'duplicateStateId'` on the second run of the same helper.
 */
const CounterState = defineState('test.CounterState', { n: 0 });
const GridState = defineState<{ rows: number[] }>('test.GridState', { rows: [] });

class Boom extends Error {}
const boom = symbol<number, void>('test.buffer.boom');

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `condition` holds — how a test observes a fire-and-forget dispatch settling. */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 1000; i += 1) {
    if (condition()) return;
    await sleep(1);
  }
  throw new Error('condition never held');
}

// MARK: - defineState (the type-as-key translation)

test('defineStateRejectsADuplicateId', () => {
  defineState('test.buffer.unique', 0);
  expect(() => defineState('test.buffer.unique', 1)).toThrowError(BufferError);
  try {
    defineState('test.buffer.unique', 2);
  } catch (error) {
    expect((error as BufferError).code).toBe('duplicateStateId');
    expect((error as BufferError).stateId).toBe('test.buffer.unique');
  }
});

// MARK: - Allocation (Swift DefaultsTests: buffer provisioning)

test('buildSeedsKernelErrorStateWithoutAnyAllocateCall', () => {
  const buffer = new BufferBuilder().build();
  expect(buffer.read(KernelErrorState).message).toBeNull();
});

test('explicitAllocationIsNotClobberedByTheDefaultSeeding', () => {
  // Swift pre-seeds a custom KernelErrorState value; the TS seed rides on the
  // key, so the observable half here is: build()'s allocateIfAbsent tolerates
  // — and does not replace — an explicitly allocated framework cell.
  const builder = new BufferBuilder();
  builder.allocate(KernelErrorState);
  const buffer = builder.build(); // no 'duplicateAllocate' throw, no reseed
  expect(buffer.read(KernelErrorState).message).toBeNull();
});

test('allocateIfAbsentDoesNotOverrideAnExplicitAllocate', () => {
  const builder = new BufferBuilder();
  builder.allocate(CounterState);
  const live = builder.build();
  live.mutate(CounterState, () => ({ n: 41 })); // cells are shared with the builder
  builder.allocateIfAbsent(CounterState); // must be a no-op — the cell is present
  const rebuilt = builder.build();
  expect(rebuilt.read(CounterState).n).toBe(41); // a replaced cell would read the seed (0)
});

test('duplicateAllocateThrows', () => {
  const builder = new BufferBuilder();
  builder.allocate(CounterState);
  expect(() => builder.allocate(CounterState)).toThrowError(BufferError);
  try {
    builder.allocate(CounterState);
  } catch (error) {
    expect((error as BufferError).code).toBe('duplicateAllocate');
  }
});

test('accessToAnUnallocatedKeyThrows', () => {
  const buffer = new BufferBuilder().build(); // only KernelErrorState is seeded
  expect(() => buffer.read(GridState)).toThrowError(BufferError);
  expect(() => buffer.mutate(GridState, (g) => g)).toThrowError(BufferError);
  expect(() => buffer.subscribe(GridState, () => {})).toThrowError(BufferError);
  try {
    buffer.read(GridState);
  } catch (error) {
    expect((error as BufferError).code).toBe('unallocated');
    expect((error as BufferError).stateId).toBe('test.GridState');
  }
});

// MARK: - mutate / subscribe / getSnapshot (the useSyncExternalStore contract)

test('mutateNotifiesEachListenerExactlyOncePerCommit', () => {
  const builder = new BufferBuilder();
  builder.allocate(GridState);
  const buffer = builder.build();

  let notified = 0;
  buffer.subscribe(GridState, () => {
    notified += 1;
  });

  buffer.mutate(GridState, (g) => ({ rows: [...g.rows, 1] }));
  expect(notified).toBe(1);
  buffer.mutate(GridState, (g) => ({ rows: [...g.rows, 2] }));
  expect(notified).toBe(2);
  expect(buffer.read(GridState).rows).toEqual([1, 2]);
});

test('getSnapshotReturnsAFreshReferencePerMutate', () => {
  const builder = new BufferBuilder();
  builder.allocate(GridState);
  const buffer = builder.build();

  const before = buffer.getSnapshot(GridState);
  buffer.mutate(GridState, (g) => ({ rows: [...g.rows, 1] })); // copy-on-write
  const after = buffer.getSnapshot(GridState);
  expect(after).not.toBe(before); // reference change — what React diffs on
  expect(after.rows).toEqual([1]);
  expect(before.rows).toEqual([]); // the old snapshot is untouched history
  expect(buffer.getSnapshot(GridState)).toBe(after); // stable between mutates
});

test('unsubscribedListenerIsNotNotified', () => {
  const builder = new BufferBuilder();
  builder.allocate(CounterState);
  const buffer = builder.build();

  const hits: string[] = [];
  const unsubscribe = buffer.subscribe(CounterState, () => hits.push('a'));
  buffer.subscribe(CounterState, () => hits.push('b'));

  buffer.mutate(CounterState, (c) => ({ n: c.n + 1 }));
  expect(hits).toEqual(['a', 'b']);

  unsubscribe();
  buffer.mutate(CounterState, (c) => ({ n: c.n + 1 }));
  expect(hits).toEqual(['a', 'b', 'b']); // only the surviving listener fired
});

test('aThrowingListenerDoesNotStarveItsSiblings', () => {
  const builder = new BufferBuilder();
  builder.allocate(CounterState);
  const buffer = builder.build();

  const hits: string[] = [];
  buffer.subscribe(CounterState, () => {
    throw new Boom();
  });
  buffer.subscribe(CounterState, () => hits.push('survivor'));

  expect(() => buffer.mutate(CounterState, (c) => ({ n: c.n + 1 }))).not.toThrow();
  expect(hits).toEqual(['survivor']);
});

// MARK: - Default error sink (Swift DefaultsTests)

test('defaultErrorSinkRendersDispatchFailureIntoKernelErrorState', async () => {
  const builder = new KernelBuilder();
  builder.registerVerb(boom, () => fail(new Boom('went sideways')));
  const kernel = builder.build(); // no onError, no buffer: both defaulted

  kernel.dispatch(boom, 1);
  await until(() => kernel.buffer.read(KernelErrorState).message !== null);

  // Swift defaultErrorSink format: "symbol: description".
  expect(kernel.buffer.read(KernelErrorState).message).toBe('test.buffer.boom: went sideways');
});

test('injectedErrorSinkOverridesTheDefault', async () => {
  const errors: string[] = [];
  const builder = new KernelBuilder();
  builder.registerVerb(boom, () => fail(new Boom('went sideways')));
  const kernel = builder.build({
    onError: (symbolId, error) => {
      errors.push(`err:${(error as Error).message}:${symbolId}`);
    },
  });

  kernel.dispatch(boom, 1);
  await until(() => errors.length === 1);

  expect(errors[0]).toBe('err:went sideways:test.buffer.boom');
  // The default target stays untouched — the injected sink replaced it.
  expect(kernel.buffer.read(KernelErrorState).message).toBeNull();
});

// MARK: - Kernel integration

test('buildFreezesTheInjectedBufferBuilderIntoKernelBuffer', () => {
  const bufferBuilder = new BufferBuilder();
  bufferBuilder.allocate(GridState);
  const kernel = new KernelBuilder().build({ buffer: bufferBuilder });

  kernel.buffer.mutate(GridState, () => ({ rows: [7] }));
  expect(kernel.buffer.read(GridState).rows).toEqual([7]);
  expect(kernel.buffer.read(KernelErrorState).message).toBeNull(); // seeded by build()
});
