/** JSON-safe payload contract at every boundary (items 6-7). */
import { describe, expect, it } from 'vitest';
import { createSimulation } from '../src/simulation.js';
import { isAliveError, type AliveErrorCode } from '../src/errors.js';
import type { BootstrapItem, ExogenousStream, Scenario } from '../src/types.js';
import type { JsonValue } from '../src/json.js';
import { shopScenario, tinyScenario } from './fixtures.js';

function expectAlive(fn: () => unknown, code: AliveErrorCode): { details: Record<string, unknown> } {
  try {
    fn();
  } catch (e) {
    expect(isAliveError(e, code)).toBe(true);
    return e as { details: Record<string, unknown> };
  }
  throw new Error(`expected ${code}`);
}

const snap = (sim: ReturnType<typeof createSimulation<never>>) => ({
  world: structuredClone(sim.getState()),
  pending: structuredClone(sim.getPendingSources()),
  sequence: sim.getNextSequence(),
  commits: sim.getCommits().length,
});

describe('payload contract (INV-58)', () => {
  it('accepts a JSON-safe bootstrap payload', () => {
    const sim = createSimulation({
      scenario: tinyScenario({ go: (draft) => void (draft.n += 1) }, [
        { key: 'a', type: 'go', virtualTime: 10, payload: { nested: [1, 'two', null, true] } },
      ]),
      seed: 's',
    });
    sim.advance(100);
    expect(sim.getState().n).toBe(1);
  });

  it('rejects a Date in a bootstrap payload at createSimulation', () => {
    const e = expectAlive(
      () =>
        createSimulation({
          scenario: tinyScenario({ go: () => {} }, [
            { key: 'a', type: 'go', virtualTime: 10, payload: { when: new Date() } as never },
          ]),
          seed: 's',
        }),
      'ALIVE_NON_JSON_VALUE',
    );
    expect(e.details.path).toBe('bootstrap[0].payload.when');
  });

  it('rejects a non-JSON initial state at createSimulation', () => {
    const scenario: Scenario<{ m: Map<string, number> }> = {
      id: 'x',
      version: '1',
      name: 'x',
      epoch: '2026-01-01T00:00:00.000Z',
      initialState: () => ({ m: new Map() }),
      events: {},
      commands: {},
    };
    const e = expectAlive(() => createSimulation({ scenario, seed: 's' }), 'ALIVE_NON_JSON_VALUE');
    expect(String(e.details.path)).toContain('initialState');
  });

  it('rejects a Map in an exogenous payload before it is enqueued', () => {
    const stream: ExogenousStream = {
      id: 'arrivals',
      from: 0,
      next: ({ lastTime }) => ({
        virtualTime: lastTime + 10,
        type: 'tick',
        payload: { bad: new Map() } as never,
      }),
    };
    const scenario: Scenario<{ n: number; log: string[] }> = {
      ...tinyScenario({ tick: () => {} }),
      exogenous: [stream],
    };
    const e = expectAlive(() => createSimulation({ scenario, seed: 's' }), 'ALIVE_NON_JSON_VALUE');
    expect(String(e.details.path)).toContain('exogenous(arrivals#0).payload');
  });

  it('faults and rolls back on undefined in a ctx.emit payload', () => {
    const sim = createSimulation({
      scenario: tinyScenario(
        {
          root: (draft, _e, ctx) => {
            draft.n += 1;
            ctx.emit({ type: 'leaf', payload: { v: undefined } as never, slot: 'l' });
          },
          leaf: () => {},
        },
        [{ key: 'r', type: 'root', virtualTime: 10, payload: {} }],
      ),
      seed: 's',
    });
    const before = snap(sim as never);
    const e = expectAlive(() => sim.runNext(), 'ALIVE_NON_JSON_VALUE');
    expect(String(e.details.path)).toContain('event(leaf).payload');
    expect(snap(sim as never)).toEqual(before);
    expect(sim.getRunState()).toBe('faulted');
  });

  it('faults and rolls back on BigInt in a ctx.schedule payload', () => {
    const sim = createSimulation({
      scenario: tinyScenario(
        {
          root: (draft, _e, ctx) => {
            draft.n += 1;
            ctx.schedule({ type: 'later', virtualTime: 500, payload: { v: 1n } as never });
          },
          later: () => {},
        },
        [{ key: 'r', type: 'root', virtualTime: 10, payload: {} }],
      ),
      seed: 's',
    });
    const before = snap(sim as never);
    const e = expectAlive(() => sim.runNext(), 'ALIVE_NON_JSON_VALUE');
    expect(String(e.details.path)).toContain('scheduled(later).payload');
    expect(snap(sim as never)).toEqual(before);
  });

  it('faults and rolls back on NaN from a rule-emitted event', () => {
    const scenario: Scenario<{ n: number; log: string[] }> = {
      ...tinyScenario({ root: (draft) => void (draft.n += 1), derived: () => {} }, [
        { key: 'r', type: 'root', virtualTime: 10, payload: {} },
      ]),
      rules: [
        {
          id: 'bad',
          when: 'root',
          emit: () => [{ type: 'derived', payload: { v: NaN } as never }],
        },
      ],
    };
    const sim = createSimulation({ scenario, seed: 's' });
    const before = snap(sim as never);
    const e = expectAlive(() => sim.runNext(), 'ALIVE_NON_JSON_VALUE');
    expect(String(e.details.path)).toContain('event(derived).payload');
    expect(snap(sim as never)).toEqual(before);
  });

  it('rejects a non-JSON command payload WITHOUT faulting the branch', () => {
    const sim = createSimulation({ scenario: shopScenario(), seed: 'p' });
    const before = snap(sim as never);
    const r = sim.dispatch({
      type: 'product.restock',
      payload: { productId: 'lamp', quantity: Infinity } as never,
    });
    expect(r).toMatchObject({ accepted: false, rejection: { code: 'ALIVE_INVALID_COMMAND' } });
    expect(sim.getRunState()).toBe('ready');
    expect(snap(sim as never)).toEqual(before);

    // ordinal untouched: the next accepted command still derives the ordinal-0 id
    const fresh = createSimulation({ scenario: shopScenario(), seed: 'p' });
    const cmd = { type: 'product.restock', payload: { productId: 'lamp', quantity: 8 } };
    expect(sim.dispatch(cmd).commandId).toBe(fresh.dispatch(cmd).commandId);
  });

  it('never lets an invalid value reach the event or commit log', () => {
    const sim = createSimulation({
      scenario: tinyScenario(
        {
          root: (_d, _e, ctx) => {
            ctx.emit({ type: 'leaf', payload: { v: Infinity } as never, slot: 'l' });
          },
          leaf: () => {},
        },
        [{ key: 'r', type: 'root', virtualTime: 10, payload: {} }],
      ),
      seed: 's',
    });
    expect(() => sim.runNext()).toThrowError(/ALIVE_NON_JSON_VALUE/);
    expect(sim.getEvents()).toHaveLength(0);
    expect(sim.getCommits()).toHaveLength(0);
    expect(() => JSON.stringify(sim.getCommits())).not.toThrow();
  });
});

describe('scenario validation at construction (item 10)', () => {
  const base = tinyScenario({ go: () => {} });

  it('rejects duplicate bootstrap keys', () => {
    expectAlive(
      () =>
        createSimulation({
          scenario: tinyScenario({ go: () => {} }, [
            { key: 'dup', type: 'go', virtualTime: 1, payload: {} },
            { key: 'dup', type: 'go', virtualTime: 2, payload: {} },
          ]),
          seed: 's',
        }),
      'ALIVE_INVALID_SCENARIO',
    );
  });

  it('rejects a missing bootstrap key', () => {
    expectAlive(
      () =>
        createSimulation({
          scenario: tinyScenario({ go: () => {} }, [
            { key: '', type: 'go', virtualTime: 1, payload: {} },
          ]),
          seed: 's',
        }),
      'ALIVE_INVALID_SCENARIO',
    );
  });

  it('rejects duplicate exogenous stream ids', () => {
    const s: ExogenousStream = { id: 'dup', from: 0, next: () => null };
    expectAlive(
      () => createSimulation({ scenario: { ...base, exogenous: [s, { ...s }] }, seed: 's' }),
      'ALIVE_INVALID_SCENARIO',
    );
  });

  it('rejects duplicate rule ids', () => {
    expectAlive(
      () =>
        createSimulation({
          scenario: {
            ...base,
            rules: [
              { id: 'r', when: 'go', emit: () => [] },
              { id: 'r', when: 'go', emit: () => [] },
            ],
          },
          seed: 's',
        }),
      'ALIVE_INVALID_SCENARIO',
    );
  });

  it.each([
    ['non-finite bootstrap virtualTime', [{ key: 'a', type: 'go', virtualTime: NaN, payload: {} }]],
    ['negative bootstrap virtualTime', [{ key: 'a', type: 'go', virtualTime: -1, payload: {} }]],
    [
      'non-finite priority',
      [{ key: 'a', type: 'go', virtualTime: 1, priority: Infinity, payload: {} }],
    ],
  ])('rejects %s', (_label: string, bootstrap: readonly BootstrapItem<JsonValue>[]) => {
    expectAlive(
      () => createSimulation({ scenario: tinyScenario({ go: () => {} }, bootstrap), seed: 's' }),
      'ALIVE_INVALID_SCENARIO',
    );
  });

  it('rejects an invalid scenario endTime and stream window', () => {
    expectAlive(
      () => createSimulation({ scenario: { ...base, endTime: NaN }, seed: 's' }),
      'ALIVE_INVALID_SCENARIO',
    );
    expectAlive(
      () =>
        createSimulation({
          scenario: { ...base, exogenous: [{ id: 'a', from: 100, until: 50, next: () => null }] },
          seed: 's',
        }),
      'ALIVE_INVALID_SCENARIO',
    );
  });

  it('rejects invalid configured limits', () => {
    for (const limits of [{ maxCausalDepth: 0 }, { maxEventsPerCommit: -1 }, { maxCommitsPerInstant: 1.5 }]) {
      expectAlive(
        () => createSimulation({ scenario: base, seed: 's', limits }),
        'ALIVE_INVALID_SCENARIO',
      );
    }
  });

  it('still permits bootstrap work scheduled after scenario.endTime (clock caps it)', () => {
    const sim = createSimulation({
      scenario: {
        ...tinyScenario({ go: (draft) => void (draft.n += 1) }, [
          { key: 'a', type: 'go', virtualTime: 100, payload: {} },
          { key: 'b', type: 'go', virtualTime: 9000, payload: {} },
        ]),
        endTime: 500,
      },
      seed: 's',
    });
    sim.advance(100_000);
    expect(sim.getState().n).toBe(1);
    expect(sim.getTime()).toBe(500);
  });
});
