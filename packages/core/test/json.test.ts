import { describe, expect, it } from 'vitest';
import { assertJsonSafe, canonicalJson, isJsonSafe } from '../src/json.js';
import { isAliveError } from '../src/errors.js';

class Widget {
  constructor(public a = 1) {}
}

describe('JSON-safe contract (INV-58)', () => {
  it('accepts primitives, arrays, nested objects and unicode', () => {
    expect(isJsonSafe({ a: [1, 'two', null, true, { b: '\u{1d11e}' }] })).toBe(true);
    expect(isJsonSafe(null)).toBe(true);
    expect(isJsonSafe([])).toBe(true);
  });

  it.each([
    ['undefined', { a: undefined }],
    ['NaN', { a: NaN }],
    ['Infinity', { a: Infinity }],
    ['-Infinity', { a: -Infinity }],
    ['BigInt', { a: 1n }],
    ['Date', { a: new Date() }],
    ['Map', { a: new Map() }],
    ['Set', { a: new Set() }],
    ['function', { a: () => 1 }],
    ['symbol', { a: Symbol('s') }],
    ['class instance', { a: new Widget() }],
  ])('rejects %s', (_label: string, value: unknown) => {
    expect(isJsonSafe(value)).toBe(false);
    try {
      assertJsonSafe(value, 'world');
      throw new Error('should have thrown');
    } catch (e) {
      expect(isAliveError(e, 'ALIVE_NON_JSON_VALUE')).toBe(true);
    }
  });

  it('rejects cycles', () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(isJsonSafe(a)).toBe(false);
  });

  it('reports a useful path', () => {
    try {
      assertJsonSafe({ outer: { list: [1, { bad: NaN }] } }, 'world');
      throw new Error('should have thrown');
    } catch (e) {
      expect(isAliveError(e, 'ALIVE_NON_JSON_VALUE')).toBe(true);
      expect((e as { details: { path: string } }).details.path).toBe('world.outer.list[1].bad');
    }
  });

  it('allows the same object twice when it is not a cycle', () => {
    const shared = { x: 1 };
    expect(isJsonSafe({ a: shared, b: shared })).toBe(true);
  });

  it('canonicalises key order deterministically', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: 2, b: 1 })).toBe(canonicalJson({ b: 1, a: 2 }));
  });

  it('canonicalises nested structures, unicode and -0', () => {
    expect(canonicalJson({ z: [{ d: 1, c: 2 }], a: '\u00e9' })).toBe(
      '{"a":"\u00e9","z":[{"c":2,"d":1}]}',
    );
    expect(canonicalJson({ n: -0 })).toBe('{"n":0}');
  });

  it('emits no whitespace', () => {
    expect(canonicalJson({ a: [1, 2], b: { c: 3 } })).not.toMatch(/\s/);
  });

  it('rejects sparse arrays instead of collapsing holes into JSON null/empty structure', () => {
    const sparse = Array(1);
    expect(isJsonSafe(sparse)).toBe(false);
    try {
      assertJsonSafe(sparse, 'payload');
      throw new Error('should have thrown');
    } catch (e) {
      expect(isAliveError(e, 'ALIVE_NON_JSON_VALUE')).toBe(true);
      expect((e as { details: { path: string } }).details.path).toBe('payload[0]');
    }
    expect(() => canonicalJson(sparse)).toThrowError(/ALIVE_NON_JSON_VALUE/);
  });

  it('rejects nested sparse arrays', () => {
    const nested = { a: [1, Array(2)] };
    expect(isJsonSafe(nested)).toBe(false);
    expect(() => assertJsonSafe(nested, 'world')).toThrowError(/world\.a\[1\]\[0\]/);
  });

});
