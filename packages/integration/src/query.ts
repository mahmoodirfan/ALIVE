import type { AliveApiContract, AliveNotificationSource, QueryBindingHandle, QueryBindingOptions, QueryClientLike, ResourceKey } from './types.js';
import { invalidationsForEvents } from './effects.js';

function token(key: ResourceKey): string {
  return JSON.stringify(key);
}

function isPrefix(a: ResourceKey, b: ResourceKey): boolean {
  return a.length <= b.length && a.every((part, index) => part === b[index]);
}

function minimize(keys: readonly ResourceKey[], exact: boolean): readonly ResourceKey[] {
  if (exact) return keys;
  return keys.filter((key, index) => !keys.some((other, otherIndex) => otherIndex !== index && isPrefix(other, key)));
}

export function bindAliveQueryInvalidation<W>(
  alive: AliveNotificationSource,
  queryClient: QueryClientLike,
  contract: AliveApiContract<W>,
  options: QueryBindingOptions = {},
): QueryBindingHandle {
  const pendingKeys = new Map<string, ResourceKey>();
  let full = false;
  let queued = false;
  let disposed = false;

  const report = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      // Adapter error reporting must never escape back into the simulation.
    }
  };

  const invalidate = (key?: ResourceKey): void => {
    try {
      const value = key
        ? queryClient.invalidateQueries({ queryKey: key, exact: options.exact ?? false })
        : queryClient.invalidateQueries();
      void Promise.resolve(value).catch(report);
    } catch (error) {
      report(error);
    }
  };

  const flush = (): void => {
    queued = false;
    if (disposed) {
      pendingKeys.clear();
      full = false;
      return;
    }
    if (full) {
      pendingKeys.clear();
      full = false;
      const scope = options.timelineQueryKey;
      if (scope) {
        try {
          const value = queryClient.invalidateQueries({ queryKey: scope, exact: false });
          void Promise.resolve(value).catch(report);
        } catch (error) {
          report(error);
        }
      } else {
        invalidate();
      }
      return;
    }
    const keys = minimize([...pendingKeys.values()], options.exact ?? false);
    pendingKeys.clear();
    for (const key of keys) invalidate(key);
  };

  const schedule = (): void => {
    if (queued || disposed) return;
    queued = true;
    queueMicrotask(flush);
  };

  const offCommit = alive.on('committed', (notification) => {
    if (disposed || full) return;
    try {
      for (const key of invalidationsForEvents(contract, notification.events)) {
        pendingKeys.set(token(key), key);
      }
      if (pendingKeys.size > 0) schedule();
    } catch (error) {
      report(error);
    }
  });

  const offTimeline = alive.on('timeline:changed', (notification) => {
    if (disposed || !notification.invalidateAll) return;
    full = true;
    pendingKeys.clear();
    schedule();
  });

  return Object.freeze({
    dispose(): void {
      if (disposed) return;
      disposed = true;
      pendingKeys.clear();
      full = false;
      offCommit();
      offTimeline();
    },
    pending(): number {
      return full ? 1 : pendingKeys.size;
    },
  });
}
