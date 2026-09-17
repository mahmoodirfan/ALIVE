/**
 * Total-rollback regression suite (item 1-4). Every assertion here is about what must
 * NOT have changed after a failed commit.
 */
import { describe, expect, it } from 'vitest';
import { createSimulation } from '../src/simulation.js';
import { isAliveError } from '../src/errors.js';
import type { CommitNotification, ExogenousStream, Scenario } from '../src/types.js';
import { tinyScenario } from './fixtures.js';

interface Snapshot {
  world: unknown;
  pending: unknown;
  time: number;
  sequence: number;
  commits: number;
  events: number;
  cursors: unknown;
  guard: unknown;
}

function snapshot(sim: ReturnType<typeof createSimulation<never>>): Snapshot {
  return {
    world: structuredClone(sim.getState()),
    pending: structuredClone(sim.getPendingSources()),
    time: sim.getTime(),
    sequence: sim.getNextSequence(),
    commits: sim.getCommits().length,
    events: sim.getEvents().length,
    cursors: structuredClone(sim.getExogenousCursors()),
    guard: structuredClone(sim.getInstantGuard()),
  };
}

describe('total rollback (INV-21, items 1-4)', () => {
  it('leaves world, frontier, sequence, logs, cursors, guard and clock untouched', () => {
    const scenario = tinyScenario(
      {
        parent: (draft, _e, ctx) => {
          draft.n += 100;
          draft.log.push('parent');
          ctx.schedule({ type: 'later', virtualTime: 9999, payload: {} });
          ctx.emit({ type: 'child', payload: {}, slot: 'only' });
        },
        child: (draft) => {
          draft.n += 1;
          throw new Error('child exploded');
        },
        later: () => {},
      },
      [
        { key: 'p', type: 'parent', virtualTime: 100, payload: {} },
        { key: 'q', type: 'later', virtualTime: 200, payload: {} },
      ],
    );
    const sim = createSimulation({ scenario, seed: 's' });
    const before = snapshot(sim as never);
    const notifications: CommitNotification[] = [];
    sim.on('committed', (n) => notifications.push(n));

    expect(() => sim.advance(1000)).toThrowError(/child exploded/);

    expect(snapshot(sim as never)).toEqual(before);
    expect(notifications).toHaveLength(0);
    expect(sim.getRunState()).toBe('faulted');
  });

  it('the failing source itself is still pending after rollback (item 1)', () => {
    const scenario = tinyScenario(
      { boom: () => { throw new Error('poison'); } },
      [{ key: 'b', type: 'boom', virtualTime: 10, payload: {} }],
    );
    const sim = createSimulation({ scenario, seed: 's' });
    const pendingBefore = structuredClone(sim.getPendingSources());
    expect(() => sim.runNext()).toThrowError(/poison/);
    expect(sim.getPendingSources()).toEqual(pendingBefore);
    expect(sim.getPendingSources()).toHaveLength(1);
  });

  it('a preserved scheduler and a prohibited auto-retry coexist (item 3)', () => {
    let runs = 0;
    const scenario = tinyScenario(
      { boom: () => { runs += 1; throw new Error('poison'); } },
      [{ key: 'b', type: 'boom', virtualTime: 10, payload: {} }],
    );
    const sim = createSimulation({ scenario, seed: 's' });
    expect(() => sim.runNext()).toThrowError(/poison/);
    expect(sim.getPendingSources()).toHaveLength(1);
    for (const call of [() => sim.advance(1), () => sim.runNext(), () => sim.runUntil(900)]) {
      expect(call).toThrowError(/ALIVE_FAULTED/);
    }
    expect(runs).toBe(1);
  });

  it('a failed commit creates no timeline position (item 2)', () => {
    const scenario = tinyScenario(
      {
        ok: (draft) => void (draft.n += 1),
        boom: () => { throw new Error('poison'); },
      },
      [
        { key: 'a', type: 'ok', virtualTime: 100, payload: {} },
        { key: 'b', type: 'boom', virtualTime: 5000, payload: {} },
      ],
    );
    const sim = createSimulation({ scenario, seed: 's' });
    sim.runNext();
    expect(sim.getTime()).toBe(100);
    const cursorBefore = sim.getCursor();
    expect(() => sim.runNext()).toThrowError(/poison/);
    expect(sim.getTime()).toBe(100);
    expect(sim.getCursor()).toEqual(cursorBefore);
    const fault = sim.getFault()!;
    expect(fault.attemptedVirtualTime).toBe(5000);
    expect(fault.sourceKind).toBe('scheduled');
    expect((fault.originalError as Error).message).toBe('poison');
  });

  it('frontier-internal uid allocation does not survive a failed commit (item 4)', () => {
    const scenario = tinyScenario(
      {
        greedy: (_d, _e, ctx) => {
          ctx.schedule({ type: 'x', virtualTime: 5000, payload: {}, key: 'a' });
          ctx.schedule({ type: 'x', virtualTime: 6000, payload: {}, key: 'b' });
          throw new Error('after staging');
        },
        good: (_d, _e, ctx) => {
          ctx.schedule({ type: 'x', virtualTime: 7000, payload: {}, key: 'c' });
        },
        x: (draft) => void draft.log.push('x'),
      },
      [{ key: 'g', type: 'greedy', virtualTime: 10, payload: {} }],
    );
    const failing = createSimulation({ scenario, seed: 's' });
    expect(() => failing.runNext()).toThrowError(/after staging/);

    // A clean run that only ever does the successful work must produce byte-identical
    // scheduler state to one that first suffered a rolled-back staging attempt.
    const cleanScenario = tinyScenario(
      { good: (_d, _e, ctx) => { ctx.schedule({ type: 'x', virtualTime: 7000, payload: {}, key: 'c' }); },
        x: (draft) => void draft.log.push('x') },
      [{ key: 'g', type: 'good', virtualTime: 10, payload: {} }],
    );
    const clean = createSimulation({ scenario: cleanScenario, seed: 's' });
    clean.runNext();
    expect(clean.getNextSequence()).toBe(1 + 1); // bootstrap + one scheduled
    expect(failing.getNextSequence()).toBe(1);   // nothing consumed by the failure
  });

  it('rolls back a reschedule', () => {
    const scenario = tinyScenario(
      {
        setup: (_d, _e, ctx) => {
          ctx.schedule({ type: 'target', virtualTime: 5000, payload: {}, key: 'v' });
        },
        mover: (_d, _e, ctx) => {
          ctx.reschedule(victimId, 8000);
          throw new Error('after reschedule');
        },
        target: (draft) => void draft.log.push('target'),
      },
      [
        { key: 's', type: 'setup', virtualTime: 10, payload: {} },
        { key: 'm', type: 'mover', virtualTime: 20, payload: {} },
      ],
    );
    let victimId = '';
    const sim = createSimulation({ scenario, seed: 's' });
    sim.runNext();
    victimId = (sim.getPendingSources().find((s) => s.item.virtualTime === 5000) as {
      item: { scheduledId: string };
    }).item.scheduledId;
    const before = structuredClone(sim.getPendingSources());
    expect(() => sim.runNext()).toThrowError(/after reschedule/);
    expect(sim.getPendingSources()).toEqual(before);
  });

  it('rolls back exogenous successor staging', () => {
    const stream: ExogenousStream = {
      id: 'arrivals',
      from: 0,
      next: ({ ordinal, lastTime }) =>
        ordinal >= 5 ? null : { virtualTime: lastTime + 100, type: 'tick', payload: { ordinal } },
    };
    const scenario: Scenario<{ n: number; log: string[] }> = {
      ...tinyScenario({
        tick: (draft, e) => {
          const p = e.payload as { ordinal: number };
          if (p.ordinal === 1) throw new Error('boom on 1');
          draft.n += 1;
        },
      }),
      exogenous: [stream],
    };
    const sim = createSimulation({ scenario, seed: 's' });
    sim.runNext();
    const before = snapshot(sim as never);
    expect(() => sim.runNext()).toThrowError(/boom on 1/);
    expect(snapshot(sim as never)).toEqual(before);
    // exactly one pending source: the failed one, unchanged
    expect(sim.getPendingSources()).toHaveLength(1);
  });

  it('rolls back an invalid-payload commit', () => {
    const scenario = tinyScenario(
      {
        bad: (draft, _e, ctx) => {
          draft.n += 1;
          ctx.emit({ type: 'leaf', payload: { v: undefined } as never, slot: 'l' });
        },
        leaf: () => {},
      },
      [{ key: 'b', type: 'bad', virtualTime: 10, payload: {} }],
    );
    const sim = createSimulation({ scenario, seed: 's' });
    const before = snapshot(sim as never);
    try {
      sim.runNext();
      throw new Error('should have thrown');
    } catch (e) {
      expect(isAliveError(e, 'ALIVE_NON_JSON_VALUE')).toBe(true);
    }
    expect(snapshot(sim as never)).toEqual(before);
  });

  it('a handler cannot cancel or reschedule its own executing source (item 1)', () => {
    const scenario = tinyScenario(
      {
        selfish: (draft, e, ctx) => {
          // the source is still physically in the frontier, but must be invisible
          draft.log.push(`cancel=${ctx.cancel(e.id)}`);
          draft.log.push(`reschedule=${ctx.reschedule(e.id, 9999)}`);
        },
      },
      [{ key: 's', type: 'selfish', virtualTime: 10, payload: {} }],
    );
    const sim = createSimulation({ scenario, seed: 's' });
    sim.runNext();
    expect(sim.getState().log).toEqual(['cancel=false', 'reschedule=false']);
    expect(sim.getCommits()).toHaveLength(1);
    expect(sim.getPendingSources()).toHaveLength(0);
  });
});
