import { expect, test } from 'vitest';
import { KernelBuilder, KernelError, next, symbol } from '../src/index.js';

// MARK: - Duplicate registration

/**
 * Registering the same symbol id twice must throw at the second `register`,
 * not silently last-write-win — *which handler answers a symbol* is the
 * runtime half of the architecture's guarantee, and the kernel must defend it
 * on its own. (Swift traps via `precondition`, observed through an exit test;
 * the TS translation throws, so a plain `expect(...).toThrowError` observes
 * it in-process.)
 */
test('duplicateRegisterThrowsAtTheSecondBind', () => {
  const sym = symbol<number, number>('test.duplicate');
  const builder = new KernelBuilder();
  builder.register(sym, (n) => n + 1);
  expect(() => builder.register(sym, (n) => n + 2)).toThrowError(KernelError);
  try {
    builder.register(sym, (n) => n + 3);
    expect.unreachable('second register must throw');
  } catch (error) {
    expect(error).toBeInstanceOf(KernelError);
    expect((error as KernelError).code).toBe('duplicate');
    expect((error as KernelError).symbolId).toBe('test.duplicate');
  }
});

/**
 * All register shapes funnel through the same write point, so a duplicate
 * throws regardless of which shapes collide — here the verb-returning shape
 * against a plain leaf.
 */
test('duplicateRegisterThrowsAcrossRegisterShapes', () => {
  const sym = symbol<number, number>('test.duplicate.overloads');
  const builder = new KernelBuilder();
  builder.register(sym, (n) => n * 2);
  expect(() => builder.registerVerb(sym, (n) => next(n))).toThrowError(KernelError);
});

/** Distinct ids coexist — the guard fires on *collision*, not on volume. */
test('distinctSymbolsRegisterFreely', () => {
  const builder = new KernelBuilder();
  builder.register(symbol<number, number>('test.register.a'), (n) => n);
  builder.register(symbol<number, number>('test.register.b'), (n) => n);
  expect(builder.boundSymbolIds).toEqual(new Set(['test.register.a', 'test.register.b']));
});
