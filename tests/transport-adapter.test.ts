import { expect, test } from 'vitest';
import { describePipe, projectWiringGraph, pipeline, symbol, KernelBuilder } from '../src/index.js';

// MARK: - Transport-adapter proof
//
// No `TransportAdapter` type exists (nor should one — freezing a concrete
// delivery shape into the core would take that design freedom away from the
// bridge package that actually builds one). This file instead proves the
// thing an external bridge needs: that `onTrace` and
// `describePipe`/`projectWiringGraph` are consumable through nothing
// but `index.ts`'s public export surface, by a `send` function that only
// knows how to serialize — never `kernelee`-internal modules like
// `src/kernel.ts` or `src/trace.ts`.

function dummyTransport(sent: unknown[]) {
  return (message: unknown) => {
    sent.push(JSON.parse(JSON.stringify(message))); // simulates a WebSocket send: only structure survives, not identity
  };
}

const echo = symbol<number, number>('transport.echo');

test('live path: onTrace forwards trace entries to an external sink via public exports only', async () => {
  const sent: unknown[] = [];
  const send = dummyTransport(sent);

  const builder = new KernelBuilder();
  builder.register(echo, (n: number) => n);
  const kernel = builder.build({
    tracing: true,
    onTrace: (symbolId, verb, span, payload, timestamp) => send({ symbolId, verb, span, payload, timestamp }),
  });

  await kernel.call(echo, 5);

  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ symbolId: echo.id, verb: 'next', payload: '5' });
});

test('static path: describePipe + projectWiringGraph produce a catalog forwardable to the same sink', () => {
  const sent: unknown[] = [];
  const send = dummyTransport(sent);

  const pipe = pipeline(echo).seal();
  const catalog = [describePipe(echo.id, 'echoPipe', pipe)];

  const builder = new KernelBuilder();
  builder.register(echo, (n: number) => n);

  const doc = projectWiringGraph(catalog, builder.boundSymbolIds);
  send(doc);

  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    // Bumped 4 → 5 with StageDescriptor.untrackedBranches (detached fork branches).
    schemaVersion: 5,
    endpoints: [{ key: echo.id, kind: 'endpoint' }],
  });
});
