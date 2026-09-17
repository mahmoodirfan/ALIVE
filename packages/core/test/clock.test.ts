import { describe, expect, it } from 'vitest';
import { createSimulation } from '../src/simulation.js';
import { isAliveError } from '../src/errors.js';
import { shopScenario, tinyScenario } from './fixtures.js';

const ticks = (times: number[]) =>
  tinyScenario(
    { tick: (draft, e) => void draft.log.push(`t${e.virtualTime}`) },
    times.map((t, i) => ({ key: `k${i}`, type: 'tick', virtualTime: t, payload: {} })),
  );

describe('virtual clock (INV-72/73)', () => {
  it('advance reaches the target across an interval with no work', () => {
    const sim = createSimulation({ scenario: ticks([100]), seed: 's' });
    const r = sim.advance(50_000);
    expect(r.stoppedBecause).toBe('target-reached');
    expect(sim.getTime()).toBe(50_000);
    expect(r.commits).toBe(1);

    // and again, from an empty queue
    const r2 = sim.advance(10_000);
    expect(r2.commits).toBe(0);
    expect(sim.getTime()).toBe(60_000);
  });

  it('runUntil reaches a target beyond the last event', () => {
    const sim = createSimulation({ scenario: ticks([100, 200]), seed: 's' });
    sim.runUntil(14_000);
    expect(sim.getTime()).toBe(14_000);
    expect(sim.getState().log).toEqual(['t100', 't200']);
  });

  it('is inclusive at the target', () => {
    const sim = createSimulation({ scenario: ticks([1000]), seed: 's' });
    sim.advance(1000);
    expect(sim.getState().log).toEqual(['t1000']);
    expect(sim.getTime()).toBe(1000);
  });

  it('excludes work strictly after the target', () => {
    const sim = createSimulation({ scenario: ticks([1000, 1001]), seed: 's' });
    sim.advance(1000);
    expect(sim.getState().log).toEqual(['t1000']);
  });

  it('rejects backward runUntil and directs to scrub', () => {
    const sim = createSimulation({ scenario: ticks([100]), seed: 's' });
    sim.advance(5000);
    try {
      sim.runUntil(1000);
      throw new Error('should have thrown');
    } catch (e) {
      expect(isAliveError(e, 'ALIVE_BACKWARD_RUN')).toBe(true);
      expect((e as Error).message).toMatch(/scrub/);
    }
    expect(sim.getTime()).toBe(5000);
  });

  it('accepts runUntil exactly at head time as a no-op', () => {
    const sim = createSimulation({ scenario: ticks([100]), seed: 's' });
    sim.advance(5000);
    const r = sim.runUntil(5000);
    expect(r.commits).toBe(0);
    expect(sim.getTime()).toBe(5000);
  });

  it('rejects negative and non-finite durations', () => {
    const sim = createSimulation({ scenario: ticks([100]), seed: 's' });
    for (const bad of [-1, NaN, Infinity]) {
      expect(() => sim.advance(bad)).toThrowError(/ALIVE_INVALID_DURATION/);
    }
  });

  it('runNext moves head to the source time and reports no-work without moving it', () => {
    const sim = createSimulation({ scenario: ticks([100, 250]), seed: 's' });
    const a = sim.runNext();
    expect(a).toMatchObject({ committed: true, virtualTime: 100, stoppedBecause: 'committed' });
    const b = sim.runNext();
    expect(b.virtualTime).toBe(250);
    const c = sim.runNext();
    expect(c).toMatchObject({ committed: false, stoppedBecause: 'no-work', virtualTime: 250 });
    expect(sim.getTime()).toBe(250);
  });

  it('runNext cannot cross an empty interval — only advance can', () => {
    const sim = createSimulation({ scenario: ticks([]), seed: 's' });
    sim.runNext();
    expect(sim.getTime()).toBe(0);
    sim.advance(9000);
    expect(sim.getTime()).toBe(9000);
  });

  it('caps at scenario end', () => {
    const sim = createSimulation({
      scenario: { ...ticks([100, 900]), endTime: 500 },
      seed: 's',
    });
    const r = sim.advance(10_000);
    expect(r.stoppedBecause).toBe('scenario-end');
    expect(sim.getTime()).toBe(500);
    expect(sim.getRunState()).toBe('ended');
    expect(sim.getState().log).toEqual(['t100']);
  });

  it('runUntil crosses an empty interval to a target beyond all work', () => {
    const sim = createSimulation({ scenario: ticks([100, 200]), seed: 's' });
    sim.runUntil(500);
    const r = sim.runUntil(50_000);
    expect(r.commits).toBe(0);
    expect(r.stoppedBecause).toBe('target-reached');
    expect(sim.getTime()).toBe(50_000);
  });
});

describe('advance slicing equivalence (INV-22)', () => {
  const snapshot = (sim: ReturnType<typeof createSimulation<never>>) => ({
    state: sim.getState(),
    commitIds: sim.getCommits().map((c) => c.commitId),
    eventIds: sim.getEvents().map((e) => e.id),
    times: sim.getEvents().map((e) => e.virtualTime),
    order: sim.getEvents().map((e) => e.withinCommitOrder),
    time: sim.getTime(),
    sequence: sim.getNextSequence(),
  });

  it('compares semantic history, not only final world state', () => {
    const one = createSimulation({ scenario: shopScenario(), seed: 'slice' });
    one.advance(6000);
    const two = createSimulation({ scenario: shopScenario(), seed: 'slice' });
    two.advance(3000);
    two.advance(3000);
    const history = (s: ReturnType<typeof createSimulation>) =>
      s.getCommits().map((c) => ({
        commitId: c.commitId,
        virtualTime: c.virtualTime,
        tuple: c.schedulerTuple,
        events: c.events.map((e) => [e.id, e.type, e.withinCommitOrder, e.depth]),
      }));
    expect(history(two as never)).toEqual(history(one as never));
  });

  it('advance(60) equals advance(30) twice', () => {
    const one = createSimulation({ scenario: shopScenario(), seed: 'slice' });
    one.advance(6000);
    const two = createSimulation({ scenario: shopScenario(), seed: 'slice' });
    two.advance(3000);
    two.advance(3000);
    expect(snapshot(two as never)).toEqual(snapshot(one as never));
  });

  it('advance equals many small slices and equals repeated runNext plus a final advance', () => {
    const bulk = createSimulation({ scenario: shopScenario(), seed: 'slice' });
    bulk.advance(6000);

    const sliced = createSimulation({ scenario: shopScenario(), seed: 'slice' });
    for (let i = 0; i < 60; i++) sliced.advance(100);

    const stepped = createSimulation({ scenario: shopScenario(), seed: 'slice' });
    for (;;) {
      const r = stepped.runNext();
      if (!r.committed || r.virtualTime > 6000) break;
    }
    stepped.runUntil(6000);

    expect(snapshot(sliced as never)).toEqual(snapshot(bulk as never));
    expect(snapshot(stepped as never).state).toEqual(snapshot(bulk as never).state);
    expect(snapshot(stepped as never).eventIds).toEqual(snapshot(bulk as never).eventIds);
  });
});
