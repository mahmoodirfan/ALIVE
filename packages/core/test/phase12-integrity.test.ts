import { describe, expect, it } from 'vitest';
import { isAliveError } from '../src/errors.js';
import { createSimulation } from '../src/simulation.js';
import type { ExogenousStream, Scenario } from '../src/types.js';
import { PRIORITY } from '../src/types.js';
import { shopScenario, tinyScenario } from './fixtures.js';

describe('Phase 1.2 persistence snapshots', () => {
  it('snapshots a bootstrap payload away from caller-owned references', () => {
    const payload = { value: 1 };
    const scenario = tinyScenario(
      {
        show: (draft, event) => {
          draft.log.push(String((event.payload as { value: number }).value));
        },
      },
      [{ key: 'x', type: 'show', virtualTime: 10, payload }],
    );
    const sim = createSimulation({ scenario, seed: 'snapshot' });
    payload.value = 99;
    sim.runNext();
    expect(sim.getState().log).toEqual(['1']);
  });

  it('snapshots ctx.emit payloads at the moment of emission', () => {
    const shared = { value: 1 };
    const sim = createSimulation({
      scenario: tinyScenario(
        {
          root: (_draft, _event, ctx) => {
            ctx.emit({ type: 'child', payload: shared, slot: 'child' });
            shared.value = 99;
          },
          child: (draft, event) => {
            draft.log.push(String((event.payload as { value: number }).value));
          },
        },
        [{ key: 'root', type: 'root', virtualTime: 10, payload: {} }],
      ),
      seed: 'snapshot',
    });
    sim.runNext();
    expect(shared.value).toBe(99);
    expect(sim.getState().log).toEqual(['1']);
  });

  it('snapshots ctx.schedule payloads at the moment of scheduling', () => {
    const shared = { value: 1 };
    const sim = createSimulation({
      scenario: tinyScenario(
        {
          root: (_draft, _event, ctx) => {
            ctx.schedule({ type: 'later', virtualTime: 20, payload: shared, key: 'later' });
            shared.value = 99;
          },
          later: (draft, event) => {
            draft.log.push(String((event.payload as { value: number }).value));
          },
        },
        [{ key: 'root', type: 'root', virtualTime: 10, payload: {} }],
      ),
      seed: 'snapshot',
    });
    sim.runNext();
    const pending = sim.getPendingSources()[0]!;
    if (pending.kind !== 'scheduled') throw new Error('expected scheduled source');
    expect((pending.item.payload as { value: number }).value).toBe(1);
    sim.runNext();
    expect(sim.getState().log).toEqual(['1']);
  });

  it('snapshots exogenous payloads before they enter the frontier', () => {
    const shared = { value: 1 };
    const stream: ExogenousStream = {
      id: 'exo',
      from: 0,
      next: ({ ordinal }) =>
        ordinal === 0
          ? { virtualTime: 10, type: 'show', payload: shared, actorId: 'a' }
          : null,
    };
    const scenario: Scenario<{ log: string[] }> = {
      id: 'exo-snapshot',
      version: '1',
      name: 'Exo Snapshot',
      epoch: '2026-01-01T00:00:00.000Z',
      initialState: () => ({ log: [] }),
      events: {
        show: (draft, event) => {
          draft.log.push(String((event.payload as { value: number }).value));
        },
      },
      commands: {},
      exogenous: [stream],
    };
    const sim = createSimulation({ scenario, seed: 'snapshot' });
    shared.value = 99;
    sim.runNext();
    expect(sim.getState().log).toEqual(['1']);
  });
});

describe('Phase 1.2 public read integrity', () => {
  it('pending sources cannot be used to corrupt heap ordering or payloads', () => {
    const sim = createSimulation({ scenario: shopScenario(), seed: 'integrity' });
    const pending = sim.getPendingSources();
    expect(Object.isFrozen(pending)).toBe(true);
    expect(Object.isFrozen(pending[0]!.item)).toBe(true);
    expect(() => {
      (pending[0]!.item as { virtualTime: number }).virtualTime = 0;
    }).toThrow(TypeError);
    expect(() => {
      (pending as unknown as unknown[]).pop();
    }).toThrow(TypeError);
    expect(sim.getPendingSources()[0]!.item.virtualTime).toBe(1000);
  });

  it('pending payloads are deeply immutable snapshots', () => {
    const payload = { nested: { value: 1 } };
    const scenario = tinyScenario({ show: () => {} }, [
      { key: 'show', type: 'show', virtualTime: 10, payload },
    ]);
    const sim = createSimulation({ scenario, seed: 'integrity' });
    payload.nested.value = 99;
    const pending = sim.getPendingSources()[0]!;
    if (pending.kind !== 'scheduled') throw new Error('expected scheduled source');
    expect(Object.isFrozen(pending.item.payload)).toBe(true);
    expect(Object.isFrozen((pending.item.payload as { nested: object }).nested)).toBe(true);
    expect((pending.item.payload as { nested: { value: number } }).nested.value).toBe(1);
    expect(() => {
      (pending.item.payload as { nested: { value: number } }).nested.value = 7;
    }).toThrow(TypeError);
  });

  it('scenario registries are detached from caller mutations after construction', () => {
    const events: Scenario<{ log: string[] }>['events'] = {
      root: (draft) => draft.log.push('original'),
    };
    const scenario: Scenario<{ log: string[] }> = {
      id: 'scenario-snapshot',
      version: '1',
      name: 'Scenario Snapshot',
      epoch: '2026-01-01T00:00:00.000Z',
      initialState: () => ({ log: [] }),
      events,
      commands: {},
      bootstrap: [{ key: 'root', type: 'root', virtualTime: 10, payload: {} }],
    };
    const sim = createSimulation({ scenario, seed: 'integrity' });
    events.root = (draft) => draft.log.push('mutated');
    sim.runNext();
    expect(sim.getState().log).toEqual(['original']);
  });

  it('commit-log outer arrays cannot be used to delete history', () => {
    const sim = createSimulation({ scenario: shopScenario(), seed: 'integrity' });
    sim.runNext();
    const commits = sim.getCommits();
    expect(Object.isFrozen(commits)).toBe(true);
    expect(Object.isFrozen(commits[0]!)).toBe(true);
    expect(() => {
      (commits as unknown as unknown[]).splice(0);
    }).toThrow(TypeError);
    expect(sim.getCommits()).toHaveLength(1);
  });

  it('represents an unused instant guard without an invalid virtual timestamp', () => {
    const sim = createSimulation({ scenario: tinyScenario({}, []), seed: 'integrity' });
    expect(sim.getInstantGuard()).toEqual({ at: null, count: 0 });
  });

  it('instant guard and cursor reads are immutable snapshots', () => {
    const sim = createSimulation({ scenario: shopScenario(), seed: 'integrity' });
    sim.runNext();
    const guard = sim.getInstantGuard();
    const cursor = sim.getCursor();
    expect(Object.isFrozen(guard)).toBe(true);
    expect(Object.isFrozen(cursor)).toBe(true);
    expect(() => {
      (guard as { count: number }).count = -1000;
    }).toThrow(TypeError);
    expect(sim.getInstantGuard().count).toBe(1);
  });
});

describe('Phase 1.2 rule purity', () => {
  it('rules receive an immutable cumulative state snapshot', () => {
    const scenario: Scenario<{ n: number; seen: number[] }> = {
      id: 'rule-state',
      version: '1',
      name: 'Rule State',
      epoch: '2026-01-01T00:00:00.000Z',
      initialState: () => ({ n: 0, seen: [] }),
      events: {
        root: (draft) => {
          draft.n = 1;
        },
        seen: (draft, event) => {
          draft.seen.push((event.payload as { n: number }).n);
        },
      },
      commands: {},
      rules: [
        {
          id: 'observe',
          when: 'root',
          emit: (state) => [{ type: 'seen', payload: { n: state.n }, slot: 'observe' }],
        },
      ],
      bootstrap: [{ key: 'root', type: 'root', virtualTime: 10, payload: {} }],
    };
    const sim = createSimulation({ scenario, seed: 'rules' });
    sim.runNext();
    expect(sim.getState()).toEqual({ n: 1, seen: [1] });
  });

  it('a malicious rule cannot mutate world state directly', () => {
    const scenario: Scenario<{ n: number }> = {
      id: 'rule-purity',
      version: '1',
      name: 'Rule Purity',
      epoch: '2026-01-01T00:00:00.000Z',
      initialState: () => ({ n: 0 }),
      events: {
        root: (draft) => {
          draft.n = 1;
        },
      },
      commands: {},
      rules: [
        {
          id: 'malicious',
          when: 'root',
          emit: (state) => {
            (state as { n: number }).n = 999;
            return [];
          },
        },
      ],
      bootstrap: [{ key: 'root', type: 'root', virtualTime: 10, payload: {} }],
    };
    const sim = createSimulation({ scenario, seed: 'rules' });
    expect(() => sim.runNext()).toThrow(TypeError);
    expect(sim.getState().n).toBe(0);
    expect(sim.getCommits()).toHaveLength(0);
    expect(sim.getRunState()).toBe('faulted');
  });
});

describe('Phase 1.2 reserved intervention ordering', () => {
  it('dispatch at a same-time frontier outranks remaining scheduled work by reserved priority', () => {
    const scenario: Scenario<{ log: string[] }> = {
      id: 'same-time',
      version: '1',
      name: 'Same Time',
      epoch: '2026-01-01T00:00:00.000Z',
      initialState: () => ({ log: [] }),
      events: {
        scheduled: (draft, event) => draft.log.push(`scheduled:${event.key}`),
        intervention: (draft) => draft.log.push('intervention'),
      },
      commands: {
        intervene: {
          events: () => [{ type: 'intervention', payload: {} }],
        },
      },
      bootstrap: [
        { key: 'a', type: 'scheduled', virtualTime: 100, priority: PRIORITY.domain, payload: {} },
        { key: 'b', type: 'scheduled', virtualTime: 100, priority: PRIORITY.domain, payload: {} },
      ],
    };
    const sim = createSimulation({ scenario, seed: 'order' });
    sim.runNext();
    expect(sim.getState().log).toEqual(['scheduled:a']);
    expect(sim.getPendingSources()[0]!.item.virtualTime).toBe(100);
    const r = sim.dispatch({ type: 'intervene', payload: {} });
    expect(r.accepted).toBe(true);
    sim.runNext();
    expect(sim.getState().log).toEqual(['scheduled:a', 'intervention', 'scheduled:b']);
    expect(sim.getCommits().map((c) => c.schedulerTuple.priority)).toEqual([
      PRIORITY.domain,
      PRIORITY.intervention,
      PRIORITY.domain,
    ]);
  });

  it('rejects bootstrap priority zero at construction', () => {
    const scenario = tinyScenario({ root: () => {} }, [
      { key: 'root', type: 'root', virtualTime: 10, priority: 0, payload: {} },
    ]);
    try {
      createSimulation({ scenario, seed: 'order' });
      throw new Error('should have thrown');
    } catch (error) {
      expect(isAliveError(error, 'ALIVE_INVALID_SCENARIO')).toBe(true);
    }
  });
});

describe('Phase 1.2 safe integer time domain', () => {
  it.each([0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, -1])(
    'rejects invalid bootstrap virtualTime %s',
    (virtualTime: number) => {
      const scenario = tinyScenario({ root: () => {} }, [
        { key: 'root', type: 'root', virtualTime, payload: {} },
      ]);
      expect(() => createSimulation({ scenario, seed: 'time' })).toThrowError(
        /ALIVE_INVALID_SCENARIO/,
      );
    },
  );

  it('rejects a fractional exogenous time before enqueue', () => {
    const stream: ExogenousStream = {
      id: 'fractional',
      from: 0,
      next: () => ({ virtualTime: 10.5, type: 'tick', payload: {} }),
    };
    const scenario: Scenario<{ n: number }> = {
      id: 'fractional-exo',
      version: '1',
      name: 'Fractional Exo',
      epoch: '2026-01-01T00:00:00.000Z',
      initialState: () => ({ n: 0 }),
      events: { tick: (draft) => void (draft.n += 1) },
      commands: {},
      exogenous: [stream],
    };
    expect(() => createSimulation({ scenario, seed: 'time' })).toThrowError(/ALIVE_INVALID_TIME/);
  });

  it('rejects fractional handler scheduling and rolls back', () => {
    const sim = createSimulation({
      scenario: tinyScenario(
        {
          root: (draft, _event, ctx) => {
            draft.n = 1;
            ctx.schedule({ type: 'later', virtualTime: 10.5, payload: {}, key: 'later' });
          },
          later: () => {},
        },
        [{ key: 'root', type: 'root', virtualTime: 10, payload: {} }],
      ),
      seed: 'time',
    });
    expect(() => sim.runNext()).toThrowError(/ALIVE_INVALID_TIME/);
    expect(sim.getState().n).toBe(0);
    expect(sim.getCommits()).toHaveLength(0);
  });

  it('rejects fractional and overflowing advance values', () => {
    const sim = createSimulation({ scenario: tinyScenario({}, []), seed: 'time' });
    for (const value of [0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => sim.advance(value)).toThrowError(/ALIVE_INVALID_DURATION/);
    }
    sim.runUntil(Number.MAX_SAFE_INTEGER - 1);
    expect(() => sim.advance(2)).toThrowError(/ALIVE_INVALID_DURATION/);
  });

  it('rejects fractional runUntil targets', () => {
    const sim = createSimulation({ scenario: tinyScenario({}, []), seed: 'time' });
    expect(() => sim.runUntil(10.5)).toThrowError(/ALIVE_INVALID_TIME/);
  });

  it('rejects fractional and negative scheduled priorities', () => {
    for (const priority of [1.5, -1, 0]) {
      const sim = createSimulation({
        scenario: tinyScenario(
          {
            root: (_draft, _event, ctx) => {
              ctx.schedule({ type: 'later', virtualTime: 20, priority, payload: {}, key: 'x' });
            },
            later: () => {},
          },
          [{ key: 'root', type: 'root', virtualTime: 10, payload: {} }],
        ),
        seed: 'priority',
      });
      expect(() => sim.runNext()).toThrowError(/ALIVE_INVALID_PRIORITY/);
      expect(sim.getCommits()).toHaveLength(0);
    }
  });
});

describe('Phase 1.2 reschedule time validation', () => {
  it('rejects a fractional reschedule target and preserves the original item', () => {
    let victimId = '';
    const scenario = tinyScenario(
      {
        setup: (_draft, _event, ctx) => {
          victimId = ctx.schedule({ type: 'later', virtualTime: 100, payload: {}, key: 'later' });
        },
        move: (_draft, _event, ctx) => {
          ctx.reschedule(victimId, 50.5);
        },
        later: () => {},
      },
      [
        { key: 'setup', type: 'setup', virtualTime: 10, payload: {} },
        { key: 'move', type: 'move', virtualTime: 20, payload: {} },
      ],
    );
    const sim = createSimulation({ scenario, seed: 'reschedule' });
    sim.runNext();
    expect(() => sim.runNext()).toThrowError(/ALIVE_INVALID_TIME/);
    expect(sim.getPendingSources().some((s) => s.item.virtualTime === 100)).toBe(true);
  });
});
