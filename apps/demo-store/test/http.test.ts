import { describe, expect, it } from 'vitest';
import { http, HttpResponse, type HttpHandler } from 'msw';
import { setupServer } from 'msw/node';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { createSimulation } from '@alive-internal/core';
import { bindAliveQueryInvalidation } from '@alive-internal/integration';
import { createAliveHandlers, type AliveMswRuntime } from '@alive-internal/msw';
import { launchApi } from '../src/scenario/api.js';
import { createProductLaunchScenario } from '../src/scenario/productLaunch.js';
import { ARC_LAMP_ID, HERO_FORK_TIME, HERO_HORIZON, MINUTE } from '../src/scenario/constants.js';
import type { Product } from '../src/scenario/types.js';

describe('real MSW HTTP boundary', () => {
  it('refreshes subscribed HTTP queries, protects history, and compares a retained restocked future', async () => {
    const sim = createSimulation({ scenario: createProductLaunchScenario(), seed: 'northstar-launch-demo-v1' });
    // Node has no browser origin: qualify the same application routes for this test.
    const origin = 'http://alive.test';
    const runtime: AliveMswRuntime<HttpHandler> = {
      http: {
        get: (path, resolver) => http.get(origin + path, resolver),
        post: (path, resolver) => http.post(origin + path, resolver),
        patch: (path, resolver) => http.patch(origin + path, resolver),
        delete: (path, resolver) => http.delete(origin + path, resolver),
      },
      HttpResponse,
    };
    const server = setupServer(...createAliveHandlers(runtime, sim, launchApi));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const binding = bindAliveQueryInvalidation(sim, client, launchApi, { timelineQueryKey: ['alive'] });
    const observer = new QueryObserver<Product[]>(client, {
      queryKey: ['alive', 'products'],
      queryFn: async () => {
        const response = await fetch(`${origin}/api/products`);
        expect(response.status).toBe(200);
        return response.json() as Promise<Product[]>;
      },
    });
    server.listen({ onUnhandledRequest: 'error' });
    const unsubscribe = observer.subscribe(() => {});
    const stock = () => observer.getCurrentResult().data?.find((product) => product.id === ARC_LAMP_ID)?.stock;
    const restock = () => fetch(`${origin}/api/products/${ARC_LAMP_ID}/restock`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ quantity: 8 }),
    });
    try {
      await expect.poll(stock).toBe(5);
      sim.runUntil(6 * MINUTE);
      await expect.poll(stock).toBe(4);
      sim.runUntil(HERO_HORIZON);
      await expect.poll(stock).toBe(0);
      const baselineEvents = sim.getEvents();
      expect(baselineEvents.find((event) => event.type === 'inventory.stockout' && event.entityId === ARC_LAMP_ID)?.virtualTime).toBe(132 * MINUTE);
      const overview = await (await fetch(`${origin}/api/overview`)).json() as { metrics: { lostOrders: number } };
      expect(overview.metrics.lostOrders).toBe(2);

      sim.enterScrub({ time: HERO_FORK_TIME });
      await expect.poll(stock).toBe(2);
      const rejected = await restock();
      expect(rejected.status).toBe(409);
      expect(await rejected.json()).toMatchObject({ code: 'ALIVE_HISTORICAL_VIEW' });
      expect(stock()).toBe(2);
      expect(sim.getHeadTime()).toBe(HERO_HORIZON);
      expect(sim.getEvents()).toEqual(baselineEvents);

      const fork = sim.forkAt({ time: HERO_FORK_TIME }, { name: 'HTTP restock at 10:30' });
      const accepted = await restock();
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toMatchObject({ id: ARC_LAMP_ID, stock: 10 });
      await expect.poll(stock).toBe(10);
      sim.runUntil(HERO_HORIZON);
      await expect.poll(stock).toBe(6);
      const alternative = await (await fetch(`${origin}/api/overview`)).json() as { metrics: { lostOrders: number } };
      expect(alternative.metrics.lostOrders).toBe(0);
      const report = sim.compareBranches('branch:root', fork.id, { until: 'scenario-end' });
      expect(report.causalLanguagePermitted).toBe(true);
      expect(report.causalEventKey).toBe('arcStockout');
      expect(report.eventFindings.find((finding) => finding.key === 'arcStockout')?.b.status).toBe('not-before-horizon');
      sim.switchBranch('branch:root');
      await expect.poll(stock).toBe(0);
      expect(sim.getEvents()).toEqual(baselineEvents);
    } finally {
      unsubscribe();
      observer.destroy();
      binding.dispose();
      client.clear();
      server.close();
      sim.dispose();
    }
  });
});
