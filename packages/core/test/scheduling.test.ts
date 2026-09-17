import { describe, expect, it } from 'vitest';
import { createSimulation } from '../src/simulation.js';
import { isAliveError } from '../src/errors.js';
import { PRIORITY } from '../src/types.js';
import { tinyScenario } from './fixtures.js';

const CUR = 1000;

function simWith(schedule: (ctx: {
  schedule: (s: { type: string; virtualTime: number; payload: unknown; priority?: number; key?: string }) => string;
  cancel: (id: string) => boolean;
  reschedule: (id: string, t: number) => boolean;
}) => void) {
  const scenario = tinyScenario(
    {
      root: (_d, _e, ctx) => schedule(ctx as never),
      target: (draft) => void draft.log.push('target'),
    },
    [{ key: 'r', type: 'root', virtualTime: CUR, priority: PRIORITY.domain, payload: {} }],
  );
  return createSimulation({ scenario, seed: 's' });
}

describe('temporal scheduling constraints (INV-71)', () => {
  it('accepts future scheduling', () => {
    const sim = simWith((ctx) => {
      ctx.schedule({ type: 'target', virtualTime: CUR + 1, payload: {} });
    });
    sim.runNext();
    expect(sim.getPendingSources()).toHaveLength(1);
  });

  it('accepts same-time work at equal priority (larger sequence sorts after)', () => {
    const sim = simWith((ctx) => {
      ctx.schedule({ type: 'target', virtualTime: CUR, priority: PRIORITY.domain, payload: {} });
    });
    sim.runNext();
    expect(sim.getPendingSources()).toHaveLength(1);
    sim.runNext();
    expect(sim.getState().log).toEqual(['target']);
  });

  it('accepts same-time work at a numerically greater priority', () => {
    const sim = simWith((ctx) => {
      ctx.schedule({ type: 'target', virtualTime: CUR, priority: PRIORITY.derived, payload: {} });
    });
    sim.runNext();
    expect(sim.getPendingSources()).toHaveLength(1);
  });

  it('rejects scheduled priority 0 because it is reserved for interventions', () => {
    const sim = simWith((ctx) => {
      ctx.schedule({
        type: 'target',
        virtualTime: CUR,
        priority: PRIORITY.intervention,
        payload: {},
      });
    });
    try {
      sim.runNext();
      throw new Error('should have thrown');
    } catch (e) {
      expect(isAliveError(e, 'ALIVE_INVALID_PRIORITY')).toBe(true);
    }
    expect(sim.getCommits()).toHaveLength(0);
    expect(sim.getRunState()).toBe('faulted');
  });

  it('rejects scheduling into the past and rolls the commit back', () => {
    const sim = simWith((ctx) => {
      ctx.schedule({ type: 'target', virtualTime: CUR - 1, payload: {} });
    });
    const sequenceBefore = sim.getNextSequence();
    expect(() => sim.runNext()).toThrowError(/ALIVE_RETROACTIVE_SCHEDULE/);
    expect(sim.getCommits()).toHaveLength(0);
    expect(sim.getNextSequence()).toBe(sequenceBefore); // allocation rolled back
  });

  it('rejects a reschedule that would cross the history prefix', () => {
    const scenario = tinyScenario(
      {
        setup: (_d, _e, ctx) => {
          ctx.schedule({ type: 'target', virtualTime: 5000, payload: {}, key: 'v' });
        },
        mover: (_d, _e, ctx) => {
          const id = (
            ctx as unknown as { schedule: unknown } & {
              reschedule: (i: string, t: number) => boolean;
            }
          );
          void id;
          ctx.reschedule(victimId, 1);
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
    expect(() => sim.runNext()).toThrowError(/ALIVE_RETROACTIVE_SCHEDULE/);
    // victim untouched at its original time
    expect(sim.getPendingSources().some((s) => s.item.virtualTime === 5000)).toBe(true);
  });

  it('allows a forward reschedule', () => {
    const scenario = tinyScenario(
      {
        setup: (_d, _e, ctx) => {
          ctx.schedule({ type: 'target', virtualTime: 5000, payload: {}, key: 'v' });
        },
        mover: (_d, _e, ctx) => {
          ctx.reschedule(victimId, 8000);
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
    sim.runNext();
    const pending = sim.getPendingSources();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.item.virtualTime).toBe(8000);
  });

  it('cancel removes pending work and returns false for unknown ids', () => {
    const scenario = tinyScenario(
      {
        setup: (_d, _e, ctx) => {
          ctx.schedule({ type: 'target', virtualTime: 5000, payload: {}, key: 'v' });
        },
        killer: (draft, _e, ctx) => {
          draft.log.push(String(ctx.cancel(victimId)));
          draft.log.push(String(ctx.cancel('sch:nope')));
        },
        target: (draft) => void draft.log.push('target'),
      },
      [
        { key: 's', type: 'setup', virtualTime: 10, payload: {} },
        { key: 'k', type: 'killer', virtualTime: 20, payload: {} },
      ],
    );
    let victimId = '';
    const sim = createSimulation({ scenario, seed: 's' });
    sim.runNext();
    victimId = (sim.getPendingSources().find((s) => s.item.virtualTime === 5000) as {
      item: { scheduledId: string };
    }).item.scheduledId;
    sim.advance(100000);
    expect(sim.getState().log).toEqual(['true', 'false']);
    expect(sim.getState().log).not.toContain('target');
  });

  it('rejects two scheduled items deriving the same id', () => {
    const sim = simWith((ctx) => {
      ctx.schedule({ type: 'target', virtualTime: CUR + 1, payload: {}, key: 'same' });
      ctx.schedule({ type: 'target', virtualTime: CUR + 2, payload: {}, key: 'same' });
    });
    try {
      sim.runNext();
      throw new Error('should have thrown');
    } catch (e) {
      expect(isAliveError(e, 'ALIVE_SCHEDULED_ID_COLLISION')).toBe(true);
    }
    expect(sim.getCommits()).toHaveLength(0);
  });

  it('lets a handler cancel then re-schedule the same derived id within one commit', () => {
    const scenario = tinyScenario(
      {
        setup: (_d, _e, ctx) => {
          ctx.schedule({ type: 'target', virtualTime: 5000, payload: {}, key: 'v' });
        },
        redo: (_d, _e, ctx) => {
          ctx.cancel(victimId);
          ctx.schedule({ type: 'target', virtualTime: 7000, payload: {}, key: 'v2' });
        },
        target: (draft, e) => void draft.log.push(`target@${e.virtualTime}`),
      },
      [
        { key: 's', type: 'setup', virtualTime: 10, payload: {} },
        { key: 'r', type: 'redo', virtualTime: 20, payload: {} },
      ],
    );
    let victimId = '';
    const sim = createSimulation({ scenario, seed: 's' });
    sim.runNext();
    victimId = (sim.getPendingSources().find((s) => s.item.virtualTime === 5000) as {
      item: { scheduledId: string };
    }).item.scheduledId;
    sim.advance(100000);
    expect(sim.getState().log).toEqual(['target@7000']);
  });
});

describe('event id collisions (INV-11)', () => {
  it('throws rather than repairing positionally', () => {
    const scenario = tinyScenario(
      {
        parent: (_d, _e, ctx) => {
          ctx.emit({ type: 'payment.attempted', entityId: 'ord-1', payload: {} });
          ctx.emit({ type: 'payment.attempted', entityId: 'ord-1', payload: {} });
        },
        'payment.attempted': () => {},
      },
      [{ key: 'p', type: 'parent', virtualTime: 10, payload: {} }],
    );
    const sim = createSimulation({ scenario, seed: 's' });
    try {
      sim.runNext();
      throw new Error('should have thrown');
    } catch (e) {
      expect(isAliveError(e, 'ALIVE_EVENT_ID_COLLISION')).toBe(true);
      expect((e as Error).message).toMatch(/key|slot/);
    }
    expect(sim.getCommits()).toHaveLength(0);
  });

  it('is resolved by an explicit domain key', () => {
    const scenario = tinyScenario(
      {
        parent: (_d, _e, ctx) => {
          ctx.emit({ type: 'payment.attempted', entityId: 'ord-1', key: 'pay-1', payload: {} });
          ctx.emit({ type: 'payment.attempted', entityId: 'ord-1', key: 'pay-2', payload: {} });
        },
        'payment.attempted': (draft) => void (draft.n += 1),
      },
      [{ key: 'p', type: 'parent', virtualTime: 10, payload: {} }],
    );
    const sim = createSimulation({ scenario, seed: 's' });
    sim.runNext();
    expect(sim.getState().n).toBe(2);
  });
});
