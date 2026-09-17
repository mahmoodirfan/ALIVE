/**
 * FNV-1a 64 and SplitMix64. INV-33: BigInt is confined to this module and the RNG;
 * nothing here leaks a BigInt into world state, patches or replay JSON.
 */
import { encodeTuple, type TupleComponent } from './encoding.js';

const MASK = (1n << 64n) - 1n;
const FNV_OFFSET = 14695981039346656037n;
const FNV_PRIME = 1099511628211n;

export function fnv1a64(bytes: Uint8Array): bigint {
  let h = FNV_OFFSET;
  for (let i = 0; i < bytes.length; i++) {
    h ^= BigInt(bytes[i] as number);
    h = (h * FNV_PRIME) & MASK;
  }
  return h;
}

export function splitmix64(x: bigint): bigint {
  let z = (x + 0x9e3779b97f4a7c15n) & MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK;
  return (z ^ (z >> 31n)) & MASK;
}

/** Three SplitMix64 rounds over the FNV-1a digest of the canonical encoding. */
export function digest64(components: readonly TupleComponent[]): bigint {
  return splitmix64(splitmix64(splitmix64(fnv1a64(encodeTuple(components)))));
}

export function toHex64(u: bigint): string {
  return u.toString(16).padStart(16, '0');
}

/** Canonical 16-hex-char digest of a tuple. */
export function hashHex(components: readonly TupleComponent[]): string {
  return toHex64(digest64(components));
}

/** Uniform [0,1) from the top 53 bits. */
export function toFloat53(u: bigint): number {
  return Number(u >> 11n) / 9007199254740992;
}
