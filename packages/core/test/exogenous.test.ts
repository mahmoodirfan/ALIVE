import { describe, expect, it } from 'vitest';
import { createSimulation } from '../src/simulation.js';
import { PRIORITY } from '../src/types.js';
import type { ExogenousStream, Scenario } from '../src/types.js';
import { scheduledOf } from './fixtures.js';

interface World { arrivals: string[]; n: number }

function arrivalsStream(limit = Infinity): ExogenousStream {
  return {
    id: 'arrivals',
    from: 0,
    next: ({ ordinal, lastTime, random }) => {
      if (ordinal >= limit) return null;
      const gap = random.exponential('interarrival', 1000);
      return {
        virtualTime: Math.round(lastTime + gap) + 1,
        type: 'customer.arrived',
        payload: { ordinal },
        actorId: `cust-${ordinal}`,
      };
    },
  };
}

function scenarioWith(stream: ExogenousStream, opts: { boomAt?: number } = {}): Scenario<World> {
  return {
    id: 'exo',
    version: '1.0.0',
    name: 'Exo',
    epoch: '2026-01-01T00:00:00.000Z',
    initialState: () => ({ arrivals: [], n: 0 }),
    events: {
      'customer.arrived': (draft, event) => {
        const p = event.payload as { ordinal: number };
        if (opts.boomAt !== undefined && p.ordinal === opts.boomAt) {
          throw new Error(`boom at ${p.ordinal}`);
        }
        draft.arrivals.push(`${event.actorId}@${event.virtualTime}`);
        draft.n += 1;
      },
    },
    commands: {},
    exogenous: [stream],
  };
}

describe('exogenous streams (Clarification B, INV-38/39)', () => {
  it('keeps at most one pending item per stream', () => {
    const sim = createSimulation({ scenario: scenarioWith(arrivalsStream()), seed: 'exo-1' });
    expect(sim.getPendingSources()).toHaveLength(1);
    for (let i = 0; i < 10; i++) {
      sim.runNext();
      expect(sim.getPendingSources().filter((s) => s.item.virtualTime >= 0)).toHaveLength(1);
    }
  });

  it('materializes the successor only on successful commit', () => {
    const sim = createSimulation({ scenario: scenarioWith(arrivalsStream()), seed: 'exo-1' });
    const first = scheduledOf(sim.getPendingSources()[0]!);
    sim.runNext();
    const second = scheduledOf(sim.getPendingSources()[0]!);
    expect(second.scheduledId).not.toBe(first.scheduledId);
    expect(second.virtualTime).toBeGreaterThan(first.virtualTime);
  });

  it('advances the cursor with the commit', () => {
    const sim = createSimulation({ scenario: scenarioWith(arrivalsStream()), seed: 'exo-1' });
    expect(sim.getExogenousCursors()).toEqual({ arrivals: 0 });
    sim.runNext();
    expect(sim.getExogenousCursors()).toEqual({ arrivals: 1 });
    sim.runNext();
    expect(sim.getExogenousCursors()).toEqual({ arrivals: 2 });
  });

  it('a failed commit advances neither cursor nor stream', () => {
    const sim = createSimulation({
      scenario: scenarioWith(arrivalsStream(), { boomAt: 2 }),
      seed: 'exo-1',
    });
    sim.runNext();
    sim.runNext();
    const cursorsBefore = sim.getExogenousCursors();
    const pendingBefore = structuredClone(sim.getPendingSources());
    const timeBefore = sim.getTime();
    expect(() => sim.runNext()).toThrowError(/boom at 2/);
    expect(sim.getExogenousCursors()).toEqual(cursorsBefore);
    // item 1: the failing source is scheduler state and survives the rollback intact,
    // and no successor was staged into the frontier
    expect(sim.getPendingSources()).toEqual(pendingBefore);
    expect(sim.getPendingSources()).toHaveLength(1);
    expect(sim.getTime()).toBe(timeBefore);
    expect(sim.getRunState()).toBe('faulted');
  });

  it('a successful commit stages exactly one successor, never more', () => {
    const sim = createSimulation({ scenario: scenarioWith(arrivalsStream()), seed: 'exo-1' });
    for (let i = 0; i < 25; i++) {
      const before = sim.getPendingSources().length;
      expect(before).toBe(1);
      sim.runNext();
      expect(sim.getPendingSources()).toHaveLength(1);
    }
    expect(sim.getCommits()).toHaveLength(25);
  });

  it('exhaustion leaves no successor pending', () => {
    const sim = createSimulation({ scenario: scenarioWith(arrivalsStream(2)), seed: 'exo-1' });
    sim.runNext();
    expect(sim.getPendingSources()).toHaveLength(1);
    sim.runNext();
    expect(sim.getPendingSources()).toHaveLength(0);
  });

  it('reproduces the full arrival sequence, not just its length', () => {
    const go = () => {
      const s = createSimulation({ scenario: scenarioWith(arrivalsStream(30)), seed: 'exo-seq' });
      s.advance(1_000_000);
      return s.getEvents().map((e) => `${e.id}|${e.type}@${e.virtualTime}`);
    };
    const a = go();
    expect(a).toHaveLength(30);
    expect(go()).toEqual(a);
  });

  it('exhausts cleanly when next() returns null', () => {
    const sim = createSimulation({ scenario: scenarioWith(arrivalsStream(3)), seed: 'exo-1' });
    sim.advance(1_000_000);
    expect(sim.getState().n).toBe(3);
    expect(sim.getPendingSources()).toHaveLength(0);
  });

  it('handles a stream that is empty from the start', () => {
    const sim = createSimulation({ scenario: scenarioWith(arrivalsStream(0)), seed: 'exo-1' });
    expect(sim.getPendingSources()).toHaveLength(0);
    sim.advance(10_000);
    expect(sim.getState().n).toBe(0);
  });

  it('respects `until`', () => {
    const stream: ExogenousStream = { ...arrivalsStream(), until: 3000 };
    const sim = createSimulation({ scenario: scenarioWith(stream), seed: 'exo-1' });
    sim.advance(1_000_000);
    for (const a of sim.getState().arrivals) {
      expect(Number(a.split('@')[1])).toBeLessThanOrEqual(3000);
    }
  });

  it('produces identical arrivals across reruns with the same seed', () => {
    const run = () => {
      const sim = createSimulation({ scenario: scenarioWith(arrivalsStream(20)), seed: 'exo-1' });
      sim.advance(1_000_000);
      return sim.getState().arrivals;
    };
    expect(run()).toEqual(run());
    expect(run().length).toBe(20);
  });

  it('produces different arrivals for a different seed', () => {
    const run = (seed: string) => {
      const sim = createSimulation({ scenario: scenarioWith(arrivalsStream(20)), seed });
      sim.advance(1_000_000);
      return sim.getState().arrivals;
    };
    expect(run('exo-1')).not.toEqual(run('exo-2'));
  });

  it('arrival identity and timing do not depend on world state (INV-38)', () => {
    // two scenarios whose handlers mutate state completely differently,
    // sharing one stream definition: arrivals must be identical
    const base = scenarioWith(arrivalsStream(15));
    const divergent: Scenario<World> = {
      ...base,
      events: {
        'customer.arrived': (draft, event) => {
          draft.n += 1000;
          draft.arrivals.push(`${event.actorId}@${event.virtualTime}`);
        },
      },
    };
    const a = createSimulation({ scenario: base, seed: 'exo-9' });
    const b = createSimulation({ scenario: divergent, seed: 'exo-9' });
    a.advance(1_000_000);
    b.advance(1_000_000);
    expect(b.getState().arrivals).toEqual(a.getState().arrivals);
    expect(b.getState().n).not.toBe(a.getState().n);
  });

  it('uses the exogenous priority band', () => {
    const sim = createSimulation({ scenario: scenarioWith(arrivalsStream()), seed: 'exo-1' });
    expect(sim.getPendingSources()[0]!.item.priority).toBe(PRIORITY.exogenous);
  });

  it('exogenous root events use the scheduledId as their EventId (Clarification A)', () => {
    const sim = createSimulation({ scenario: scenarioWith(arrivalsStream(3)), seed: 'exo-1' });
    sim.advance(1_000_000);
    for (const c of sim.getCommits()) {
      expect(c.source.kind).toBe('scheduled');
      expect(c.events[0]!.id).toBe(c.source.id);
      expect(c.commitId).toBe(`commit:${c.source.id}`);
      expect(c.events[0]!.id.startsWith('sch:')).toBe(true);
    }
  });
});
