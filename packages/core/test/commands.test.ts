import { describe, expect, it } from 'vitest';
import { createSimulation } from '../src/simulation.js';
import { PRIORITY } from '../src/types.js';
import { deriveCommandId } from '../src/identity.js';
import { shopScenario } from './fixtures.js';

const restock = (quantity = 8, productId = 'lamp') => ({
  type: 'product.restock',
  payload: { productId, quantity },
});

describe('command dispatch (INV-51/76)', () => {
  it('accepts a valid command and mutates world state only through domain events', () => {
    const sim = createSimulation({ scenario: shopScenario(), seed: 'cmd' });
    const before = sim.getState().products.lamp!.stock;
    const r = sim.dispatch(restock(8));
    expect(r.accepted).toBe(true);
    expect(r.commandId).toMatch(/^cmd:/);
    expect(r.commitId).toBe(`commit:${r.commandId}`);
    expect(sim.getState().products.lamp!.stock).toBe(before + 8);
    const commit = sim.getCommits().at(-1)!;
    expect(commit.source.kind).toBe('intervention');
    expect(commit.events.map((e) => e.type)).toEqual(['inventory.restocked']);
    expect(commit.schedulerTuple.priority).toBe(PRIORITY.intervention);
  });

  it('records the anchor at the current head cursor (INV-52)', () => {
    const sim = createSimulation({ scenario: shopScenario(), seed: 'cmd' });
    sim.advance(1500); // commits the 1000ms arrival
    const cursor = sim.getCursor();
    expect(cursor.afterCommitId).not.toBeNull();
    const r = sim.dispatch(restock());
    expect(r.accepted).toBe(true);
    const commit = sim.getCommits().at(-1)!;
    expect(commit.virtualTime).toBe(sim.getTime());
  });

  it('emits events whose ids derive from the commandId', () => {
    const sim = createSimulation({ scenario: shopScenario(), seed: 'cmd' });
    const r = sim.dispatch(restock());
    expect(r.emitted).toHaveLength(1);
    expect(r.emitted![0]!.startsWith('evt:')).toBe(true);
  });

  it('rejects an unknown command without a commit', () => {
    const sim = createSimulation({ scenario: shopScenario(), seed: 'cmd' });
    const r = sim.dispatch({ type: 'nope', payload: {} });
    expect(r).toMatchObject({ accepted: false, rejection: { code: 'ALIVE_UNKNOWN_COMMAND' } });
    expect(sim.getCommits()).toHaveLength(0);
  });

  it('rejects a command failing validation without a commit', () => {
    const sim = createSimulation({ scenario: shopScenario(), seed: 'cmd' });
    expect(sim.dispatch(restock(8, 'ghost'))).toMatchObject({
      accepted: false,
      rejection: { code: 'ALIVE_PRECONDITION_FAILED' },
    });
    expect(sim.dispatch(restock(0))).toMatchObject({
      accepted: false,
      rejection: { code: 'ALIVE_INVALID_COMMAND' },
    });
    expect(sim.getCommits()).toHaveLength(0);
  });

  it('rejects a non-JSON command payload', () => {
    const sim = createSimulation({ scenario: shopScenario(), seed: 'cmd' });
    const r = sim.dispatch({
      type: 'product.restock',
      payload: { productId: 'lamp', quantity: NaN } as never,
    });
    expect(r).toMatchObject({ accepted: false, rejection: { code: 'ALIVE_INVALID_COMMAND' } });
  });

  it('rejected commands consume no sequence, no ordinal and no state', () => {
    const sim = createSimulation({ scenario: shopScenario(), seed: 'cmd' });
    const seqBefore = sim.getNextSequence();
    const stateBefore = structuredClone(sim.getState());
    sim.dispatch(restock(8, 'ghost'));
    sim.dispatch({ type: 'nope', payload: {} });
    expect(sim.getNextSequence()).toBe(seqBefore);
    expect(sim.getState()).toEqual(stateBefore);
    // the next accepted command still gets ordinal 0
    const r = sim.dispatch(restock(8));
    const fresh = createSimulation({ scenario: shopScenario(), seed: 'cmd' });
    expect(r.commandId).toBe(fresh.dispatch(restock(8)).commandId);
  });

  it('a failed command commit faults and consumes no ordinal (Clarification D)', () => {
    const sim = createSimulation({ scenario: shopScenario(), seed: 'cmd' });
    const seqBefore = sim.getNextSequence();
    expect(() => sim.dispatch({ type: 'command.boom', payload: {} })).toThrowError(
      /handler exploded/,
    );
    expect(sim.getRunState()).toBe('faulted');
    expect(sim.getNextSequence()).toBe(seqBefore);
    expect(sim.getCommits()).toHaveLength(0);
  });

  it('increments the ordinal only for accepted commits at the same anchor (Clarification D)', () => {
    const sim = createSimulation({ scenario: shopScenario(), seed: 'cmd' });
    sim.dispatch(restock(8, 'ghost')); // rejected
    const first = sim.dispatch(restock(8));
    sim.dispatch({ type: 'nope', payload: {} }); // rejected
    const second = sim.dispatch(restock(8));
    const third = sim.dispatch(restock(8));

    expect(first.accepted && second.accepted && third.accepted).toBe(true);
    const ids = [first.commandId, second.commandId, third.commandId];
    expect(new Set(ids).size).toBe(3);

    // identical replay of the accepted sequence reproduces identical ids
    const replay = createSimulation({ scenario: shopScenario(), seed: 'cmd' });
    const replayIds = [
      replay.dispatch(restock(8)).commandId,
      replay.dispatch(restock(8)).commandId,
      replay.dispatch(restock(8)).commandId,
    ];
    expect(replayIds).toEqual(ids);
  });

  it('assigns ordinal 0 and a fresh anchor to each accepted command', () => {
    // Finding: an accepted intervention publishes a commit, which moves the head cursor,
    // so the NEXT command anchors after it. Two accepted commands therefore never share
    // an anchor and `nthAtAnchor` stays 0 in practice — the anchor alone disambiguates.
    const sim = createSimulation({ scenario: shopScenario(), seed: 'ord' });
    const anchor0 = sim.getCursor();
    const first = sim.dispatch(restock(8));
    const anchor1 = sim.getCursor();
    const second = sim.dispatch(restock(8));

    expect(anchor1.afterCommitId).toBe(first.commitId);
    expect(anchor1).not.toEqual(anchor0);

    const payload = { productId: 'lamp', quantity: 8 };
    expect(first.commandId).toBe(
      deriveCommandId(anchor0.branchId, anchor0, 'product.restock', payload, 0),
    );
    expect(second.commandId).toBe(
      deriveCommandId(anchor1.branchId, anchor1, 'product.restock', payload, 0),
    );
    expect(first.commandId).not.toBe(second.commandId);
  });

  it('the ordinal still disambiguates if an anchor were ever shared', () => {
    // Unit-level guarantee for the mechanism itself, independent of whether dispatch
    // currently produces a repeated anchor.
    const anchor = { virtualTime: 1000, afterCommitId: null };
    const payload = { productId: 'lamp', quantity: 8 };
    const a = deriveCommandId('branch:root', anchor, 'product.restock', payload, 0);
    const b = deriveCommandId('branch:root', anchor, 'product.restock', payload, 1);
    expect(a).not.toBe(b);
  });

  it('a failed command commit consumes no successful ordinal', () => {
    const sim = createSimulation({ scenario: shopScenario(), seed: 'ord' });
    const anchor = sim.getCursor();
    expect(() => sim.dispatch({ type: 'command.boom', payload: {} })).toThrowError();
    expect(sim.getRunState()).toBe('faulted');

    // A parallel simulation whose only prior attempts were rejected/failed must still
    // produce the ordinal-0 id at the same anchor.
    const clean = createSimulation({ scenario: shopScenario(), seed: 'ord' });
    clean.dispatch(restock(0)); // rejected by validation
    const accepted = clean.dispatch(restock(8));
    expect(accepted.commandId).toBe(
      deriveCommandId(
        anchor.branchId,
        anchor,
        'product.restock',
        { productId: 'lamp', quantity: 8 },
        0,
      ),
    );
  });

  it('gives identical commands at different anchors different ids', () => {
    const sim = createSimulation({ scenario: shopScenario(), seed: 'cmd' });
    const a = sim.dispatch(restock(8)).commandId;
    sim.advance(1500); // moves the anchor
    const b = sim.dispatch(restock(8)).commandId;
    expect(a).not.toBe(b);
  });

  it('is payload-order independent', () => {
    const a = createSimulation({ scenario: shopScenario(), seed: 'cmd' }).dispatch({
      type: 'product.restock',
      payload: { productId: 'lamp', quantity: 8 },
    }).commandId;
    const b = createSimulation({ scenario: shopScenario(), seed: 'cmd' }).dispatch({
      type: 'product.restock',
      payload: { quantity: 8, productId: 'lamp' },
    }).commandId;
    expect(a).toBe(b);
  });

  it('interventions interleave deterministically with scheduled work', () => {
    const build = () => {
      const sim = createSimulation({ scenario: shopScenario(), seed: 'cmd' });
      sim.advance(1500);
      sim.dispatch(restock(8));
      sim.advance(3000);
      return sim;
    };
    const a = build();
    const b = build();
    expect(b.getCommits().map((c) => c.commitId)).toEqual(a.getCommits().map((c) => c.commitId));
    expect(b.getState()).toEqual(a.getState());
  });
});
