import { AliveIntegrationError } from './errors.js';
import type { AliveApiContract, EffectRule, ResourceKey, RouteDef } from './types.js';

function freezeResourceKey(key: ResourceKey, label: string): ResourceKey {
  if (!Array.isArray(key) || key.length === 0 || key.some((part) => typeof part !== 'string')) {
    throw new AliveIntegrationError('ALIVE_INVALID_API_CONTRACT', `${label} must be a non-empty string array`);
  }
  return Object.freeze([...key]);
}

function freezeRoute<W>(route: RouteDef<W>): RouteDef<W> {
  if (!route.path.startsWith('/')) {
    throw new AliveIntegrationError('ALIVE_INVALID_API_CONTRACT', `route path must start with '/': ${route.path}`);
  }
  const status = route.successStatus ?? 200;
  if (!Number.isInteger(status) || status < 200 || status > 299 || status === 204 || status === 205) {
    throw new AliveIntegrationError(
      'ALIVE_INVALID_API_CONTRACT',
      `route successStatus must be a JSON-body 2xx status (not 204/205): ${route.method} ${route.path}`,
    );
  }
  return Object.freeze({ ...route });
}

function freezeEffect(rule: EffectRule): EffectRule {
  if (typeof rule.when !== 'string' && typeof rule.when !== 'function') {
    throw new AliveIntegrationError('ALIVE_INVALID_API_CONTRACT', 'effect.when must be an event type or predicate');
  }
  return Object.freeze({ ...rule });
}

export function defineAliveApi<W>(contract: AliveApiContract<W>): AliveApiContract<W> {
  const seen = new Set<string>();
  const routes = contract.routes.map((route) => {
    const frozen = freezeRoute(route);
    const identity = `${frozen.method} ${frozen.path}`;
    if (seen.has(identity)) {
      throw new AliveIntegrationError('ALIVE_INVALID_API_CONTRACT', `duplicate API route: ${identity}`);
    }
    seen.add(identity);
    return frozen;
  });
  const effects = contract.effects.map(freezeEffect);
  return Object.freeze({ routes: Object.freeze(routes), effects: Object.freeze(effects) });
}

export function resourceKey(...parts: string[]): ResourceKey {
  return freezeResourceKey(parts, 'resource key');
}
