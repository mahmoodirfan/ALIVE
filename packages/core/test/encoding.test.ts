import { describe, expect, it } from 'vitest';
import { encodeTuple, encodeTupleHex, TUPLE_ENCODING_VERSION } from '../src/encoding.js';
import { isAliveError } from '../src/errors.js';

const hex = encodeTupleHex;

describe('canonical tuple encoding (INV-75)', () => {
  it('pins the wire format', () => {
    expect(TUPLE_ENCODING_VERSION).toBe(1);
    // version 0x01, count "1" 0x00, tag 's', len "5" 0x00, "hello"
    expect(hex([['s', 'hello']])).toBe('0131' + '00' + '73' + '35' + '00' + '68656c6c6f');
  });

  it('is unambiguous for components containing the old delimiter', () => {
    const a = hex([
      ['s', 'a\u001fb'],
      ['s', 'c'],
    ]);
    const b = hex([
      ['s', 'a'],
      ['s', 'b\u001fc'],
    ]);
    expect(a).not.toBe(b);
  });

  it('is unambiguous for NUL bytes, newlines and separators', () => {
    const pairs: [string, string][] = [
      ['a\u0000b', 'c'],
      ['a', '\u0000bc'],
      ['x\ny', 'z'],
      ['x', '\nyz'],
      ['p|q', 'r'],
      ['p', '|qr'],
    ];
    const encoded = pairs.map(([x, y]) =>
      hex([
        ['s', x],
        ['s', y],
      ]),
    );
    expect(new Set(encoded).size).toBe(encoded.length);
  });

  it('distinguishes absent from empty string', () => {
    expect(hex([['z', null]])).not.toBe(hex([['s', '']]));
  });

  it('distinguishes arity', () => {
    expect(hex([['s', 'ab']])).not.toBe(
      hex([
        ['s', 'a'],
        ['s', 'b'],
      ]),
    );
  });

  it('encodes unicode by UTF-8 bytes, including astral plane', () => {
    // "é" is 2 bytes, "𝄞" is 4 bytes — length prefix is in bytes, not UTF-16 units
    expect(hex([['s', '\u00e9']])).toBe('0131' + '00' + '73' + '32' + '00' + 'c3a9');
    expect(hex([['s', '\u{1d11e}']])).toBe('0131' + '00' + '73' + '34' + '00' + 'f09d849e');
  });

  it('does not unicode-normalise', () => {
    expect(hex([['s', '\u00e9']])).not.toBe(hex([['s', 'e\u0301']]));
  });

  it('pins integer encodings including 0, -0, negatives and MAX_SAFE_INTEGER', () => {
    expect(hex([['i', 0]])).toBe(hex([['i', -0]]));
    expect(hex([['i', 0]])).toBe('0131' + '00' + '69' + '31' + '00' + '30');
    expect(hex([['i', -7]])).toBe('0131' + '00' + '69' + '32' + '00' + '2d37');
    const maxHex = hex([['i', Number.MAX_SAFE_INTEGER]]);
    expect(maxHex).toContain(
      Buffer.from(String(Number.MAX_SAFE_INTEGER), 'utf8').toString('hex'),
    );
  });

  it('rejects non-integer numeric components', () => {
    for (const bad of [1.5, NaN, Infinity, -Infinity]) {
      expect(() => encodeTuple([['i', bad]])).toThrowError();
      try {
        encodeTuple([['i', bad]]);
      } catch (e) {
        expect(isAliveError(e, 'ALIVE_INVALID_TUPLE_COMPONENT')).toBe(true);
      }
    }
  });

  it('encodes booleans and nulls distinctly', () => {
    const all = [hex([['b', true]]), hex([['b', false]]), hex([['z', null]])];
    expect(new Set(all).size).toBe(3);
  });

  it('is byte-identical across repeated calls', () => {
    const c = [
      ['s', 'seed'],
      ['i', 3],
      ['z', null],
    ] as const;
    expect(Array.from(encodeTuple(c))).toEqual(Array.from(encodeTuple(c)));
  });

  it('rejects unpaired UTF-16 surrogates instead of TextEncoder replacement collisions', () => {
    for (const bad of ['\ud800', '\ud801', '\udfff']) {
      try {
        encodeTuple([['s', bad]]);
        throw new Error('should have thrown');
      } catch (e) {
        expect(isAliveError(e, 'ALIVE_INVALID_TUPLE_COMPONENT')).toBe(true);
      }
    }
    // The actual replacement character remains a valid, distinct Unicode scalar value.
    expect(() => encodeTuple([['s', '\ufffd']])).not.toThrow();
  });

  it('rejects unsafe integer tuple components', () => {
    for (const bad of [Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1]) {
      expect(() => encodeTuple([['i', bad]])).toThrowError(/safe integer/);
    }
  });

});
