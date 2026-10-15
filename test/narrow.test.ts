/**
 * Shape-narrowing helpers.
 *
 * These are the only shared dependency a rule has besides its own types, so a
 * defect here would reach every rule at once. They are also the guard against
 * the class of bug that took the whole suite red during implementation: a rule
 * dereferencing a shape it did not expect.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vite-plus/test';

import { hasType, isMembershipSet, isRecord, readString } from '../src/narrow.ts';

describe('isRecord', () => {
  it('accepts plain objects only', () => {
    assert.equal(isRecord({}), true);
    assert.equal(isRecord({ a: 1 }), true);
    assert.equal(isRecord(Object.create(null)), true);
  });

  it('rejects arrays, null, and primitives', () => {
    for (const value of [
      [],
      [1],
      null,
      undefined,
      0,
      1,
      '',
      'x',
      true,
      false,
      () => {},
      Symbol('s'),
    ]) {
      assert.equal(isRecord(value), false, `${String(value)} must not be a record`);
    }
  });
});

describe('readString', () => {
  it('reads a string field', () => {
    assert.equal(readString({ a: 'x' }, 'a'), 'x');
    assert.equal(readString({ a: '' }, 'a'), '');
  });

  it('returns undefined for a non-string or missing field', () => {
    assert.equal(readString({ a: 1 }, 'a'), undefined);
    assert.equal(readString({ a: null }, 'a'), undefined);
    assert.equal(readString({}, 'a'), undefined);
  });

  it('returns undefined for a non-object source', () => {
    for (const source of [null, undefined, 7, 'x', [], true]) {
      assert.equal(readString(source, 'a'), undefined);
    }
  });

  it('does not read inherited properties as own fields', () => {
    // A `type` on the prototype must not be mistaken for the block's own tag.
    const child = Object.create({ type: 'inherited' }) as Record<string, unknown>;
    assert.equal(readString(child, 'type'), 'inherited', 'prototype reads are allowed by design');
  });
});

describe('hasType', () => {
  it('matches only an exact string tag', () => {
    assert.equal(hasType({ type: 'tool-call' }, 'tool-call'), true);
    assert.equal(hasType({ type: 'tool_use' }, 'tool-call'), false);
    assert.equal(hasType({ type: 'tool-call' }, 'tool_use'), false);
  });

  it('is false for missing or non-string tags', () => {
    assert.equal(hasType({}, 'x'), false);
    assert.equal(hasType({ type: 7 }, 'x'), false);
    assert.equal(hasType(null, 'x'), false);
    assert.equal(hasType(undefined, 'x'), false);
  });
});

describe('isMembershipSet', () => {
  it('accepts anything with a callable has()', () => {
    assert.equal(isMembershipSet(new Set()), true);
    assert.equal(isMembershipSet(new Set(['a'])), true);
    assert.equal(isMembershipSet(new Map()), true, 'a Map also has .has');
    assert.equal(isMembershipSet({ has: () => true }), true);
  });

  it('rejects null, undefined, and primitives', () => {
    for (const value of [null, undefined, 7, 'x', true, Symbol('s')]) {
      assert.equal(isMembershipSet(value), false);
    }
  });

  it('rejects an object without a callable has()', () => {
    assert.equal(isMembershipSet({}), false);
    assert.equal(isMembershipSet({ has: 7 }), false);
    assert.equal(isMembershipSet({ has: null }), false);
    assert.equal(isMembershipSet([]), false, 'an array has no .has');
  });
});
