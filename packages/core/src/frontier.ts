/**
 * The pending frontier (ARCHITECTURE §6). Ordered by (virtualTime, priority, sequence),
 * ascending, lower first. The immutable history prefix lives in the commit log, not here.
 *
 * Selection is transactional (INV-21). `select()` does NOT remove the entry: the source
 * stays in the frontier until `completeActive()` publishes the commit. A failed commit
 * calls `abortActive()` and the source is still pending, exactly as before the attempt.
 *
 * While an entry is active it is logically invisible to `find()`, so a handler cannot
 * cancel or reschedule the very source it is executing merely because that source is
 * still physically present in the heap.
 *
 * UID allocation is also transactional: callers allocate from a scratch counter seeded
 * by `uidCursor` and publish the advance with `commitUidCursor()` only on success, so a
 * rolled-back commit consumes no scheduler-internal identity (item 4).
 */
import { AliveError } from './errors.js';
import { BinaryHeap } from './heap.js';
import type { CommitSource, InterventionItem, ScheduledItem, ScheduledId } from './types.js';

export interface FrontierEntry {
  readonly uid: number;
  readonly source: CommitSource;
}

export interface FrontierSnapshot {
  readonly entries: readonly FrontierEntry[];
  readonly uidCursor: number;
}

export function tupleOf(source: CommitSource): {
  virtualTime: number;
  priority: number;
  sequence: number;
} {
  const it: ScheduledItem | InterventionItem = source.item;
  return { virtualTime: it.virtualTime, priority: it.priority, sequence: it.sequence };
}

/** Strict ordering relation within the frontier. */
export function frontierLess(a: FrontierEntry, b: FrontierEntry): boolean {
  const x = tupleOf(a.source);
  const y = tupleOf(b.source);
  if (x.virtualTime !== y.virtualTime) return x.virtualTime < y.virtualTime;
  if (x.priority !== y.priority) return x.priority < y.priority;
  return x.sequence < y.sequence;
}

/** Returns true when tuple `a` sorts strictly after tuple `b`. */
export function sortsStrictlyAfter(
  a: { virtualTime: number; priority: number; sequence: number },
  b: { virtualTime: number; priority: number; sequence: number },
): boolean {
  if (a.virtualTime !== b.virtualTime) return a.virtualTime > b.virtualTime;
  if (a.priority !== b.priority) return a.priority > b.priority;
  return a.sequence > b.sequence;
}

export class Frontier {
  private heap = new BinaryHeap<FrontierEntry>(frontierLess);
  private readonly cancelled = new Set<number>();
  private readonly byScheduledId = new Map<ScheduledId, FrontierEntry>();
  private uidCounter = 0;
  private activeUid: number | null = null;

  /** Next uid a transaction may allocate from. Not consumed until commitUidCursor. */
  get uidCursor(): number {
    return this.uidCounter;
  }

  /** Publish a transaction's uid allocations. Never moves the cursor backwards. */
  commitUidCursor(next: number): void {
    if (!Number.isSafeInteger(next) || next < 0) {
      throw new AliveError('ALIVE_COUNTER_OVERFLOW', 'frontier uid cursor is not a safe counter', {
        next,
      });
    }
    if (next > this.uidCounter) this.uidCounter = next;
  }

  /** Seeding path only: allocate a uid immediately (construction, outside any commit). */
  allocateUid(): number {
    if (!Number.isSafeInteger(this.uidCounter) || this.uidCounter >= Number.MAX_SAFE_INTEGER) {
      throw new AliveError('ALIVE_COUNTER_OVERFLOW', 'frontier uid counter exhausted', {
        value: this.uidCounter,
      });
    }
    const uid = this.uidCounter;
    this.uidCounter += 1;
    return uid;
  }

  push(entry: FrontierEntry): void {
    this.heap.push(entry);
    if (entry.source.kind === 'scheduled') {
      this.byScheduledId.set(entry.source.item.scheduledId, entry);
    }
  }

  cancel(uid: number): void {
    this.cancelled.add(uid);
  }

  isCancelled(uid: number): boolean {
    return this.cancelled.has(uid);
  }

  /** Lookup for ctx.cancel/ctx.reschedule. The active source is invisible. */
  find(scheduledId: ScheduledId): FrontierEntry | undefined {
    const e = this.byScheduledId.get(scheduledId);
    if (!e || this.cancelled.has(e.uid)) return undefined;
    if (this.activeUid !== null && e.uid === this.activeUid) return undefined;
    return e;
  }

  /**
   * Top live entry. Discards already-cancelled entries as it scans; that is a no-op
   * semantically (cancelled entries are excluded from every observable view) and happens
   * during selection, before any transaction stages work.
   */
  peekLive(): FrontierEntry | undefined {
    for (;;) {
      const top = this.heap.peek();
      if (!top) return undefined;
      if (!this.cancelled.has(top.uid)) return top;
      this.heap.pop();
      this.forgetIndex(top);
    }
  }

  /** Select the next source without removing it. */
  select(): FrontierEntry | undefined {
    const top = this.peekLive();
    if (!top) return undefined;
    this.activeUid = top.uid;
    return top;
  }

  /** Publish: remove the active entry from the frontier. */
  completeActive(entry: FrontierEntry): void {
    if (this.activeUid !== entry.uid) {
      throw new Error('frontier: completeActive called for a non-active entry');
    }
    const top = this.heap.peek();
    if (!top || top.uid !== entry.uid) {
      throw new Error('frontier: active entry is no longer at the head of the queue');
    }
    this.heap.pop();
    this.forgetIndex(entry);
    this.activeUid = null;
  }

  /** Roll back: the source stays exactly where it was. */
  abortActive(): void {
    this.activeUid = null;
  }

  private forgetIndex(entry: FrontierEntry): void {
    if (entry.source.kind !== 'scheduled') return;
    const id = entry.source.item.scheduledId;
    const cur = this.byScheduledId.get(id);
    if (cur && cur.uid === entry.uid) this.byScheduledId.delete(id);
  }

  /** Live pending sources in deterministic frontier order, including any active one. */
  pendingSorted(): readonly CommitSource[] {
    return this.heap
      .toArray()
      .filter((e) => !this.cancelled.has(e.uid))
      .sort((a, b) => (frontierLess(a, b) ? -1 : frontierLess(b, a) ? 1 : 0))
      .map((e) => e.source);
  }

  get liveSize(): number {
    return this.heap.toArray().filter((e) => !this.cancelled.has(e.uid)).length;
  }

  /** Serializable semantic snapshot at a commit boundary. Cancelled tombstones are omitted. */
  snapshot(): FrontierSnapshot {
    return Object.freeze({
      entries: Object.freeze([...this.pendingEntriesSorted()]),
      uidCursor: this.uidCounter,
    });
  }

  /** Restore a commit-boundary snapshot. There must be no active transaction. */
  restore(snapshot: FrontierSnapshot): void {
    this.heap = new BinaryHeap<FrontierEntry>(frontierLess);
    this.cancelled.clear();
    this.byScheduledId.clear();
    this.activeUid = null;
    this.uidCounter = snapshot.uidCursor;
    for (const entry of snapshot.entries) this.push(entry);
  }

  /** Live entries sorted by semantic frontier order, retaining internal uid. */
  pendingEntriesSorted(): readonly FrontierEntry[] {
    return this.heap
      .toArray()
      .filter((e) => !this.cancelled.has(e.uid))
      .sort((a, b) => (frontierLess(a, b) ? -1 : frontierLess(b, a) ? 1 : 0));
  }
}
