/** INV-58: the JSON-safe data contract, its validator, snapshots and canonical serializer. */
import { AliveError } from './errors.js';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [k: string]: JsonValue };

function describe(v: unknown): string {
  if (v === undefined) return 'undefined';
  if (typeof v === 'bigint') return 'BigInt';
  if (typeof v === 'function') return 'function';
  if (typeof v === 'symbol') return 'symbol';
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return 'NaN';
    if (!Number.isFinite(v)) return v > 0 ? 'Infinity' : '-Infinity';
  }
  // Detecting a Date in order to REJECT it (INV-58). This is the opposite of a
  // wall-clock read and is the kernel's only reference to the global.
  // eslint-disable-next-line no-restricted-globals
  if (v instanceof Date) return 'Date instance';
  if (v instanceof Map) return 'Map';
  if (v instanceof Set) return 'Set';
  if (v !== null && typeof v === 'object') {
    const proto: unknown = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null && !Array.isArray(v)) return 'class instance';
  }
  return typeof v;
}

function fail(path: string, message: string): never {
  throw new AliveError('ALIVE_NON_JSON_VALUE', `${message} at ${path}`, { path });
}

/**
 * Deep-validates a value against the JSON-safe contract.
 *
 * Arrays must be dense. JSON.stringify silently turns sparse holes into null, which would
 * collapse distinct JavaScript values at persistence/identity boundaries. Plain objects
 * may only contain ordinary enumerable string-keyed data properties.
 */
export function assertJsonSafe(value: unknown, label = 'value'): asserts value is JsonValue {
  const ancestors = new Set<object>();

  const walk = (v: unknown, path: string): void => {
    if (v === null) return;
    const t = typeof v;
    if (t === 'string' || t === 'boolean') return;
    if (t === 'number') {
      if (!Number.isFinite(v as number)) fail(path, describe(v));
      return;
    }
    if (t !== 'object') fail(path, describe(v));

    const o = v as object;
    if (ancestors.has(o)) fail(path, 'cyclic reference');

    if (Array.isArray(o)) {
      ancestors.add(o);
      for (let i = 0; i < o.length; i += 1) {
        const desc = Object.getOwnPropertyDescriptor(o, String(i));
        if (!desc) {
          ancestors.delete(o);
          fail(`${path}[${i}]`, 'sparse array hole');
        }
        if (!desc.enumerable || !('value' in desc)) {
          ancestors.delete(o);
          fail(`${path}[${i}]`, 'non-data or non-enumerable array element');
        }
        walk(desc.value, `${path}[${i}]`);
      }
      // Arrays with extra string/symbol properties are not plain JSON arrays.
      for (const key of Reflect.ownKeys(o)) {
        if (key === 'length') continue;
        if (typeof key === 'symbol') {
          ancestors.delete(o);
          fail(path, 'symbol-keyed array property');
        }
        if (/^(0|[1-9]\d*)$/.test(key)) continue;
        ancestors.delete(o);
        fail(`${path}.${key}`, 'extra array property');
      }
      ancestors.delete(o);
      return;
    }

    const proto: unknown = Object.getPrototypeOf(o);
    if (proto !== Object.prototype && proto !== null) fail(path, describe(v));

    ancestors.add(o);
    for (const key of Reflect.ownKeys(o)) {
      if (typeof key === 'symbol') {
        ancestors.delete(o);
        fail(path, 'symbol-keyed object property');
      }
      const desc = Object.getOwnPropertyDescriptor(o, key);
      if (!desc) continue;
      if (!desc.enumerable || !('value' in desc)) {
        ancestors.delete(o);
        fail(`${path}.${key}`, 'non-data or non-enumerable property');
      }
      if (desc.value === undefined) {
        ancestors.delete(o);
        fail(`${path}.${key}`, 'undefined');
      }
      walk(desc.value, `${path}.${key}`);
    }
    ancestors.delete(o);
  };

  walk(value, label);
}

export function isJsonSafe(value: unknown): value is JsonValue {
  try {
    assertJsonSafe(value);
    return true;
  } catch {
    return false;
  }
}

function cloneJson(v: JsonValue): JsonValue {
  if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    return v;
  }
  if (Array.isArray(v)) return v.map((item) => cloneJson(item));
  const out: { [k: string]: JsonValue } = {};
  for (const key of Object.keys(v)) out[key] = cloneJson(v[key] as JsonValue);
  return out;
}

function deepFreezeJson<T extends JsonValue>(value: T): T {
  if (value !== null && typeof value === 'object') {
    if (Array.isArray(value)) {
      for (const item of value) deepFreezeJson(item);
    } else {
      for (const item of Object.values(value)) deepFreezeJson(item);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Persistence-boundary helper: validate, detach from caller-owned references, then freeze.
 * Preserves all supported JSON number semantics, including -0.
 */
export function snapshotJson<T>(value: T, label = 'value'): T {
  assertJsonSafe(value, label);
  return deepFreezeJson(cloneJson(value as JsonValue)) as T;
}

/**
 * Canonical JSON: object keys sorted by UTF-16 code unit, no whitespace,
 * non-JSON values rejected. Used as a single tuple component (INV-75).
 */
export function canonicalJson(value: unknown): string {
  assertJsonSafe(value, 'payload');
  const emit = (v: JsonValue): string => {
    if (v === null) return 'null';
    if (typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'number') return Object.is(v, -0) ? '0' : String(v);
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (Array.isArray(v)) return `[${v.map(emit).join(',')}]`;
    const keys = Object.keys(v).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${emit(v[k] as JsonValue)}`).join(',')}}`;
  };
  return emit(value as JsonValue);
}
