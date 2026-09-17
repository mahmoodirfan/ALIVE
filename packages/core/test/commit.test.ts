import { describe, expect, it, vi } from 'vitest';
import { createSimulation } from '../src/simulation.js';
import { isAliveError } from '../src/errors.js';
import { PRIORITY } from '../src/types.js';
import type { CommitNotification, Scenario } from '../src/types.js';
import { shopScenario, tinyScenario } from './fixtures.js';

describe('commit transaction (INV-19/20/21)', () => {
  it('rolls back world, queue, sequence, logs and notifications when a child throws', () => {
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
      [{ key: 'p', type: 'parent', virtualTime: 100, payload: {} }],
    );
    const sim = createSimulation({ scenario, seed: 's' });

    const before = {
      world: structuredClone(sim.getState()),
      pending: sim.getPendingSources().length,
      sequence: sim.getNextSequence(),
      commits: sim.getCommits().length,
      events: sim.getEvents().length,
      guard: { ...sim.getInstantGuard() },
    };
    const seen: CommitNotification[] = [];
    sim.on('committed', (n) => seen.push(n));

    expect(() => sim.advance(1000)).toThrowError(/child exploded/);

    expect(sim.getState()).toEqual(before.world);
    expect(sim.getNextSequence()).toBe(before.sequence);
    expect(sim.getCommits()).toHaveLength(before.commits);
    expect(sim.getEvents()).toHaveLength(before.events);
    expect(sim.getInstantGuard()).toEqual(before.guard);
    expect(seen).toHaveLength(0);
    // the staged future item never entered the queue
    expect(sim.getPendingSources().some((s) => s.item.virtualTime === 9999)).toBe(false);
    expect(sim.getRunState()).toBe('faulted');
  });

  it('keeps the original error inspectable and does not auto-retry (Clarification C)', () => {
    let runs = 0;
    const scenario = tinyScenario(
      {
        boom: () => {
          runs += 1;
          throw new Error('poison');
        },
      },
      [{ key: 'b', type: 'boom', virtualTime: 10, payload: {} }],
    );
    const sim = createSimulation({ scenario, seed: 's' });
    expect(() => sim.advance(100)).toThrowError(/poison/);
    expect(runs).toBe(1);

    for (const call of [() => sim.advance(1), () => sim.runNext(), () => sim.runUntil(500)]) {
      expect(call).toThrowError(/ALIVE_FAULTED/);
    }
    expect(() => sim.dispatch({ type: 'anything', payload: {} })).toThrowError(/ALIVE_FAULTED/);
    expect(runs).toBe(1);
    const fault = sim.getFault()!;
    expect((fault.originalError as Error).message).toBe('poison');
    expect(fault.sourceKind).toBe('scheduled');
    expect(fault.attemptedVirtualTime).toBe(10);
    expect(fault.sourceId).toMatch(/^sch:/);
  });

  it('rolls back a cancellation as well as an addition', () => {
    const scenario = tinyScenario(
      {
        setup: (_d, _e, ctx) => {
          ctx.schedule({ type: 'victim', virtualTime: 500, payload: {}, key: 'v' });
        },
        killer: (_d, _e, ctx) => {
          const pending = 'unused';
          void pending;
          ctx.cancel(sharedId);
          throw new Error('after cancel');
        },
        victim: (draft) => {
          draft.log.push('victim ran');
        },
      },
      [
        { key: 's', type: 'setup', virtualTime: 10, payload: {} },
        { key: 'k', type: 'killer', virtualTime: 20, payload: {} },
      ],
    );
    let sharedId = '';
    const sim = createSimulation({ scenario, seed: 's' });
    sim.runNext(); // setup schedules victim
    sharedId = sim.getPendingSources().find((s) => s.item.virtualTime === 500)?.item
      ? (sim.getPendingSources().find((s) => s.item.virtualTime === 500) as { item: { scheduledId: string } }).item.scheduledId
      : '';
    expect(sharedId).not.toBe('');
    expect(() => sim.runNext()).toThrowError(/after cancel/);
    // the victim survived the rolled-back cancellation
    expect(sim.getPendingSources().some((s) => s.item.virtualTime === 500)).toBe(true);
  });

  it('applies the whole cascade in one world transition', () => {
    const sim = createSimulation({ scenario: shopScenario(), seed: 'seed-A' });
    const notifications: CommitNotification[] = [];
    sim.on('committed', (n) => notifications.push(n));
    sim.advance(5000);
    for (const n of notifications) {
      // every event in a batch shares one commit id and one timestamp
      expect(new Set(n.events.map((e) => e.commitId))).toEqual(new Set([n.commitId]));
      expect(new Set(n.events.map((e) => e.virtualTime))).toEqual(new Set([n.virtualTime]));
    }
  });

  it('notifications carry no transport concepts (INV-26)', () => {
    const sim = createSimulation({ scenario: shopScenario(), seed: 'seed-A' });
    const seen: CommitNotification[] = [];
    sim.on('committed', (n) => seen.push(n));
    sim.advance(5000);
    expect(seen.length).toBeGreaterThan(0);
    for (const n of seen) {
      expect(Object.keys(n).sort()).toEqual(['branchId', 'commitId', 'events', 'virtualTime']);
    }
  });

  it('flushes notifications once per call, in commit order', () => {
    const sim = createSimulation({ scenario: shopScenario(), seed: 'seed-A' });
    const order: string[] = [];
    sim.on('committed', (n) => order.push(n.commitId));
    sim.advance(5000);
    expect(order).toEqual(sim.getCommits().map((c) => c.commitId));
  });

  it('unsubscribes cleanly', () => {
    const sim = createSimulation({ scenario: shopScenario(), seed: 'seed-A' });
    const fn = vi.fn();
    const off = sim.on('committed', fn);
    sim.runNext();
    const after = fn.mock.calls.length;
    off();
    sim.advance(5000);
    expect(fn.mock.calls.length).toBe(after);
  });
});

describe('cascade order and causality (INV-24/14)', () => {
  it('runs handler, then its children, then rules in declaration order', () => {
    const scenario: Scenario<{ n: number; log: string[] }> = {
      ...tinyScenario(
        {
          root: (draft, _e, ctx) => {
            draft.log.push('root');
            ctx.emit({ type: 'childA', payload: {}, slot: 'a' });
            ctx.emit({ type: 'childB', payload: {}, slot: 'b' });
          },
          childA: (draft) => void draft.log.push('childA'),
          childB: (draft) => void draft.log.push('childB'),
          ruleOne: (draft) => void draft.log.push('ruleOne'),
          ruleTwo: (draft) => void draft.log.push('ruleTwo'),
        },
        [{ key: 'r', type: 'root', virtualTime: 10, payload: {} }],
      ),
      rules: [
        { id: 'one', when: 'root', emit: () => [{ type: 'ruleOne', payload: {} }] },
        { id: 'two', when: 'root', emit: () => [{ type: 'ruleTwo', payload: {} }] },
      ],
    };
    const sim = createSimulation({ scenario, seed: 's' });
    sim.runNext();
    expect(sim.getState().log).toEqual(['root', 'childA', 'childB', 'ruleOne', 'ruleTwo']);
    const events = sim.getEvents();
    expect(events.map((e) => e.type)).toEqual([
      'root',
      'childA',
      'childB',
      'ruleOne',
      'ruleTwo',
    ]);
    expect(events.map((e) => e.withinCommitOrder)).toEqual([0, 1, 2, 3, 4]);
    expect(events.map((e) => e.depth)).toEqual([0, 1, 1, 1, 1]);
    expect(events.slice(1).every((e) => e.parentEventId === events[0]!.id)).toBe(true);
  });

  it('rules see cumulative draft mutations from the handler (INV-23)', () => {
    const scenario: Scenario<{ n: number; log: string[] }> = {
      ...tinyScenario(
        {
          bump: (draft) => {
            draft.n = 42;
          },
          observed: (draft, e) => {
            draft.log.push(`saw:${(e.payload as { n: number }).n}`);
          },
        },
        [{ key: 'b', type: 'bump', virtualTime: 10, payload: {} }],
      ),
      rules: [
        {
          id: 'watch',
          when: 'bump',
          emit: (state) => [{ type: 'observed', payload: { n: state.n } }],
        },
      ],
    };
    const sim = createSimulation({ scenario, seed: 's' });
    sim.runNext();
    expect(sim.getState().log).toEqual(['saw:42']);
  });

  it('honours rule `if` guards', () => {
    const scenario: Scenario<{ n: number; log: string[] }> = {
      ...tinyScenario(
        {
          tick: (draft) => void (draft.n += 1),
          fired: (draft) => void draft.log.push('fired'),
        },
        [
          { key: 't1', type: 'tick', virtualTime: 10, payload: {} },
          { key: 't2', type: 'tick', virtualTime: 20, payload: {} },
        ],
      ),
      rules: [
        {
          id: 'gate',
          when: 'tick',
          if: (state) => state.n >= 2,
          emit: () => [{ type: 'fired', payload: {} }],
        },
      ],
    };
    const sim = createSimulation({ scenario, seed: 's' });
    sim.advance(100);
    expect(sim.getState().log).toEqual(['fired']);
  });

  it('sets causeId to the commit id for root events and parent id for children', () => {
    const sim = createSimulation({ scenario: shopScenario(), seed: 'seed-A' });
    sim.advance(5000);
    for (const c of sim.getCommits()) {
      const root = c.events[0]!;
      expect(root.causeId).toBe(c.commitId);
      for (const child of c.events.slice(1)) {
        expect(child.causeId).toBe(child.parentEventId);
      }
    }
  });
});

describe('safety limits (INV-22/74)', () => {
  it('enforces maxCausalDepth transactionally', () => {
    const scenario = tinyScenario(
      {
        deep: (draft, _e, ctx) => {
          draft.n += 1;
          ctx.emit({ type: 'deep', payload: {}, slot: `d${draft.n}` });
        },
      },
      [{ key: 'd', type: 'deep', virtualTime: 10, payload: {} }],
    );
    const sim = createSimulation({ scenario, seed: 's', limits: { maxCausalDepth: 5 } });
    try {
      sim.runNext();
      throw new Error('should have thrown');
    } catch (e) {
      expect(isAliveError(e, 'ALIVE_CASCADE_LIMIT')).toBe(true);
      expect((e as { details: { limit: string } }).details.limit).toBe('maxCausalDepth');
    }
    expect(sim.getState().n).toBe(0);
    expect(sim.getCommits()).toHaveLength(0);
  });

  it('enforces maxEventsPerCommit transactionally', () => {
    const scenario = tinyScenario(
      {
        fan: (_d, _e, ctx) => {
          for (let i = 0; i < 20; i++) ctx.emit({ type: 'leaf', payload: {}, slot: `l${i}` });
        },
        leaf: () => {},
      },
      [{ key: 'f', type: 'fan', virtualTime: 10, payload: {} }],
    );
    const sim = createSimulation({ scenario, seed: 's', limits: { maxEventsPerCommit: 10 } });
    try {
      sim.runNext();
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as { details: { limit: string } }).details.limit).toBe('maxEventsPerCommit');
    }
    expect(sim.getCommits()).toHaveLength(0);
  });

  it('maxCommitsPerInstant survives runNext boundaries identically to advance', () => {
    const make = () =>
      createSimulation({
        scenario: tinyScenario(
          { same: (draft) => void (draft.n += 1) },
          Array.from({ length: 10 }, (_, i) => ({
            key: `k${i}`,
            type: 'same',
            virtualTime: 500,
            priority: PRIORITY.domain,
            payload: {},
          })),
        ),
        seed: 's',
        limits: { maxCommitsPerInstant: 4 },
      });

    const viaAdvance = make();
    expect(() => viaAdvance.advance(1000)).toThrowError(/maxCommitsPerInstant/);
    const advanceCommits = viaAdvance.getCommits().length;

    const viaSteps = make();
    let steps = 0;
    expect(() => {
      for (let i = 0; i < 10; i++) {
        viaSteps.runNext();
        steps++;
      }
    }).toThrowError(/maxCommitsPerInstant/);

    expect(advanceCommits).toBe(4);
    expect(viaSteps.getCommits().length).toBe(4);
    expect(steps).toBe(4);
  });

  it('resets the instant guard when time moves on', () => {
    const sim = createSimulation({
      scenario: tinyScenario(
        { t: (draft) => void (draft.n += 1) },
        [
          { key: 'a', type: 't', virtualTime: 100, payload: {} },
          { key: 'b', type: 't', virtualTime: 100, payload: {} },
          { key: 'c', type: 't', virtualTime: 200, payload: {} },
        ],
      ),
      seed: 's',
    });
    sim.advance(50);
    expect(sim.getInstantGuard().count).toBe(0);
    sim.runNext();
    sim.runNext();
    expect(sim.getInstantGuard()).toEqual({ at: 100, count: 2 });
    sim.runNext();
    expect(sim.getInstantGuard()).toEqual({ at: 200, count: 1 });
  });
});

describe('JSON contract enforcement at commit (INV-58)', () => {
  it('faults when a handler writes a non-JSON value into world state', () => {
    const scenario = tinyScenario(
      {
        bad: (draft) => {
          (draft as unknown as { when: unknown }).when = new Date();
        },
      },
      [{ key: 'b', type: 'bad', virtualTime: 10, payload: {} }],
    );
    const sim = createSimulation({ scenario, seed: 's' });
    try {
      sim.runNext();
      throw new Error('should have thrown');
    } catch (e) {
      expect(isAliveError(e, 'ALIVE_NON_JSON_VALUE')).toBe(true);
    }
    expect(sim.getCommits()).toHaveLength(0);
    expect(sim.getRunState()).toBe('faulted');
  });
});
