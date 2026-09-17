/** World-state protection (item 11) and listener-error policy (item 12). */
import { describe, expect, it, vi } from 'vitest';
import { createSimulation } from '../src/simulation.js';
import type { ListenerError } from '../src/simulation.js';
import type { CommitNotification } from '../src/types.js';
import { shopScenario, tinyScenario } from './fixtures.js';

const scenario = () =>
  tinyScenario(
    { go: (draft) => void draft.log.push('go') },
    [
      { key: 'a', type: 'go', virtualTime: 100, payload: {} },
      { key: 'b', type: 'go', virtualTime: 200, payload: {} },
    ],
  );

describe('canonical world state is frozen (item 11)', () => {
  it('cannot be mutated through getState() before the first commit', () => {
    const sim = createSimulation({ scenario: shopScenario(), seed: 'f' });
    const state = sim.getState() as unknown as { products: Record<string, { stock: number }> };
    expect(() => {
      state.products.lamp!.stock = 999;
    }).toThrow(TypeError);
    expect(sim.getState().products.lamp!.stock).toBe(5);
  });

  it('cannot be mutated through getState() after a commit', () => {
    const sim = createSimulation({ scenario: shopScenario(), seed: 'seed-B' });
    sim.advance(5000);
    const before = sim.getState().metrics.revenue;
    const state = sim.getState() as unknown as { metrics: { revenue: number } };
    expect(() => {
      state.metrics.revenue = -1;
    }).toThrow(TypeError);
    expect(sim.getState().metrics.revenue).toBe(before);
  });

  it('freezes nested structures and arrays deeply', () => {
    const sim = createSimulation({ scenario: scenario(), seed: 'f' });
    expect(Object.isFrozen(sim.getState())).toBe(true);
    expect(Object.isFrozen(sim.getState().log)).toBe(true);
    sim.advance(1000);
    expect(Object.isFrozen(sim.getState())).toBe(true);
    expect(Object.isFrozen(sim.getState().log)).toBe(true);
    expect(() => (sim.getState().log as string[]).push('x')).toThrow(TypeError);
  });

  it('events and commit records are frozen against tampering', () => {
    const sim = createSimulation({ scenario: scenario(), seed: 'f' });
    sim.advance(1000);
    const ev = sim.getEvents()[0]!;
    // event payloads originate in scenario data and must not be a mutation channel
    expect(() => {
      (ev as unknown as { type: string }).type = 'hacked';
    }).toThrow(TypeError);
  });
});

describe('listener errors are isolated (item 12)', () => {
  it('a throwing listener does not fault the simulation or undo the commit', () => {
    const sim = createSimulation({ scenario: scenario(), seed: 'f' });
    sim.on('committed', () => {
      throw new Error('UI adapter failed');
    });
    expect(() => sim.advance(1000)).not.toThrow();
    expect(sim.getRunState()).toBe('ready');
    expect(sim.getCommits()).toHaveLength(2);
    expect(sim.getState().log).toEqual(['go', 'go']);
  });

  it('later listeners still receive the notification', () => {
    const sim = createSimulation({ scenario: scenario(), seed: 'f' });
    const before = vi.fn();
    const after = vi.fn();
    sim.on('committed', before);
    sim.on('committed', () => {
      throw new Error('middle listener failed');
    });
    sim.on('committed', after);
    sim.advance(1000);
    expect(before).toHaveBeenCalledTimes(2);
    expect(after).toHaveBeenCalledTimes(2);
  });

  it('surfaces listener failures on the error channel with the commit id', () => {
    const sim = createSimulation({ scenario: scenario(), seed: 'f' });
    const errors: ListenerError[] = [];
    sim.on('error', (e) => errors.push(e));
    const seen: CommitNotification[] = [];
    sim.on('committed', (n) => {
      seen.push(n);
      throw new Error('boom');
    });
    sim.advance(1000);
    expect(errors).toHaveLength(2);
    expect(errors[0]!.channel).toBe('committed');
    expect((errors[0]!.error as Error).message).toBe('boom');
    expect(errors[0]!.commitId).toBe(seen[0]!.commitId);
  });

  it('records listener errors even with no error listener registered', () => {
    const sim = createSimulation({ scenario: scenario(), seed: 'f' });
    sim.on('committed', () => {
      throw new Error('silent');
    });
    sim.advance(1000);
    expect(sim.getListenerErrors()).toHaveLength(2);
    expect(sim.getRunState()).toBe('ready');
  });

  it('an error listener that itself throws is contained', () => {
    const sim = createSimulation({ scenario: scenario(), seed: 'f' });
    sim.on('error', () => {
      throw new Error('error listener failed');
    });
    sim.on('committed', () => {
      throw new Error('boom');
    });
    expect(() => sim.advance(1000)).not.toThrow();
    expect(sim.getCommits()).toHaveLength(2);
  });

  it('a genuine commit failure still throws, unlike a listener failure', () => {
    const sim = createSimulation({
      scenario: tinyScenario({ boom: () => { throw new Error('real'); } }, [
        { key: 'b', type: 'boom', virtualTime: 10, payload: {} },
      ]),
      seed: 'f',
    });
    sim.on('committed', () => {});
    expect(() => sim.advance(1000)).toThrowError(/real/);
    expect(sim.getRunState()).toBe('faulted');
  });
});
