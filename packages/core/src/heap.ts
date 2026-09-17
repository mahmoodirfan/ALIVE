/** Explicit binary heap. INV-15: never Array.prototype.sort stability. */
export class BinaryHeap<T> {
  private readonly items: T[] = [];
  constructor(private readonly less: (a: T, b: T) => boolean) {}

  get size(): number {
    return this.items.length;
  }

  peek(): T | undefined {
    return this.items[0];
  }

  /** Snapshot in arbitrary heap order; callers must not assume sorting. */
  toArray(): readonly T[] {
    return [...this.items];
  }

  push(value: T): void {
    this.items.push(value);
    this.siftUp(this.items.length - 1);
  }

  pop(): T | undefined {
    const n = this.items.length;
    if (n === 0) return undefined;
    const top = this.items[0] as T;
    const last = this.items.pop() as T;
    if (n > 1) {
      this.items[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  private siftUp(i: number): void {
    let idx = i;
    while (idx > 0) {
      const parent = (idx - 1) >> 1;
      if (!this.less(this.items[idx] as T, this.items[parent] as T)) break;
      this.swap(idx, parent);
      idx = parent;
    }
  }

  private siftDown(i: number): void {
    const n = this.items.length;
    let idx = i;
    for (;;) {
      const l = idx * 2 + 1;
      const r = l + 1;
      let smallest = idx;
      if (l < n && this.less(this.items[l] as T, this.items[smallest] as T)) smallest = l;
      if (r < n && this.less(this.items[r] as T, this.items[smallest] as T)) smallest = r;
      if (smallest === idx) break;
      this.swap(idx, smallest);
      idx = smallest;
    }
  }

  private swap(a: number, b: number): void {
    const t = this.items[a] as T;
    this.items[a] = this.items[b] as T;
    this.items[b] = t;
  }
}
