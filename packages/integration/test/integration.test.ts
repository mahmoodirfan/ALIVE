import { describe, expect, it, vi } from 'vitest';
import {
  AliveError,
  type AliveEvent,
  type CommitNotification,
  type DispatchResult,
  type TimelineChangeNotification,
} from '@alive-internal/core';
import {
  bindAliveQueryInvalidation,
  defineAliveApi,
  executeAliveRoute,
  invalidationsForEvents,
  resourceKey,
  type AliveNotificationSource,
  type QueryClientLike,
} from '../src/index.js';

interface World {
  products: Record<string, { stock: number }>;
  orders: string[];
}

function event(type: string, payload: Record<string, unknown> = {}): AliveEvent {
  return Object.freeze({
    id: `evt:${type}`,
    type,
    commitId: 'commit:1',
    virtualTime: 100,
    withinCommitOrder: 0,
    depth: 0,
    causeId: 'cause:1',
    payload,
  }) as AliveEvent;
}

function contract() {
  return defineAliveApi<World>({
    routes: [
      {
        method: 'GET',
        path: '/api/products/:id',
        resolve: ({ state, params }) => state.products[params.id ?? ''] ?? null,
      },
      {
        method: 'POST',
        path: '/api/products/:id/restock',
        command: ({ params, body }) => ({
          type: 'product.restock',
          payload: { id: params.id ?? '', quantity: (body as { quantity: number }).quantity },
        }),
        resolve: ({ state, params }) => state.products[params.id ?? ''] ?? null,
      },
    ],
    effects: [
      {
        when: 'order.created',
        invalidate: (e) => [resourceKey('orders'), resourceKey('product', String((e.payload as { productId: string }).productId))],
      },
      {
        when: (e) => e.type === 'inventory.changed',
        invalidate: (e) => [resourceKey('product', String((e.payload as { productId: string }).productId))],
      },
    ],
  });
}

describe('API contract and route execution', () => {
  it('rejects duplicate method/path pairs', () => {
    expect(() => defineAliveApi<World>({
      routes: [
        { method: 'GET', path: '/api/x', resolve: () => null },
        { method: 'GET', path: '/api/x', resolve: () => null },
      ],
      effects: [],
    })).toThrow(/duplicate API route/);
  });

  it('serves GET projections from the simulation view state', () => {
    const simulation = {
      getState: () => ({ products: { lamp: { stock: 3 } }, orders: [] }),
      dispatch: vi.fn(),
    };
    const route = contract().routes[0]!;
    const out = executeAliveRoute(simulation, route, { params: { id: 'lamp' } });
    expect(out).toEqual({ status: 200, body: { stock: 3 } });
  });

  it('dispatches a mutation and resolves its response from post-command state', () => {
    const world: World = { products: { lamp: { stock: 3 } }, orders: [] };
    const simulation = {
      getState: () => world,
      dispatch: vi.fn((): DispatchResult => {
        world.products.lamp!.stock += 8;
        return { accepted: true, commandId: 'cmd:1', commitId: 'commit:1', emitted: ['evt:1'] };
      }),
    };
    const route = contract().routes[1]!;
    const out = executeAliveRoute(simulation, route, {
      params: { id: 'lamp' },
      body: { quantity: 8 },
    });
    expect(simulation.dispatch).toHaveBeenCalledWith({
      type: 'product.restock',
      payload: { id: 'lamp', quantity: 8 },
    });
    expect(out).toEqual({ status: 200, body: { stock: 11 } });
  });

  it('maps historical-view mutations to 409 with a fork hint', () => {
    const simulation = {
      getState: () => ({ products: {}, orders: [] }),
      dispatch: () => {
        throw new AliveError('ALIVE_HISTORICAL_VIEW', 'cannot modify a historical view');
      },
    };
    const out = executeAliveRoute(simulation, contract().routes[1]!, {
      params: { id: 'lamp' },
      body: { quantity: 8 },
    });
    expect(out.status).toBe(409);
    expect(out.body).toMatchObject({ code: 'ALIVE_HISTORICAL_VIEW', hint: expect.stringContaining('Fork') });
  });

  it('maps command rejections to stable HTTP statuses', () => {
    const route = contract().routes[1]!;
    const make = (rejection: DispatchResult['rejection']) => executeAliveRoute(
      {
        getState: () => ({ products: {}, orders: [] }),
        dispatch: () => ({ accepted: false, rejection }),
      },
      route,
      { params: { id: 'lamp' }, body: { quantity: 8 } },
    );
    expect(make({ code: 'ALIVE_UNKNOWN_COMMAND', message: 'unknown' }).status).toBe(404);
    expect(make({ code: 'ALIVE_INVALID_COMMAND', message: 'invalid' }).status).toBe(400);
    expect(make({ code: 'ALIVE_PRECONDITION_FAILED', message: 'no stock' }).status).toBe(422);
  });
});

describe('effect rules', () => {
  it('deduplicates static and dynamic invalidations from a commit', () => {
    const keys = invalidationsForEvents(contract(), [
      event('order.created', { productId: 'lamp' }),
      event('inventory.changed', { productId: 'lamp' }),
    ]);
    expect(keys).toEqual([
      ['orders'],
      ['product', 'lamp'],
    ]);
  });
});

class FakeSource implements AliveNotificationSource {
  private commits: ((n: CommitNotification) => void)[] = [];
  private timelines: ((n: TimelineChangeNotification) => void)[] = [];

  on(channel: 'committed' | 'timeline:changed', fn: ((n: CommitNotification) => void) | ((n: TimelineChangeNotification) => void)) {
    if (channel === 'committed') {
      const typed = fn as (n: CommitNotification) => void;
      this.commits.push(typed);
      return () => { this.commits = this.commits.filter((x) => x !== typed); };
    }
    const typed = fn as (n: TimelineChangeNotification) => void;
    this.timelines.push(typed);
    return () => { this.timelines = this.timelines.filter((x) => x !== typed); };
  }

  commit(events: readonly AliveEvent[]): void {
    const n: CommitNotification = { commitId: 'commit:1', branchId: 'branch:root', virtualTime: 100, events };
    for (const fn of [...this.commits]) fn(n);
  }

  timeline(): void {
    const n: TimelineChangeNotification = {
      reason: 'branch-switch', branchId: 'branch:root', cursor: null, invalidateAll: true,
    };
    for (const fn of [...this.timelines]) fn(n);
  }
}

async function microtask(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('query invalidation binding', () => {
  it('coalesces targeted invalidations across the kernel notification flush', async () => {
    const source = new FakeSource();
    const calls: unknown[] = [];
    const client: QueryClientLike = {
      invalidateQueries(filters) {
        calls.push(filters);
      },
    };
    const binding = bindAliveQueryInvalidation(source, client, contract());
    source.commit([event('order.created', { productId: 'lamp' })]);
    source.commit([event('inventory.changed', { productId: 'lamp' })]);
    expect(calls).toEqual([]);
    expect(binding.pending()).toBe(2);
    await microtask();
    expect(calls).toEqual([
      { queryKey: ['orders'], exact: false },
      { queryKey: ['product', 'lamp'], exact: false },
    ]);
    binding.dispose();
  });

  it('turns a timeline change into one full invalidation and supersedes targeted work', async () => {
    const source = new FakeSource();
    const calls: unknown[] = [];
    const client: QueryClientLike = { invalidateQueries(filters) { calls.push(filters); } };
    bindAliveQueryInvalidation(source, client, contract());
    source.commit([event('order.created', { productId: 'lamp' })]);
    source.timeline();
    await microtask();
    expect(calls).toEqual([undefined]);
  });


  it('collapses descendant query keys when prefix invalidation already covers them', async () => {
    const source = new FakeSource();
    const calls: unknown[] = [];
    const client: QueryClientLike = { invalidateQueries(filters) { calls.push(filters); } };
    const c = defineAliveApi<World>({
      routes: [],
      effects: [{
        when: 'inventory.changed',
        invalidate: () => [resourceKey('products'), resourceKey('products', 'lamp')],
      }],
    });
    bindAliveQueryInvalidation(source, client, c);
    source.commit([event('inventory.changed', { productId: 'lamp' })]);
    await microtask();
    expect(calls).toEqual([{ queryKey: ['products'], exact: false }]);
  });

  it('can scope timeline-wide invalidation to an ALIVE query prefix', async () => {
    const source = new FakeSource();
    const calls: unknown[] = [];
    const client: QueryClientLike = { invalidateQueries(filters) { calls.push(filters); } };
    bindAliveQueryInvalidation(source, client, contract(), { timelineQueryKey: ['alive'] });
    source.timeline();
    await microtask();
    expect(calls).toEqual([{ queryKey: ['alive'], exact: false }]);
  });

  it('does no work after disposal, including already queued microtasks', async () => {
    const source = new FakeSource();
    const calls: unknown[] = [];
    const client: QueryClientLike = { invalidateQueries(filters) { calls.push(filters); } };
    const binding = bindAliveQueryInvalidation(source, client, contract());
    source.commit([event('order.created', { productId: 'lamp' })]);
    binding.dispose();
    await microtask();
    expect(calls).toEqual([]);
  });

  it('contains sync and async QueryClient errors instead of throwing into the simulation', async () => {
    const source = new FakeSource();
    const errors: unknown[] = [];
    let call = 0;
    const client: QueryClientLike = {
      invalidateQueries() {
        call += 1;
        if (call === 1) throw new Error('sync');
        return Promise.reject(new Error('async'));
      },
    };
    bindAliveQueryInvalidation(source, client, contract(), { onError: (error) => errors.push(error) });
    source.commit([event('order.created', { productId: 'lamp' })]);
    await microtask();
    await microtask();
    expect(errors).toHaveLength(2);
  });
});
