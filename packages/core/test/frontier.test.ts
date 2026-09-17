import { describe, expect, it } from 'vitest';
import { BinaryHeap } from '../src/heap.js';
import { Frontier, frontierLess, sortsStrictlyAfter } from '../src/frontier.js';
import type { CommitSource, ScheduledItem } from '../src/types.js';

function item(virtualTime: number, priority: number, sequence: number, id = `sch:${sequence}`): ScheduledItem {
  return {
    scheduledId: id,
    virtualTime,
    priority,
    sequence,
    type: 't',
    payload: {},
    origin: 'handler',
  };
}
const src = (i: ScheduledItem): CommitSource => ({ kind: 'scheduled', item: i });

function permutations<T>(xs: readonly T[]): T[][] {
  if (xs.length <= 1) return [[...xs]];
  const out: T[][] = [];
  xs.forEach((x, i) => {
    const rest = [...xs.slice(0, i), ...xs.slice(i + 1)];
    for (const p of permutations(rest)) out.push([x, ...p]);
  });
  return out;
}

describe('binary heap', () => {
  it('orders integers regardless of insertion order', () => {
    for (const p of permutations([5, 1, 4, 2, 3])) {
      const h = new BinaryHeap<number>((a, b) => a < b);
      p.forEach((n) => h.push(n));
      const out: number[] = [];
      for (;;) {
        const v = h.pop();
        if (v === undefined) break;
        out.push(v);
      }
      expect(out).toEqual([1, 2, 3, 4, 5]);
    }
  });

  it('reports size and peek correctly', () => {
    const h = new BinaryHeap<number>((a, b) => a < b);
    expect(h.peek()).toBeUndefined();
    expect(h.pop()).toBeUndefined();
    h.push(2);
    h.push(1);
    expect(h.size).toBe(2);
    expect(h.peek()).toBe(1);
  });
});

describe('frontier ordering (INV-15)', () => {
  const items = [
    item(100, 20, 7),
    item(100, 20, 3),
    item(100, 0, 9),
    item(50, 40, 1),
    item(100, 10, 2),
  ];
  const expected = ['sch:1', 'sch:9', 'sch:2', 'sch:3', 'sch:7'];

  it('drains in (virtualTime, priority, sequence) order for every insertion permutation', () => {
    for (const p of permutations(items)) {
      const f = new Frontier();
      p.forEach((i) => f.push({ uid: f.allocateUid(), source: src(i) }));
      const out: string[] = [];
      for (;;) {
        const e = f.select();
        if (!e) break;
        out.push((e.source.item as ScheduledItem).scheduledId);
        f.completeActive(e);
      }
      expect(out).toEqual(expected);
    }
  });

  it('pendingSorted agrees with drain order', () => {
    const f = new Frontier();
    [...items].reverse().forEach((i) => f.push({ uid: f.allocateUid(), source: src(i) }));
    expect(f.pendingSorted().map((s) => (s.item as ScheduledItem).scheduledId)).toEqual(expected);
  });

  it('breaks ties by sequence only when time and priority are equal', () => {
    expect(frontierLess({ uid: 0, source: src(item(1, 1, 1)) }, { uid: 1, source: src(item(1, 1, 2)) })).toBe(true);
    expect(frontierLess({ uid: 0, source: src(item(1, 2, 1)) }, { uid: 1, source: src(item(1, 1, 2)) })).toBe(false);
    expect(frontierLess({ uid: 0, source: src(item(2, 1, 1)) }, { uid: 1, source: src(item(1, 9, 9)) })).toBe(false);
  });

  it('cancellation removes items from peek, pop and pendingSorted', () => {
    const f = new Frontier();
    const a = { uid: f.allocateUid(), source: src(item(10, 20, 1, 'sch:a')) };
    const b = { uid: f.allocateUid(), source: src(item(20, 20, 2, 'sch:b')) };
    f.push(a);
    f.push(b);
    f.cancel(a.uid);
    expect(f.liveSize).toBe(1);
    expect(f.find('sch:a')).toBeUndefined();
    expect(f.peekLive()?.uid).toBe(b.uid);
    expect(f.pendingSorted()).toHaveLength(1);
  });

  it('sortsStrictlyAfter implements the INV-71 comparison', () => {
    const cur = { virtualTime: 100, priority: 20, sequence: 5 };
    expect(sortsStrictlyAfter({ virtualTime: 101, priority: 0, sequence: 0 }, cur)).toBe(true);
    expect(sortsStrictlyAfter({ virtualTime: 100, priority: 20, sequence: 6 }, cur)).toBe(true);
    expect(sortsStrictlyAfter({ virtualTime: 100, priority: 30, sequence: 0 }, cur)).toBe(true);
    expect(sortsStrictlyAfter({ virtualTime: 100, priority: 10, sequence: 99 }, cur)).toBe(false);
    expect(sortsStrictlyAfter({ virtualTime: 99, priority: 40, sequence: 99 }, cur)).toBe(false);
    expect(sortsStrictlyAfter(cur, cur)).toBe(false);
  });
});


describe('transactional selection (item 1, INV-21)', () => {
  it('select does not remove the entry until completeActive', () => {
    const f = new Frontier();
    const e = { uid: f.allocateUid(), source: src(item(10, 20, 1, 'sch:x')) };
    f.push(e);
    const sel = f.select()!;
    expect(f.pendingSorted()).toHaveLength(1);
    expect(f.liveSize).toBe(1);
    f.completeActive(sel);
    expect(f.pendingSorted()).toHaveLength(0);
  });

  it('abortActive leaves the source exactly where it was', () => {
    const f = new Frontier();
    const a = { uid: f.allocateUid(), source: src(item(10, 20, 1, 'sch:a')) };
    const b = { uid: f.allocateUid(), source: src(item(20, 20, 2, 'sch:b')) };
    f.push(a);
    f.push(b);
    const before = f.pendingSorted();
    const sel = f.select()!;
    f.abortActive();
    expect(f.pendingSorted()).toEqual(before);
    // and it is selected again next time
    expect(f.select()!.uid).toBe(sel.uid);
  });

  it('the active source is invisible to find()', () => {
    const f = new Frontier();
    const e = { uid: f.allocateUid(), source: src(item(10, 20, 1, 'sch:self')) };
    f.push(e);
    expect(f.find('sch:self')).toBeDefined();
    f.select();
    expect(f.find('sch:self')).toBeUndefined();
    f.abortActive();
    expect(f.find('sch:self')).toBeDefined();
  });

  it('uid allocation is only published via commitUidCursor', () => {
    const f = new Frontier();
    f.allocateUid();
    const cursor = f.uidCursor;
    // a transaction that allocates but never publishes
    let scratch = f.uidCursor;
    scratch++;
    scratch++;
    expect(f.uidCursor).toBe(cursor);
    f.commitUidCursor(scratch);
    expect(f.uidCursor).toBe(scratch);
    // never moves backwards
    f.commitUidCursor(0);
    expect(f.uidCursor).toBe(scratch);
  });
});
