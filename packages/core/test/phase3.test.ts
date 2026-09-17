import { describe, expect, it } from 'vitest';
import { createSimulation } from '../src/simulation.js';
import { PRIORITY, type Scenario } from '../src/types.js';

interface LaunchWorld {
  stock: number;
  revenue: number;
  orders: number;
  label: string;
}

function launchScenario(): Scenario<LaunchWorld> {
  return {
    id: 'product-launch',
    version: '1.0.0',
    name: 'Northstar Goods Product Launch',
    epoch: '2026-09-16T00:00:00.000Z',
    endTime: 6000,
    initialState: () => ({ stock: 3, revenue: 0, orders: 0, label: 'available' }),
    events: {
      'purchase.intent': (draft, event, ctx) => {
        if (draft.stock <= 0) return;
        draft.stock -= 1;
        draft.orders += 1;
        draft.revenue += 100;
        if (draft.stock === 0) {
          draft.label = 'sold-out';
          ctx.emit({
            type: 'inventory.stockout',
            entityId: 'arc-lamp',
            slot: 'stockout',
            payload: { productId: 'arc-lamp' },
          });
        }
      },
      'inventory.stockout': () => {},
      'inventory.restocked': (draft, event) => {
        const p = event.payload as { quantity: number };
        draft.stock += p.quantity;
        if (draft.stock > 0) draft.label = 'available';
      },
    },
    commands: {
      restock: {
        validate: (_state, command) => {
          const p = command.payload as { quantity: number };
          if (!Number.isSafeInteger(p.quantity) || p.quantity <= 0) {
            return { code: 'ALIVE_INVALID_COMMAND', message: 'quantity must be positive' };
          }
          return undefined;
        },
        events: (_state, command) => [
          {
            type: 'inventory.restocked',
            entityId: 'arc-lamp',
            payload: command.payload,
          },
        ],
      },
    },
    exogenous: [
      {
        id: 'demand',
        from: 1000,
        until: 5000,
        next: ({ ordinal }) => {
          if (ordinal >= 5) return null;
          return {
            virtualTime: (ordinal + 1) * 1000,
            type: 'purchase.intent',
            actorId: `customer-${ordinal}`,
            key: `intent-${ordinal}`,
            payload: { productId: 'arc-lamp', quantity: 1 },
          };
        },
      },
    ],
    stateObservables: {
      stock: {
        kind: 'numeric',
        label: 'Arc Desk Lamp stock',
        select: (s) => s.stock,
        format: 'integer',
        sample: 'every-commit',
      },
      revenue: {
        kind: 'numeric',
        label: 'Revenue',
        select: (s) => s.revenue,
        format: 'currency',
        sample: 'every-commit',
        direction: 'higher-is-better',
      },
      orders: {
        kind: 'numeric',
        label: 'Orders',
        select: (s) => s.orders,
        format: 'integer',
        sample: 'at-horizon',
      },
      availability: {
        kind: 'text',
        label: 'Availability',
        select: (s) => s.label,
        sample: 'at-horizon',
      },
    },
    eventObservables: {
      stockout: {
        label: 'Arc Desk Lamp stockout',
        match: (event) => event.type === 'inventory.stockout' && event.entityId === 'arc-lamp',
        expect: 'at-most-once',
      },
    },
  };
}

function buildCounterfactual() {
  const sim = createSimulation({ scenario: launchScenario(), seed: 'launch-demo', checkpointEvery: 1 });
  sim.runUntil(6000);
  const first = sim.getCommits()[0]!.commitId;
  const fork = sim.forkAt({ afterCommitId: first }, { name: 'Restock at 10:30' });
  const result = sim.dispatch({ type: 'restock', payload: { quantity: 3 } });
  if (!result.accepted) throw new Error('restock unexpectedly rejected');
  sim.runUntil(6000);
  return { sim, fork };
}

describe('Phase 3 counterfactual comparison', () => {
  it('detects the Product Launch stockout prevention and permits scoped causal wording', () => {
    const { sim, fork } = buildCounterfactual();
    const report = sim.compareBranches('branch:root', fork.id, { until: 'scenario-end' });

    expect(report.horizon).toBe(6000);
    expect(report.commonAncestry?.afterCommitId).toBe(sim.getBranches().find((b) => b.id === fork.id)?.forkCursor?.afterCommitId);
    expect(report.interventions.a).toHaveLength(0);
    expect(report.interventions.b).toHaveLength(1);
    expect(report.causalLanguagePermitted).toBe(true);
    expect(report.causalEventKey).toBe('stockout');

    const stockout = report.eventFindings.find((x) => x.key === 'stockout')!;
    expect(stockout.a.status).toBe('before-horizon');
    if (stockout.a.status === 'before-horizon') expect(stockout.a.at).toBe(3000);
    expect(stockout.b.status).toBe('not-before-horizon');
    expect(stockout.changed).toBe(true);

    const stock = report.stateFindings.find((x) => x.key === 'stock')!;
    expect(stock.kind).toBe('numeric');
    if (stock.kind === 'numeric') {
      expect(stock.aAtHorizon).toBe(0);
      expect(stock.bAtHorizon).toBe(1);
      expect(stock.delta).toBe(1);
      expect(stock.series?.map((x) => x.time)).toEqual([1000, 2000, 3000, 4000, 5000, 6000]);
      expect(stock.series?.[0]).toEqual({ time: 1000, a: 2, b: 5 });
    }

    const revenue = report.stateFindings.find((x) => x.key === 'revenue')!;
    expect(revenue.kind).toBe('numeric');
    if (revenue.kind === 'numeric') {
      expect(revenue.aAtHorizon).toBe(300);
      expect(revenue.bAtHorizon).toBe(500);
      expect(revenue.delta).toBe(200);
    }

    const availability = report.stateFindings.find((x) => x.key === 'availability')!;
    expect(availability).toMatchObject({
      kind: 'text',
      aAtHorizon: 'sold-out',
      bAtHorizon: 'available',
      changed: true,
    });
  });

  it('distinguishes an event after the horizon from no known occurrence', () => {
    const { sim, fork } = buildCounterfactual();
    const report = sim.compareBranches('branch:root', fork.id, {
      until: 2000,
      observables: ['stockout'],
    });
    expect(report.eventFindings[0]?.a.status).toBe('after-horizon');
    if (report.eventFindings[0]?.a.status === 'after-horizon') {
      expect(report.eventFindings[0].a.at).toBe(3000);
    }
    expect(report.eventFindings[0]?.b.status).toBe('not-before-horizon');
    expect(report.causalLanguagePermitted).toBe(false);
    expect(report.causalLanguageBlockedBy).toContain('no-selected-event-observable-shows-prevention');
  });

  it('rejects comparison when either branch has not fully evaluated the horizon', () => {
    const sim = createSimulation({ scenario: launchScenario(), seed: 'incomplete' });
    sim.runUntil(6000);
    const fork = sim.forkAt({ commitIndex: 1 });
    expect(() => sim.compareBranches('branch:root', fork.id, { until: 6000 })).toThrowError(
      /ALIVE_HORIZON_NOT_REACHED/,
    );
  });

  it('rejects a horizon when same-time work is still pending at that instant', () => {
    const sameTime: Scenario<{ n: number }> = {
      id: 'same-time-horizon', version: '1', name: 'same', epoch: '2026-01-01T00:00:00.000Z',
      initialState: () => ({ n: 0 }),
      events: { tick: (d) => { d.n += 1; } },
      commands: {},
      bootstrap: [
        { key: 'a', type: 'tick', virtualTime: 1000, priority: PRIORITY.domain, payload: {} },
        { key: 'b', type: 'tick', virtualTime: 1000, priority: PRIORITY.domain, payload: {} },
      ],
      stateObservables: {
        n: { kind: 'numeric', label: 'N', select: (s) => s.n, sample: 'at-horizon' },
      },
    };
    const sim = createSimulation({ scenario: sameTime, seed: 'same-time' });
    sim.runNext();
    expect(sim.getHeadTime()).toBe(1000);
    expect(() => sim.compareBranches('branch:root', 'branch:root', { until: 1000 })).toThrowError(
      /ALIVE_HORIZON_NOT_REACHED/,
    );
  });

  it('compares sibling branches symmetrically and blocks causal language when both were intervened on', () => {
    const sim = createSimulation({ scenario: launchScenario(), seed: 'siblings' });
    sim.runUntil(6000);
    const first = sim.getCommits()[0]!.commitId;

    const a = sim.forkAt({ afterCommitId: first }, { name: 'small-restock' });
    sim.dispatch({ type: 'restock', payload: { quantity: 1 } });
    sim.runUntil(6000);

    sim.switchBranch('branch:root');
    const b = sim.forkAt({ afterCommitId: first }, { name: 'large-restock' });
    sim.dispatch({ type: 'restock', payload: { quantity: 3 } });
    sim.runUntil(6000);

    const report = sim.compareBranches(a.id, b.id, { until: 6000 });
    expect(report.commonAncestry?.afterCommitId).toBe(first);
    expect(report.interventions.a).toHaveLength(1);
    expect(report.interventions.b).toHaveLength(1);
    expect(report.causalLanguagePermitted).toBe(false);
    expect(report.causalLanguageBlockedBy).toContain('baseline-has-post-ancestry-interventions');
  });


  it('uses the deepest shared graph cursor for nested branches', () => {
    const sim = createSimulation({ scenario: launchScenario(), seed: 'nested' });
    sim.runUntil(6000);
    const first = sim.getCommits()[0]!.commitId;

    const child = sim.forkAt({ afterCommitId: first }, { name: 'child' });
    sim.dispatch({ type: 'restock', payload: { quantity: 3 } });
    sim.runUntil(2000);
    const childForkCursor = sim.getCursor();
    const grand = sim.forkAt({ afterCommitId: childForkCursor.afterCommitId! }, { name: 'grand' });
    sim.dispatch({ type: 'restock', payload: { quantity: 1 } });
    sim.runUntil(6000);

    sim.switchBranch(child.id);
    sim.runUntil(6000);

    const report = sim.compareBranches(child.id, grand.id, { until: 6000 });
    expect(report.commonAncestry?.branchId).toBe(child.id);
    expect(report.commonAncestry?.afterCommitId).toBe(childForkCursor.afterCommitId);
    expect(report.interventions.a).toHaveLength(0);
    expect(report.interventions.b).toHaveLength(1);
  });


  it('stops common ancestry at the earlier fork when siblings leave the parent at different times', () => {
    const sim = createSimulation({ scenario: launchScenario(), seed: 'different-fork-times' });
    sim.runUntil(6000);
    const first = sim.getCommits()[0]!.commitId;
    const second = sim.getCommits()[1]!.commitId;

    const early = sim.forkAt({ afterCommitId: first }, { name: 'early' });
    sim.runUntil(6000);

    sim.switchBranch('branch:root');
    const late = sim.forkAt({ afterCommitId: second }, { name: 'late' });
    sim.runUntil(6000);

    const report = sim.compareBranches(early.id, late.id, { until: 6000 });
    expect(report.commonAncestry?.branchId).toBe('branch:root');
    expect(report.commonAncestry?.afterCommitId).toBe(first);
    expect(report.commonAncestry?.virtualTime).toBe(1000);
  });

  it('supports selecting a subset of observables and rejects unknown keys', () => {
    const { sim, fork } = buildCounterfactual();
    const report = sim.compareBranches('branch:root', fork.id, {
      until: 6000,
      observables: ['stock', 'stockout'],
    });
    expect(report.stateFindings.map((x) => x.key)).toEqual(['stock']);
    expect(report.eventFindings.map((x) => x.key)).toEqual(['stockout']);
    expect(() =>
      sim.compareBranches('branch:root', fork.id, { until: 6000, observables: ['missing'] }),
    ).toThrowError(/ALIVE_UNKNOWN_OBSERVABLE/);
  });

  it('survives replay round-trip with an identical comparison report', () => {
    const { sim, fork } = buildCounterfactual();
    const before = sim.compareBranches('branch:root', fork.id, { until: 6000 });
    const replay = sim.exportReplay();

    const loaded = createSimulation({ scenario: launchScenario(), seed: 'launch-demo', checkpointEvery: 0 });
    loaded.loadReplay(replay);
    const after = loaded.compareBranches('branch:root', fork.id, { until: 6000 });
    expect(after).toEqual(before);
  });

  it('requires endTime when using the scenario-end horizon', () => {
    const scenario: Scenario<{ n: number }> = {
      id: 'no-end', version: '1', name: 'no-end', epoch: '2026-01-01T00:00:00.000Z',
      initialState: () => ({ n: 0 }), events: {}, commands: {},
      stateObservables: { n: { kind: 'numeric', label: 'N', select: (s) => s.n, sample: 'at-horizon' } },
    };
    const sim = createSimulation({ scenario, seed: 'x' });
    expect(() => sim.compareBranches('branch:root', 'branch:root', { until: 'scenario-end' })).toThrowError(
      /ALIVE_INVALID_HORIZON/,
    );
  });

  it('enforces at-most-once event-observable cardinality', () => {
    const scenario: Scenario<{ n: number }> = {
      id: 'cardinality', version: '1', name: 'cardinality', epoch: '2026-01-01T00:00:00.000Z', endTime: 3000,
      initialState: () => ({ n: 0 }),
      events: { hit: (d) => { d.n += 1; } }, commands: {},
      bootstrap: [
        { key: 'a', type: 'hit', virtualTime: 1000, payload: {} },
        { key: 'b', type: 'hit', virtualTime: 2000, payload: {} },
      ],
      eventObservables: {
        hit: { label: 'Hit', match: (e) => e.type === 'hit', expect: 'at-most-once' },
      },
    };
    const sim = createSimulation({ scenario, seed: 'cardinality' });
    sim.runUntil(3000);
    expect(() => sim.compareBranches('branch:root', 'branch:root', { until: 3000 })).toThrowError(
      /ALIVE_OBSERVABLE_CARDINALITY/,
    );
  });
});
