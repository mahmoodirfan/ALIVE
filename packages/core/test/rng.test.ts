import { describe, expect, it } from 'vitest';
import { createRandomApi, rngFloat, rngUint64Hex, RNG_ALGORITHM, RNG_VERSION } from '../src/rng.js';
import { fnv1a64, splitmix64, toFloat53, hashHex } from '../src/hash.js';

const KEY = {
  seed: 'northstar-001',
  subject: 'cust-7',
  cause: 'evt:abc',
  purpose: 'purchase-decision',
  draw: 0,
};

describe('keyed RNG (INV-31/32/36)', () => {
  it('pins the algorithm identity', () => {
    expect(RNG_ALGORITHM).toBe('alive-splitmix64-fnv1a');
    expect(RNG_VERSION).toBe(1);
  });

  it('pins golden vectors', () => {
    expect(rngFloat(KEY)).toBe(0.13749245369220742);
    expect(rngFloat({ ...KEY, draw: 1 })).toBe(0.042420121693295676);
    expect(rngUint64Hex(KEY)).toBe('2332b4980e090ca3');
    expect(hashHex([['s', 'hello']])).toBe('17da3b069105a304');
  });

  it('pins unicode and empty-component vectors', () => {
    expect(rngFloat({ ...KEY, subject: '' })).toBe(0.43427475361722023);
    expect(rngFloat({ ...KEY, subject: '\u{1d11e}\u00e9' })).toBe(0.6476887689307127);
  });

  it('pins the RandomApi surface', () => {
    const r = createRandomApi({ seed: 's1', subject: 'a', cause: 'c' });
    expect(r.float('p')).toBe(0.7161990555824885);
    expect(r.int('p', 1, 4)).toBe(3);
    expect(r.pick('p', ['w', 'x', 'y', 'z'])).toBe('y');
    expect(r.chance(0.5, 'p')).toBe(false);
    expect(r.exponential('p', 1000)).toBe(1259.4821865044678);
  });

  it('is a pure function of the key — repeated calls never advance', () => {
    const r = createRandomApi({ seed: 's', subject: 'a', cause: 'c' });
    const first = r.float('same-purpose');
    for (let i = 0; i < 100; i++) r.float('noise');
    expect(r.float('same-purpose')).toBe(first);
  });

  it('separates draws, purposes, subjects, causes and seeds', () => {
    const vals = new Set([
      rngFloat(KEY),
      rngFloat({ ...KEY, draw: 1 }),
      rngFloat({ ...KEY, purpose: 'other' }),
      rngFloat({ ...KEY, subject: 'cust-8' }),
      rngFloat({ ...KEY, cause: 'evt:def' }),
      rngFloat({ ...KEY, seed: 'other-seed' }),
    ]);
    expect(vals.size).toBe(6);
  });

  it('never collides across delimiter-shifted keys', () => {
    const a = rngFloat({ ...KEY, subject: 'a', cause: 'b' });
    const b = rngFloat({ ...KEY, subject: 'a\u001fb', cause: '' });
    expect(a).not.toBe(b);
  });

  it('produces floats strictly within [0,1)', () => {
    for (let i = 0; i < 2000; i++) {
      const v = rngFloat({ ...KEY, draw: i });
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('int() stays in range and covers it', () => {
    const r = createRandomApi({ seed: 's', subject: 'a', cause: 'c' });
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) {
      const v = r.int('q', 1, 4, i);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(4);
      seen.add(v);
    }
    expect(seen.size).toBe(4);
  });

  it('chance() honours degenerate probabilities without drawing', () => {
    const r = createRandomApi({ seed: 's', subject: 'a', cause: 'c' });
    expect(r.chance(0, 'p')).toBe(false);
    expect(r.chance(1, 'p')).toBe(true);
  });

  it('chance() is approximately calibrated', () => {
    const r = createRandomApi({ seed: 's', subject: 'a', cause: 'c' });
    let hits = 0;
    for (let i = 0; i < 4000; i++) if (r.chance(0.25, 'p', i)) hits++;
    expect(hits / 4000).toBeGreaterThan(0.21);
    expect(hits / 4000).toBeLessThan(0.29);
  });

  it('for() overrides subject and cause without touching seed', () => {
    const r = createRandomApi({ seed: 's', subject: 'a', cause: 'c' });
    expect(r.for({ subject: 'b' }).float('p')).toBe(
      rngFloat({ seed: 's', subject: 'b', cause: 'c', purpose: 'p', draw: 0 }),
    );
  });

  it('rejects invalid arguments', () => {
    const r = createRandomApi({ seed: 's', subject: 'a', cause: 'c' });
    expect(() => r.int('p', 4, 1)).toThrow(RangeError);
    expect(() => r.int('p', 1.5, 4)).toThrow(RangeError);
    expect(() => r.pick('p', [])).toThrow(RangeError);
    expect(() => r.exponential('p', 0)).toThrow(RangeError);
  });

  it('pins the primitive building blocks', () => {
    expect(fnv1a64(new Uint8Array([]))).toBe(14695981039346656037n);
    expect(splitmix64(0n)).toBe(16294208416658607535n);
    expect(toFloat53(0n)).toBe(0);
    expect(toFloat53((1n << 64n) - 1n)).toBeLessThan(1);
  });

  it('keeps BigInt out of its public surface (INV-33)', () => {
    const r = createRandomApi({ seed: 's', subject: 'a', cause: 'c' });
    expect(typeof r.float('p')).toBe('number');
    expect(typeof r.int('p', 0, 9)).toBe('number');
    expect(typeof rngUint64Hex(KEY)).toBe('string');
  });
});
