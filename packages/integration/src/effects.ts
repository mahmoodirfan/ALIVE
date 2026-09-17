import type { AliveEvent } from '@alive-internal/core';
import type { AliveApiContract, ResourceKey } from './types.js';

function matches(when: AliveApiContract<unknown>['effects'][number]['when'], event: AliveEvent): boolean {
  return typeof when === 'string' ? event.type === when : when(event);
}

function keyToken(key: ResourceKey): string {
  // Resource keys are strings only, so JSON is an unambiguous deterministic dedupe token.
  return JSON.stringify(key);
}

export function invalidationsForEvents<W>(
  contract: AliveApiContract<W>,
  events: readonly AliveEvent[],
): readonly ResourceKey[] {
  const keys = new Map<string, ResourceKey>();
  for (const event of events) {
    for (const effect of contract.effects) {
      if (!matches(effect.when, event)) continue;
      for (const key of effect.invalidate(event)) {
        if (!Array.isArray(key) || key.length === 0 || key.some((part) => typeof part !== 'string')) {
          throw new TypeError(`effect invalidation for ${event.type} returned an invalid resource key`);
        }
        const frozen = Object.freeze([...key]);
        keys.set(keyToken(frozen), frozen);
      }
    }
  }
  return Object.freeze([...keys.values()]);
}
