import { expect, test } from 'vitest';
import { abort, fail } from '../src/index.js';

// MARK: - abort/fail desc (additive, non-breaking)

test('abort(value, desc) carries the desc through as a structured field', () => {
  const verb = abort('boom', 'reason');
  expect(verb).toEqual({ kind: 'abort', value: 'boom', desc: 'reason' });
});

test('abort(value) without desc has no desc property at all', () => {
  const verb = abort('boom');
  expect(verb).toEqual({ kind: 'abort', value: 'boom' });
  expect('desc' in verb).toBe(false);
});

test('fail(error, desc) carries the desc through as a structured field', () => {
  const error = new Error('nope');
  const verb = fail(error, 'reason');
  expect(verb).toEqual({ kind: 'fail', error, desc: 'reason' });
});

test('fail(error) without desc has no desc property at all', () => {
  const error = new Error('nope');
  const verb = fail(error);
  expect(verb).toEqual({ kind: 'fail', error });
  expect('desc' in verb).toBe(false);
});
