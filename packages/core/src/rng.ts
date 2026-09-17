/**
 * INV-31/32: keyed, stateless RNG. No stream, no cursor, no mutable state.
 * `branchId` is never an input (INV-32).
 */
import { digest64, toFloat53 } from './hash.js';
import type { TupleComponent } from './encoding.js';

export const RNG_ALGORITHM = 'alive-splitmix64-fnv1a';
export const RNG_VERSION = 1;

export interface RngKey {
  readonly seed: string;
  readonly subject: string;
  readonly cause: string;
  readonly purpose: string;
  readonly draw: number;
}

export function rngComponents(key: RngKey): readonly TupleComponent[] {
  if (!Number.isSafeInteger(key.draw) || key.draw < 0) {
    throw new RangeError(`RNG draw must be a non-negative safe integer: ${String(key.draw)}`);
  }
  return [
    ['s', key.seed],
    ['s', key.subject],
    ['s', key.cause],
    ['s', key.purpose],
    ['i', key.draw],
  ];
}

export function rngFloat(key: RngKey): number {
  return toFloat53(digest64(rngComponents(key)));
}

export function rngUint64Hex(key: RngKey): string {
  return digest64(rngComponents(key)).toString(16).padStart(16, '0');
}

export interface RandomApi {
  float(purpose: string, draw?: number): number;
  chance(probability: number, purpose: string, draw?: number): boolean;
  int(purpose: string, min: number, max: number, draw?: number): number;
  pick<T>(purpose: string, items: readonly T[], draw?: number): T;
  exponential(purpose: string, mean: number, draw?: number): number;
  for(overrides: { subject?: string; cause?: string }): RandomApi;
}

export interface RandomContext {
  readonly seed: string;
  readonly subject: string;
  readonly cause: string;
}

export function createRandomApi(ctx: RandomContext): RandomApi {
  const key = (purpose: string, draw: number): RngKey => ({
    seed: ctx.seed,
    subject: ctx.subject,
    cause: ctx.cause,
    purpose,
    draw,
  });
  return {
    float(purpose, draw = 0) {
      return rngFloat(key(purpose, draw));
    },
    chance(probability, purpose, draw = 0) {
      if (probability <= 0) return false;
      if (probability >= 1) return true;
      return rngFloat(key(purpose, draw)) < probability;
    },
    int(purpose, min, max, draw = 0) {
      if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max < min) {
        throw new RangeError(`int("${purpose}") requires safe integers with max >= min`);
      }
      const span = max - min + 1;
      if (!Number.isSafeInteger(span) || span < 1) {
        throw new RangeError(`int("${purpose}") range is too large`);
      }
      return min + Math.floor(rngFloat(key(purpose, draw)) * span);
    },
    pick(purpose, items, draw = 0) {
      if (items.length === 0) throw new RangeError(`pick("${purpose}") on an empty list`);
      const i = Math.floor(rngFloat(key(purpose, draw)) * items.length);
      return items[Math.min(i, items.length - 1)] as (typeof items)[number];
    },
    exponential(purpose, mean, draw = 0) {
      if (!(mean > 0)) throw new RangeError(`exponential("${purpose}") requires mean > 0`);
      const u = rngFloat(key(purpose, draw));
      return -mean * Math.log(1 - u);
    },
    for(overrides) {
      return createRandomApi({
        seed: ctx.seed,
        subject: overrides.subject ?? ctx.subject,
        cause: overrides.cause ?? ctx.cause,
      });
    },
  };
}
