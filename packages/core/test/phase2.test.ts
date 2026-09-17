import { describe, expect, it } from 'vitest';
import { createSimulation } from '../src/simulation.js';
import { PRIORITY, type Scenario } from '../src/types.js';

interface World { n: number; stock: number; log: string[] }

function scenario(): Scenario<World> {
  return {
    id: 'phase2', version: '1.0.0', name: 'Phase2', epoch: '2026-01-01T00:00:00.000Z',
    initialState: () => ({ n: 0, stock: 2, log: [] }),
    events: {
      tick(draft, event) { draft.n += 1; draft.stock -= 1; draft.log.push(`tick:${event.key}`); },
      restocked(draft, event) { const p = event.payload as { qty: number }; draft.stock += p.qty; draft.log.push(`restock:${p.qty}`); },
    },
    commands: {
      restock: { events(_s, c) { return [{ type: 'restocked', entityId: 'stock', payload: c.payload }]; } },
    },
    bootstrap: [
      { key: 'a', type: 'tick', virtualTime: 1000, priority: PRIORITY.domain, payload: {} },
      { key: 'b', type: 'tick', virtualTime: 2000, priority: PRIORITY.domain, payload: {} },
      { key: 'c', type: 'tick', virtualTime: 3000, priority: PRIORITY.domain, payload: {} },
    ],
  };
}

const restock = (qty = 5) => ({ type: 'restock', payload: { qty } });

describe('Phase 2 scrub semantics', () => {
  it('serves historical view state without changing head state or history', () => {
    const sim = createSimulation({ scenario: scenario(), seed: 'p2', checkpointEvery: 1 });
    sim.runUntil(3000);
    const head = structuredClone(sim.getHeadState());
    const commits = sim.getCommits().map((c) => c.commitId);
    const first = commits[0]!;

    const cursor = sim.enterScrub({ afterCommitId: first });
    expect(sim.getViewMode()).toBe('scrubbing');
    expect(sim.getTime()).toBe(1000);
    expect(sim.getState()).toEqual({ n: 1, stock: 1, log: ['tick:a'] });
    expect(sim.getHeadState()).toEqual(head);
    expect(sim.getCommits().map((c) => c.commitId)).toEqual(commits);
    expect(cursor.afterCommitId).toBe(first);

    expect(() => sim.dispatch(restock())).toThrowError(/ALIVE_HISTORICAL_VIEW/);
    expect(() => sim.advance(1)).toThrowError(/ALIVE_HISTORICAL_VIEW/);

    sim.exitScrub();
    expect(sim.getViewMode()).toBe('live');
    expect(sim.getState()).toEqual(head);
  });

  it('time cursor snaps after the last commit at or before the requested time', () => {
    const sim = createSimulation({ scenario: scenario(), seed: 'p2' });
    sim.runUntil(3500);
    const c = sim.enterScrub({ time: 2500 });
    expect(c.virtualTime).toBe(2500);
    expect(c.afterCommitId).toBe(sim.getCommits()[1]!.commitId);
    expect(sim.getState().n).toBe(2);
    expect(sim.getTime()).toBe(2500);
  });
});

describe('Phase 2 branch semantics', () => {
  it('fork preserves baseline and creates an independent future', () => {
    const sim = createSimulation({ scenario: scenario(), seed: 'p2', checkpointEvery: 1 });
    sim.runUntil(3000);
    const baseline = structuredClone(sim.getState());
    const first = sim.getCommits()[0]!.commitId;

    const branch = sim.forkAt({ afterCommitId: first }, { name: 'restock' });
    expect(sim.getActiveBranchId()).toBe(branch.id);
    expect(sim.getState()).toEqual({ n: 1, stock: 1, log: ['tick:a'] });
    sim.dispatch(restock(5));
    sim.runUntil(3000);
    const alternative = structuredClone(sim.getState());
    expect(alternative).not.toEqual(baseline);
    expect(alternative.stock).toBe(4);

    sim.switchBranch('branch:root');
    expect(sim.getState()).toEqual(baseline);
    sim.switchBranch(branch.id);
    expect(sim.getState()).toEqual(alternative);
  });

  it('switchBranch exits scrub before switching', () => {
    const sim = createSimulation({ scenario: scenario(), seed: 'p2' });
    sim.runUntil(3000);
    const branch = sim.forkAt({ commitIndex: 1 });
    sim.runUntil(2000);
    sim.enterScrub({ commitIndex: 1 });
    sim.switchBranch('branch:root');
    expect(sim.getViewMode()).toBe('live');
    expect(sim.getActiveBranchId()).toBe('branch:root');
    expect(sim.getScrubCursor()).toBeNull();
    expect(branch.id).not.toBe('branch:root');
  });

  it('switching while scrubbed emits scrub-exit before branch-switch', () => {
    const sim = createSimulation({ scenario: scenario(), seed: 'p2' });
    sim.runUntil(3000);
    const branch = sim.forkAt({ commitIndex: 1 });
    sim.runUntil(2000);
    const reasons: string[] = [];
    sim.on('timeline:changed', (n) => reasons.push(n.reason));
    sim.enterScrub({ commitIndex: 1 });
    reasons.length = 0;
    sim.switchBranch('branch:root');
    expect(reasons).toEqual(['scrub-exit', 'branch-switch']);
    expect(branch.id).not.toBe('branch:root');
  });

  it('supports nested branches without assuming only two timelines', () => {
    const sim = createSimulation({ scenario: scenario(), seed: 'p2' });
    sim.runUntil(3000);
    const child = sim.forkAt({ commitIndex: 1 }, { name: 'child' });
    sim.dispatch(restock(2));
    const grand = sim.forkAt({ afterCommitId: sim.getCursor().afterCommitId! }, { name: 'grand' });
    expect(sim.getBranches().map((b) => b.id)).toEqual(['branch:root', child.id, grand.id]);
    expect(sim.getBranches().find((b) => b.id === grand.id)?.parentBranchId).toBe(child.id);
  });
});

describe('Phase 2 replay', () => {
  it('round-trips a branched simulation and restores all branch heads', () => {
    const sim = createSimulation({ scenario: scenario(), seed: 'p2', checkpointEvery: 1 });
    sim.runUntil(3000);
    const rootState = structuredClone(sim.getState());
    const branch = sim.forkAt({ commitIndex: 1 }, { name: 'restock' });
    sim.dispatch(restock(5));
    sim.runUntil(3000);
    const childState = structuredClone(sim.getState());
    const replay = sim.exportReplay();

    const loaded = createSimulation({ scenario: scenario(), seed: 'p2', checkpointEvery: 1 });
    loaded.loadReplay(replay);
    expect(loaded.getActiveBranchId()).toBe(branch.id);
    expect(loaded.getState()).toEqual(childState);
    loaded.switchBranch('branch:root');
    expect(loaded.getState()).toEqual(rootState);
    loaded.switchBranch(branch.id);
    expect(loaded.getState()).toEqual(childState);
  });

  it('preserves exact head position when same-time work remains pending after an intervention', () => {
    const sameTime: Scenario<{ n: number; log: string[] }> = {
      id: 'same-time', version: '1', name: 'same-time', epoch: '2026-01-01T00:00:00.000Z',
      initialState: () => ({ n: 0, log: [] }),
      events: {
        tick(d, e) { d.n += 1; d.log.push(`tick:${e.key}`); },
        mark(d) { d.log.push('intervention'); },
      },
      commands: { mark: { events: () => [{ type: 'mark', payload: {} }] } },
      bootstrap: [
        { key: 'a', type: 'tick', virtualTime: 1000, priority: PRIORITY.domain, payload: {} },
        { key: 'b', type: 'tick', virtualTime: 1000, priority: PRIORITY.domain, payload: {} },
      ],
    };
    const sim = createSimulation({ scenario: sameTime, seed: 'same' });
    sim.runNext();
    sim.dispatch({ type: 'mark', payload: {} });
    expect(sim.getPendingSources()).toHaveLength(1);
    const replay = sim.exportReplay();

    const loaded = createSimulation({ scenario: sameTime, seed: 'same' });
    loaded.loadReplay(replay);
    expect(loaded.getState()).toEqual(sim.getState());
    expect(loaded.getCursor()).toEqual(sim.getCursor());
    expect(loaded.getPendingSources()).toHaveLength(1);
    expect(loaded.getCommits().map((c) => c.commitId)).toEqual(sim.getCommits().map((c) => c.commitId));
  });

  it('rejects incompatible replay metadata', () => {
    const sim = createSimulation({ scenario: scenario(), seed: 'p2' });
    const replay = sim.exportReplay();
    const bad = { ...replay, semanticsVersion: replay.semanticsVersion + 1 } as typeof replay;
    const other = createSimulation({ scenario: scenario(), seed: 'p2' });
    expect(() => other.loadReplay(bad)).toThrowError(/ALIVE_REPLAY_INCOMPATIBLE/);
  });

  it('failed replay loading is transactional and preserves the current simulation', () => {
    const sim = createSimulation({ scenario: scenario(), seed: 'p2' });
    sim.runUntil(2000);
    const before = { state: structuredClone(sim.getState()), cursor: sim.getCursor(), commits: sim.getCommits().map((c) => c.commitId) };
    const replay = sim.exportReplay();
    const bad = { ...replay, scenario: { ...replay.scenario, version: 'wrong' } } as typeof replay;
    expect(() => sim.loadReplay(bad)).toThrowError(/ALIVE_REPLAY_INCOMPATIBLE/);
    expect(sim.getState()).toEqual(before.state);
    expect(sim.getCursor()).toEqual(before.cursor);
    expect(sim.getCommits().map((c) => c.commitId)).toEqual(before.commits);
  });
});

describe('Phase 2 patch/replay equivalence', () => {
  it('a replay-reconstructed fork equals the patch-derived scrub view at every commit boundary', () => {
    const sim = createSimulation({ scenario: scenario(), seed: 'equiv', checkpointEvery: 0 });
    sim.runUntil(3000);
    const ids = sim.getCommits().map((c) => c.commitId);

    for (const id of ids) {
      sim.enterScrub({ afterCommitId: id });
      const patchState = structuredClone(sim.getState());
      sim.exitScrub();
      const branch = sim.forkAt({ afterCommitId: id });
      expect(sim.getState()).toEqual(patchState);
      sim.switchBranch('branch:root');
      expect(branch.forkCursor?.afterCommitId).toBe(id);
    }
  });

  it('checkpointed and full-replay reconstruction produce the same fork state', () => {
    const a = createSimulation({ scenario: scenario(), seed: 'cp', checkpointEvery: 1 });
    const b = createSimulation({ scenario: scenario(), seed: 'cp', checkpointEvery: 0 });
    a.runUntil(3000); b.runUntil(3000);
    const ca = a.forkAt({ commitIndex: 2 });
    const cb = b.forkAt({ commitIndex: 2 });
    expect(a.getState()).toEqual(b.getState());
    expect(ca.id).toBe(cb.id);
    expect(a.getPendingSources()).toEqual(b.getPendingSources());
  });
});
