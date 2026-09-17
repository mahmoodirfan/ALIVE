import { describe, expect, it } from 'vitest';
import { createSimulation } from '@alive-internal/core';
import { executeAliveRoute } from '@alive-internal/integration';
import { launchApi } from '../src/scenario/api.js';
import { ARC_LAMP_ID, HERO_FORK_TIME, HERO_HORIZON, HERO_RESTOCK_QUANTITY, MINUTE } from '../src/scenario/constants.js';
import { createProductLaunchScenario } from '../src/scenario/productLaunch.js';

function build() {
  return createSimulation({ scenario: createProductLaunchScenario(), seed: 'northstar-launch-demo-v1', checkpointEvery: 4 });
}

describe('Northstar Product Launch', () => {
  it('naturally stocks out the Arc Desk Lamp at 11:12 in the baseline', () => {
    const sim = build();
    sim.runUntil(HERO_HORIZON);
    const stockout = sim.getEvents().find((event) => event.type === 'inventory.stockout' && event.entityId === ARC_LAMP_ID);
    expect(stockout?.virtualTime).toBe(132 * MINUTE);
    const lamp = sim.getState().products.find((product) => product.id === ARC_LAMP_ID);
    expect(lamp?.stock).toBe(0);
    expect(sim.getState().metrics.lostOrders).toBe(2);
  });

  it('forks at 10:30, restocks through the HTTP contract, and prevents the stockout', () => {
    const sim = build();
    sim.runUntil(HERO_HORIZON);
    const branch = sim.forkAt({ time: HERO_FORK_TIME }, { name: 'Restock at 10:30' });
    const route = launchApi.routes.find((candidate) => candidate.method === 'POST' && candidate.path === '/api/products/:id/restock');
    if (!route) throw new Error('restock route missing');
    const response = executeAliveRoute(sim, route, { params: { id: ARC_LAMP_ID }, body: { quantity: HERO_RESTOCK_QUANTITY } });
    expect(response.status).toBe(200);
    sim.runUntil(HERO_HORIZON);
    const report = sim.compareBranches('branch:root', branch.id, { until: 'scenario-end' });
    const stockout = report.eventFindings.find((finding) => finding.key === 'arcStockout');
    expect(stockout?.a.status).toBe('before-horizon');
    expect(stockout?.b.status).toBe('not-before-horizon');
    expect(report.causalLanguagePermitted).toBe(true);
    expect(report.causalEventKey).toBe('arcStockout');
    const lamp = sim.getState().products.find((product) => product.id === ARC_LAMP_ID);
    expect(lamp?.stock).toBe(6);
  });

  it('serves historical world state when the baseline is scrubbed', () => {
    const sim = build();
    sim.runUntil(HERO_HORIZON);
    sim.enterScrub({ time: HERO_FORK_TIME });
    const lamp = sim.getState().products.find((product) => product.id === ARC_LAMP_ID);
    expect(lamp?.stock).toBe(2);
    expect(sim.getHeadTime()).toBe(HERO_HORIZON);
    expect(sim.getViewMode()).toBe('scrubbing');
  });
});
