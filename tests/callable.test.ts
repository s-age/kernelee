import { expect, expectTypeOf, test, vi } from 'vitest';
import {
  CallableError,
  KernelBuilder,
  abort,
  defineCallable,
  divert,
  diversion,
  fail,
  next,
  pipeline,
  port,
  portK,
  portKV,
  portV,
  type CallableDeviceOf,
  type Kernel,
  type KernelSymbol,
  type Verb,
} from '../src/index.js';

// MARK: - Fixture port (the task's LifePort, all four marker kinds)

interface Seed {
  readonly value: number;
}

/**
 * One spec exercising the whole 2×2: leaf/composing × value/verb — the TS
 * counterpart of a `@callable("Compute.Life")` protocol whose methods span
 * Swift's four `register` overloads.
 */
const LifePort = defineCallable('Compute.Life', {
  stepChunk: port<readonly number[], readonly number[]>('advance a row chunk one generation'),
  randomize: port<Seed, readonly number[]>('generate a random board'),
  reset: portK<void, void>('reset the board and generation'),
  guard: portV<number, number>('fail on negative, abort(42) on zero, otherwise next with the double'),
  route: portKV<number, string>('estimate via the kernel, then choose next / divert'),
});

type LifeDevice = CallableDeviceOf<typeof LifePort>;

/** A device implementing exactly the spec — typed (non-fresh) on purpose. */
function makeDevice(log: string[]): LifeDevice {
  return {
    stepChunk: (cells) => cells.map((c) => c + 1),
    randomize: (seed) => [seed.value, seed.value],
    // `void` payload elided — fn.length === 1 even though this is composing:
    // the marker (not fn.length on the *device* method) decides the binding.
    reset: async (kernel) => {
      const stepped = await kernel.call(LifePort.stepChunk, [0]);
      log.push(`reset:${stepped.join(',')}`);
    },
    guard: (n) => (n < 0 ? fail(new Error('negative')) : n === 0 ? abort(42) : next(n * 2)),
    route: async (kernel, n) => {
      const stepped = await kernel.call(LifePort.stepChunk, [n]);
      return n >= 0
        ? next(`ok:${stepped.join(',')}`)
        : divert(diversion(pipeline(LifePort.guard).map((d) => `diverted:${d}`).seal(), -n));
    },
  };
}

function buildLifeKernel(log: string[] = []): Kernel {
  const builder = new KernelBuilder();
  LifePort.wire(makeDevice(log), builder);
  return builder.build();
}

// MARK: - Id derivation / description injection

/** The generated symbol's id is `"prefix.method"` — the macro's `"\(prefix).\(name)"`. */
test('symbolIdIsPrefixDotMethod', () => {
  expect(LifePort.stepChunk.id).toBe('Compute.Life.stepChunk');
  expect(LifePort.randomize.id).toBe('Compute.Life.randomize');
  expect(LifePort.reset.id).toBe('Compute.Life.reset');
  expect(LifePort.guard.id).toBe('Compute.Life.guard');
  expect(LifePort.route.id).toBe('Compute.Life.route');
});

/** `port(doc)` lands as `Symbol.description` — the doc-comment lift, as data. */
test('docIsInjectedAsSymbolDescription', () => {
  expect(LifePort.stepChunk.description).toBe('advance a row chunk one generation');
  expect(LifePort.reset.description).toBe('reset the board and generation');
});

// MARK: - Wiring + calls (all four marker kinds)

/** A leaf value port round-trips through `kernel.call`, fully typed. */
test('leafPortAnswersCall', async () => {
  const kernel = buildLifeKernel();
  expect(await kernel.call(LifePort.stepChunk, [1, 2, 3])).toEqual([2, 3, 4]);
  expect(await kernel.call(LifePort.randomize, { value: 7 })).toEqual([7, 7]);
});

/**
 * A `portK` implementation receives the *kernel* first and can route back
 * into the mesh — even though the device method elides its `void` payload
 * (fn.length === 1): wire's synthesized closure carries the composing arity,
 * so the marker, not the device method's declared parameter count, decides.
 */
test('portKReceivesKernelDespiteElidedVoidPayload', async () => {
  const log: string[] = [];
  const kernel = buildLifeKernel(log);
  await kernel.call(LifePort.reset); // void-payload sugar
  expect(log).toEqual(['reset:1']);
});

/** A `portV` verb is interpreted by `call`: `next` yields, `fail` rejects. */
test('portVVerbDrivesCall', async () => {
  const kernel = buildLifeKernel();
  expect(await kernel.call(LifePort.guard, 3)).toBe(6);
  await expect(kernel.call(LifePort.guard, -1)).rejects.toThrowError('negative');
});

/**
 * A `portV` verb drives a *pipe*: its `abort` terminates the pipe with the
 * abort value — downstream stages never run.
 */
test('portVVerbDrivesCompose', async () => {
  const kernel = buildLifeKernel();
  const doubledPlusOne = pipeline(LifePort.guard).map((n) => n + 1).seal();
  expect(await kernel.compose(doubledPlusOne, 3)).toBe(7); // next(6) → map
  expect(await kernel.compose(doubledPlusOne, 0)).toBe(42); // abort(42) skips map
});

/** A `portKV` handler gets the kernel *and* owns pipeline control (`divert`). */
test('portKVComposesAndDiverts', async () => {
  const kernel = buildLifeKernel();
  expect(await kernel.call(LifePort.route, 2)).toBe('ok:3');
  // n < 0: diverts to a guard pipe fed -n → guard doubles → map labels it.
  expect(await kernel.call(LifePort.route, -5)).toBe('diverted:10');
});

// MARK: - Wiring exhaustiveness

/**
 * `wire` performs one register per spec key — `boundSymbolIds` covers exactly
 * the generated ids. This is the wiring leg of the totality triangle, and the
 * assertion a consumer's wiring smoke test repeats.
 */
test('wireBindsEverySpecKey', () => {
  const builder = new KernelBuilder();
  LifePort.wire(makeDevice([]), builder);
  expect(builder.boundSymbolIds).toEqual(
    new Set([
      'Compute.Life.stepChunk',
      'Compute.Life.randomize',
      'Compute.Life.reset',
      'Compute.Life.guard',
      'Compute.Life.route',
    ]),
  );
});

// MARK: - Cross-definition id collision

/**
 * Two `defineCallable`s minting the same `"prefix.method"` id must throw at
 * the *second mint* (module evaluation), not silently collide in
 * `KernelBuilder` at some later wire. Swift's `SymbolIDRegistry` +
 * `DuplicateSymbolID` compile error, translated.
 */
test('duplicateIdAcrossDefineCallableThrows', () => {
  defineCallable('Collide.Widget', { fetch: port<string, number>('fetch a widget') });
  try {
    defineCallable('Collide.Widget', { fetch: port<string, number>('a second claim') });
    expect.unreachable('second mint of the same id must throw');
  } catch (error) {
    expect(error).toBeInstanceOf(CallableError);
    expect((error as CallableError).code).toBe('duplicateSymbolId');
    expect((error as CallableError).symbolId).toBe('Collide.Widget.fetch');
  }
});

/** Distinct ids coexist — the ledger fires on collision, not on volume. */
test('distinctPrefixesMintFreely', () => {
  const a = defineCallable('Distinct.A', { hit: port<void, void>('a') });
  const b = defineCallable('Distinct.B', { hit: port<void, void>('b') });
  expect(a.hit.id).toBe('Distinct.A.hit');
  expect(b.hit.id).toBe('Distinct.B.hit');
});

/** A spec key colliding with the generated surface (`wire`) throws at mint. */
test('reservedSpecKeyThrows', () => {
  try {
    defineCallable('Reserved.Port', { wire: port<void, void>('would shadow the generated wire') });
    expect.unreachable('reserved key must throw');
  } catch (error) {
    expect(error).toBeInstanceOf(CallableError);
    expect((error as CallableError).code).toBe('reservedMethodName');
    expect((error as CallableError).symbolId).toBe('Reserved.Port.wire');
  }
});

// MARK: - Undocumented port warning

/**
 * A missing (or blank) doc is a visible hole, warned at mint time — Swift's
 * `UndocumentedCallable` diagnostic is a *warning*, so `doc` is optional and
 * the TS translation warns rather than throws. The symbol then carries no
 * description.
 */
test('missingDocWarnsAtDefineCallable', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const bare = defineCallable('Warn.Port', {
      undocumented: port<void, void>(),
      blank: port<void, void>('   '),
      documented: port<void, void>('has a doc'),
    });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
      expect.stringContaining("'Warn.Port.undocumented' has no doc"),
      expect.stringContaining("'Warn.Port.blank' has no doc"),
    ]);
    expect(bare.undocumented.description).toBeUndefined();
    expect(bare.blank.description).toBeUndefined();
    expect(bare.documented.description).toBe('has a doc');
  } finally {
    warn.mockRestore();
  }
});

// MARK: - Escape-hatch guard

/**
 * `wire` past an `as` cast (the only way to reach it with a hole) fails loud
 * with `'missingImplementation'` at wire time — not as `'unbound'` on a cold
 * call path.
 */
test('wireThrowsOnMissingImplementationPastACast', () => {
  const builder = new KernelBuilder();
  const holey = { stepChunk: (cells: readonly number[]) => cells } as unknown as LifeDevice;
  try {
    LifePort.wire(holey, builder);
    expect.unreachable('missing implementation must throw at wire');
  } catch (error) {
    expect(error).toBeInstanceOf(CallableError);
    expect((error as CallableError).code).toBe('missingImplementation');
  }
});

// MARK: - Type-level exactness (the forward leg of the totality triangle)

/** The generated symbols carry the spec's payload/output types. */
test('typeLevel: symbolsAreTyped', () => {
  expectTypeOf(LifePort.stepChunk).toEqualTypeOf<KernelSymbol<readonly number[], readonly number[]>>();
  expectTypeOf(LifePort.reset).toEqualTypeOf<KernelSymbol<void, void>>();
  expectTypeOf(LifePort.guard).toEqualTypeOf<KernelSymbol<number, number>>();
});

/** `CallableDeviceOf` derives the per-kind handler shapes from the markers. */
test('typeLevel: deviceShapesFollowTheMarkers', () => {
  expectTypeOf<LifeDevice['stepChunk']>().toEqualTypeOf<
    (payload: readonly number[]) => readonly number[] | Promise<readonly number[]>
  >();
  expectTypeOf<LifeDevice['reset']>().toEqualTypeOf<(kernel: Kernel, payload: void) => void | Promise<void>>();
  expectTypeOf<LifeDevice['guard']>().toEqualTypeOf<(payload: number) => Verb<number> | Promise<Verb<number>>>();
  expectTypeOf<LifeDevice['route']>().toEqualTypeOf<
    (kernel: Kernel, payload: number) => Verb<string> | Promise<Verb<string>>
  >();
});

/**
 * Compile-time exactness — never invoked; it exists so tsc checks the bodies.
 * Each `@ts-expect-error` pins one rejection: a green `tsc --noEmit` proves
 * the miswiring *fails to compile*. Devices are built by spreading a *typed*
 * (non-fresh) value, so freshness-based excess-property checking is out of
 * the picture and the rejections below are the mapped-type / Exclude-`never`
 * guards' own work.
 */
export function _typeOnlyExactness(builder: KernelBuilder): void {
  const ok: LifeDevice = makeDevice([]);
  LifePort.wire(ok, builder); // exact device: compiles (non-fresh)

  const { stepChunk: _dropped, ...missingStepChunk } = ok;
  // @ts-expect-error missing implementation — a device lacking stepChunk is rejected by the CallableDevice constraint
  LifePort.wire(missingStepChunk, builder);

  const withExtra = { ...ok, extra: () => 0 };
  // @ts-expect-error excess key — rejected by the Exclude-never guard even on a non-fresh device
  LifePort.wire(withExtra, builder);

  const wrongPayload = { ...ok, stepChunk: (s: string) => s };
  // @ts-expect-error payload type mismatch — a string handler cannot ride a number[] port
  LifePort.wire(wrongPayload, builder);

  const valueWhereVerbExpected = { ...ok, guard: (n: number) => n * 2 };
  // @ts-expect-error no verb — portV requires a Verb<number> return
  LifePort.wire(valueWhereVerbExpected, builder);

  const kernel = undefined as unknown as Kernel;
  // @ts-expect-error consumers are bound by the symbol's types too — payload type mismatch
  void kernel.call(LifePort.stepChunk, 'not-a-chunk');
}
