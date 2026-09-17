import { describe, expect, it } from 'vitest';
import { createSimulation, Simulation } from '../src/simulation.js';
import type { ExogenousStream, Scenario } from '../src/types.js';
import { shopScenario, type ShopWorld } from './fixtures.js';

function run(seed: string, opts: Parameters<typeof shopScenario>[0] = {}) {
  const sim = createSimulation({ scenario: shopScenario(opts), seed });
  sim.advance(10_000);
  return sim;
}

/** FNV-1a-style rolling fold, so a long run needs no second in-memory history. */
const FNV_PRIME = 1099511628211n;
const MASK64 = (1n << 64n) - 1n;
function digestStep(acc: bigint, text: string): bigint {
  let h = acc === 0n ? 14695981039346656037n : acc;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * FNV_PRIME) & MASK64;
  }
  return h;
}

const trace = (sim: Simulation<ShopWorld>) => ({
  state: sim.getState(),
  commitIds: sim.getCommits().map((c) => c.commitId),
  eventIds: sim.getEvents().map((e) => e.id),
  types: sim.getEvents().map((e) => e.type),
  times: sim.getEvents().map((e) => e.virtualTime),
});

describe('determinism', () => {
  it('same seed produces identical ids, order, timestamps and state', () => {
    expect(trace(run('seed-A'))).toEqual(trace(run('seed-A')));
  });

  it('different seeds produce a different but internally consistent world', () => {
    const a = run('seed-A');
    const b = run('seed-B');
    expect(trace(b)).not.toEqual(trace(a));
    for (const sim of [a, b]) {
      const lamp = sim.getState().products.lamp!;
      const orders = Object.values(sim.getState().orders);
      expect(lamp.stock).toBe(5 - orders.reduce((n, o) => n + o.qty, 0));
      expect(sim.getState().metrics.revenue).toBe(
        orders.reduce((n, o) => n + o.qty * 100, 0),
      );
    }
  });

  it('an unrelated extra RNG draw does not perturb another actor (INV-31)', () => {
    // seed-B exercises two customers and the full cascade, so the extra draw in
    // revenue.changed sits between other actors' draws in execution order.
    const plain = run('seed-B');
    const noisy = run('seed-B', { extraDraw: true });
    // the extra draw happens in revenue.changed and must change nothing at all
    expect(trace(noisy)).toEqual(trace(plain));
  });

  it('suppressing a conditional sibling leaves unrelated identities stable (INV-10/14)', () => {
    // seed-B is chosen because it actually takes the low-stock branch; the test is
    // meaningless on a seed where the sibling never fires.
    const withSibling = run('seed-B');
    const without = run('seed-B', { suppressSibling: true });

    const revenueIds = (s: Simulation<ShopWorld>) =>
      s.getEvents().filter((e) => e.type === 'revenue.changed').map((e) => e.id);
    const revenueOrder = (s: Simulation<ShopWorld>) =>
      s.getEvents().filter((e) => e.type === 'revenue.changed').map((e) => e.withinCommitOrder);

    expect(revenueIds(without)).toEqual(revenueIds(withSibling));
    expect(without.getEvents().some((e) => e.type === 'inventory.low')).toBe(false);
    expect(withSibling.getEvents().some((e) => e.type === 'inventory.low')).toBe(true);
    // only the presentation order shifted
    expect(revenueOrder(without)).not.toEqual(revenueOrder(withSibling));
  });

  it('order.created identities are stable when the sibling disappears', () => {
    const a = run('seed-B');
    const b = run('seed-B', { suppressSibling: true });
    const orderIds = (s: Simulation<ShopWorld>) =>
      s.getEvents().filter((e) => e.type === 'order.created').map((e) => e.id);
    expect(orderIds(b)).toEqual(orderIds(a));
  });

  it('iteration order of world keys does not affect results', () => {
    const reordered: Scenario<ShopWorld> = {
      ...shopScenario(),
      initialState: () => ({
        // same content, different insertion order
        metrics: { revenue: 0, lowWarnings: 0 },
        log: [],
        orders: {},
        products: {
          stand: { id: 'stand', stock: 50, price: 40 },
          lamp: { id: 'lamp', stock: 5, price: 100 },
        },
      }),
    };
    const a = createSimulation({ scenario: shopScenario(), seed: 'seed-A' });
    const b = createSimulation({ scenario: reordered, seed: 'seed-A' });
    a.advance(10_000);
    b.advance(10_000);
    expect(trace(b).eventIds).toEqual(trace(a).eventIds);
    expect(b.getState().metrics).toEqual(a.getState().metrics);
  });

  it('holds under a long run with cascades and exogenous demand', () => {
    const stream: ExogenousStream = {
      id: 'arrivals',
      from: 0,
      next: ({ ordinal, lastTime, random }) =>
        ordinal >= 400
          ? null
          : {
              virtualTime: Math.round(lastTime + random.exponential('gap', 50)) + 1,
              type: 'customer.arrived',
              payload: { ordinal },
              actorId: `c${ordinal}`,
            },
    };
    const scenario: Scenario<ShopWorld> = {
      ...shopScenario(),
      initialState: () => ({
        products: {
          lamp: { id: 'lamp', stock: 100000, price: 100 },
          stand: { id: 'stand', stock: 100000, price: 40 },
        },
        orders: {},
        log: [],
        metrics: { revenue: 0, lowWarnings: 0 },
      }),
      exogenous: [stream],
    };
    const go = () => {
      const s = createSimulation({ scenario, seed: 'long' });
      s.advance(1_000_000);
      return s;
    };
    const a = go();
    const b = go();
    expect(a.getEvents().length).toBeGreaterThan(400);
    expect(trace(b)).toEqual(trace(a));
  });

  it('handles 10k+ events deterministically, by digest over the whole run', () => {
    // A count proves nothing about identity or ordering. Fold the full ordered history
    // into a rolling digest instead of retaining a second giant representation.
    const stream: ExogenousStream = {
      id: 'bulk',
      from: 0,
      next: ({ ordinal, lastTime, random }) =>
        ordinal >= 9000
          ? null
          : {
              virtualTime: lastTime + 1 + Math.floor(random.float('jitter') * 3),
              type: ordinal % 3 === 0 ? 'customer.arrived' : 'noop',
              payload: { ordinal },
              actorId: `c${ordinal}`,
            },
    };
    const scenario: Scenario<ShopWorld> = {
      ...shopScenario(),
      initialState: () => ({
        products: {
          lamp: { id: 'lamp', stock: 1_000_000, price: 100 },
          stand: { id: 'stand', stock: 1_000_000, price: 40 },
        },
        orders: {},
        log: [],
        metrics: { revenue: 0, lowWarnings: 0 },
      }),
      exogenous: [stream],
    };

    const go = () => {
      const s = createSimulation({ scenario, seed: 'bulk' });
      s.advance(10_000_000);
      let digest = 0n;
      let events = 0;
      for (const commit of s.getCommits()) {
        for (const e of commit.events) {
          digest = digestStep(digest, commit.commitId);
          digest = digestStep(digest, e.id);
          digest = digestStep(digest, e.type);
          digest = digestStep(digest, String(e.virtualTime));
          digest = digestStep(digest, String(e.withinCommitOrder));
          events += 1;
        }
      }
      return { digest: digest.toString(16), events, world: s.getState() };
    };

    const a = go();
    const b = go();
    expect(a.events).toBeGreaterThanOrEqual(10_000);
    expect(b.digest).toBe(a.digest);
    expect(b.world).toEqual(a.world);
  });

  it('interventions are part of the deterministic trace', () => {
    const go = () => {
      const s = createSimulation({ scenario: shopScenario(), seed: 'mix' });
      s.advance(1200);
      s.dispatch({ type: 'product.restock', payload: { productId: 'lamp', quantity: 8 } });
      s.advance(2000);
      s.dispatch({ type: 'product.restock', payload: { productId: 'stand', quantity: 2 } });
      s.advance(5000);
      return s;
    };
    expect(trace(go())).toEqual(trace(go()));
  });
});
