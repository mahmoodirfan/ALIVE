/**
 * INV-75: the one canonical tuple encoder. Every hash input in ALIVE goes through
 * this. Delimiter-joined strings are forbidden: length prefixing is what makes the
 * encoding unambiguous for components containing separators, NUL bytes or newlines.
 */
import { AliveError } from './errors.js';

export const TUPLE_ENCODING_VERSION = 1;

export type TupleComponent =
  | readonly ['s', string]
  | readonly ['i', number]
  | readonly ['b', boolean]
  | readonly ['z', null];

const enc = new TextEncoder();

function isWellFormedUtf16(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const u = value.charCodeAt(i);
    if (u >= 0xd800 && u <= 0xdbff) {
      if (i + 1 >= value.length) return false;
      const next = value.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      i += 1;
      continue;
    }
    if (u >= 0xdc00 && u <= 0xdfff) return false;
  }
  return true;
}

function payloadBytes(c: TupleComponent): Uint8Array {
  switch (c[0]) {
    case 's':
      if (typeof c[1] !== 'string') {
        throw new AliveError('ALIVE_INVALID_TUPLE_COMPONENT', 'expected string component');
      }
      if (!isWellFormedUtf16(c[1])) {
        throw new AliveError(
          'ALIVE_INVALID_TUPLE_COMPONENT',
          'string component contains an unpaired UTF-16 surrogate',
        );
      }
      return enc.encode(c[1]);
    case 'i': {
      const n = c[1];
      if (!Number.isSafeInteger(n)) {
        throw new AliveError('ALIVE_INVALID_TUPLE_COMPONENT', `not a safe integer: ${String(n)}`);
      }
      return enc.encode(Object.is(n, -0) ? '0' : String(n));
    }
    case 'b':
      return enc.encode(c[1] ? 'true' : 'false');
    case 'z':
      return new Uint8Array(0);
  }
}

/** Encode a tuple to its canonical byte sequence. */
export function encodeTuple(components: readonly TupleComponent[]): Uint8Array {
  const parts: Uint8Array[] = [];
  parts.push(new Uint8Array([TUPLE_ENCODING_VERSION]));
  parts.push(enc.encode(String(components.length)));
  parts.push(new Uint8Array([0]));
  for (const c of components) {
    const body = payloadBytes(c);
    parts.push(enc.encode(c[0]));
    parts.push(enc.encode(String(body.length)));
    parts.push(new Uint8Array([0]));
    parts.push(body);
  }
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Debug helper: the encoding rendered as hex. Not used in hashing. */
export function encodeTupleHex(components: readonly TupleComponent[]): string {
  return Array.from(encodeTuple(components))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
