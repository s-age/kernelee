import { expect, test } from 'vitest';
import { fail, symbol, KernelBuilder } from '../src/index.js';

// MARK: - Fixtures

const record = symbol<number, void>('test.record');
const boom = symbol<number, void>('test.boom');

class Boom extends Error {}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `condition` holds, bounded so a stuck bus fails instead of hanging. */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 1000; i += 1) {
    if (condition()) return;
    await sleep(1);
  }
  throw new Error('condition never held');
}

// MARK: - dispatch (fire-and-forget, serial, error -> sink)

test('dispatchRunsCommandsSeriallyInSubmissionOrder', async () => {
  const hits: string[] = [];
  const builder = new KernelBuilder();
  builder.register(record, async (n) => {
    // Earlier commands sleep longer: if the bus let a later command overtake
    // a still-running predecessor, the order would come out reversed.
    await sleep(6 - n);
    hits.push(`c:${n}`);
  });
  const kernel = builder.build();

  for (let n = 1; n <= 5; n += 1) kernel.dispatch(record, n); // fire-and-forget, returns immediately
  expect(hits).toEqual([]); // enqueue is synchronous — nothing has run yet

  await until(() => hits.length === 5);
  expect(hits).toEqual(['c:1', 'c:2', 'c:3', 'c:4', 'c:5']);
});

test('dispatchRoutesFailureToTheErrorSink', async () => {
  const errors: string[] = [];
  const builder = new KernelBuilder();
  builder.registerVerb(boom, () => fail(new Boom('boom')));
  const kernel = builder.build({
    onError: (symbolId, error) => {
      errors.push(`err:${(error as Error).message}:${symbolId}`);
    },
  });

  kernel.dispatch(boom, 1); // must not throw and must not surface as an unhandled rejection
  await until(() => errors.length === 1);
  expect(errors[0]).toBe('err:boom:test.boom');
});

/** One failed command must not wedge the bus — later submissions still drain. */
test('dispatchKeepsDrainingAfterAFailedCommand', async () => {
  const hits: string[] = [];
  const errors: string[] = [];
  const builder = new KernelBuilder();
  builder.registerVerb(boom, () => fail(new Boom('boom')));
  builder.register(record, (n) => {
    hits.push(`c:${n}`);
  });
  const kernel = builder.build({
    onError: (symbolId) => {
      errors.push(symbolId);
    },
  });

  kernel.dispatch(boom, 1);
  kernel.dispatch(record, 2);
  await until(() => hits.length === 1);
  expect(errors).toEqual(['test.boom']);
  expect(hits).toEqual(['c:2']);
});
