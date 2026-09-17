# TIMELINES.md — ALIVE v0.1

Cursors, scrub, fork, branches, interventions, observables, counterfactual comparison,
and demo gating. These are the semantics the hero feature rests on.

Invariant numbers refer to the registry in ARCHITECTURE.md §14.

---

## 1. Cursors identify commits

**INV-44.** A timeline position is a **commit boundary**. It is never a bare timestamp
and never a position inside a commit.

```ts
type CommitId = string;

interface TimelineCursor {
  virtualTime: Millis;
  afterCommitId: CommitId | null;   // last published commit at or before virtualTime
  branchId: BranchId;
}

type TimelineCursorInput =
  | { time: Millis }              // resolves to the last commit at or before time
  | { afterCommitId: CommitId }   // exact boundary
  | { commitIndex: number };      // commit count: 0 = before all commits, N = after N commits
```

For `commitIndex`, v0.1 uses **commit-count semantics**: `0` is before any commit, `1` is after the first commit, and `N` is after N commits.

A commit may contain several domain events but exposes exactly one atomic state
transition. There is no valid state "after child event 2 but before child event 3", so
no cursor can name one. A raw `EventId` is not a cursor input; attempting to build a
cursor from an intra-commit event throws `ALIVE_INVALID_CURSOR`.

Several commits can share an instant, so `virtualTime` alone cannot say whether a
position precedes or follows any of them. `afterCommitId` disambiguates; `null` means
"before any commit on this branch".

Resolution of `{ time: T }` is exact and total: the position immediately after the last
commit whose `virtualTime <= T`, with the clock reading `T`.

`CommitId` derivation is in DETERMINISM §9; it is branch-independent, so a cursor's
`afterCommitId` stays meaningful across a fork's inherited history. `BranchId` derivation
is in DETERMINISM §10.

Individual events remain fully inspectable in the event inspector — they are just not
state-navigation boundaries.

---

## 2. Scrub

Scrub is **inspection**. It changes nothing.

```ts
alive.enterScrub({ time: t1030 });
alive.moveScrub({ time: t1015 });
alive.exitScrub();
```

**INV-46.** While scrubbed: no commits execute, the active branch is unchanged, the
queue is intact, history is untouched, no branch is created, and `exitScrub()` restores
the live view exactly. `getState()` returns historical state; `getHeadState()` still
returns the head.

**INV-45.** The kernel has no running state to pause — it advances only when called
(INV-7). The demo's `PlaybackController` stops its timer *before* calling
`enterScrub()`, and never auto-resumes on `exitScrub()`. Resuming is an explicit user
act.

**INV-25.** `committed` never fires while scrubbing. Only `timeline:changed` with
`scrub-enter` / `scrub-move` / `scrub-exit`.

Implementation: navigate by inverse patches where a patch trail exists, or restore the
nearest earlier checkpoint and replay forward. Both must agree with full replay
(INV-43).

The UI scrubber is continuous; the kernel position is discrete. Dragging snaps to commit
boundaries.

---

## 3. Mutation while scrubbed

**INV-6.** `dispatch()` while scrubbed throws `ALIVE_HISTORICAL_VIEW`. Never queue the
command, never apply it to the head silently, never auto-fork.

The MSW adapter maps this to `409 Conflict` with a stable body:

```json
{ "code": "ALIVE_HISTORICAL_VIEW",
  "message": "Cannot modify a historical view.",
  "hint": "Fork from this point to intervene." }
```

Reads continue to serve historical state. The host app needs no ALIVE awareness: it
shows whatever it already shows for a 409, and devtools offers **Fork From Here**.

Cache behaviour:

- ordinary commits → `committed` → effect rules map each event to resource keys
  (`invalidate(event)`, INV-29) → the binding coalesces per flush and invalidates only
  those keys. No polling (INV-30).
- view and topology changes → `timeline:changed` with `invalidateAll: true`, including
  scrub transitions, since every read-through resource now resolves against a different
  world.

---

## 4. Fork

Fork creates a **new future from a historical commit boundary while preserving the
original**.

```ts
const branch = alive.forkAt({ time: t1030 }, { name: "restock intervention" });
```

**INV-47.** The parent branch and its entire future are retained. Forking never deletes,
truncates or rewrites a branch. Without the preserved baseline there is no
counterfactual, which is the entire product.

The new branch starts in `live` view mode with playback stopped, becomes the active
branch, and generates its own future from the cursor.

### 4.1 Historical reconstruction — mandatory

**INV-48.** A fork obtains its starting timeline state by **checkpoint restoration plus
deterministic replay to the cursor**. It must never be built by filtering the parent's
current head queue.

This matters because the parent may have run far past the fork point. If the baseline
has reached 14:00, its head queue no longer contains the items that were pending at
10:30 and have since executed — filtering it would produce a fork missing most of its
future.

```
forkAt(cursorInput):
  1. resolve cursorInput to a commit cursor on the parent branch
  2. restore the nearest valid checkpoint at or before that cursor
     (valid = matching scenarioVersion, rngVersion, semanticsVersion; INV-42)
  3. replay the parent deterministically from that checkpoint to the cursor
  4. capture the complete timeline state at the cursor:
        world state
        pending scheduler queue
        pending interventions
        nextSequence
        exogenous cursors
        same-instant guard (INV-74)
  5. clone that historical snapshot into the new branch
  6. record parentBranchId and forkCursor
  7. continue independently
```

**INV-49.** The new branch's `nextSequence` is the value reconstructed at the cursor.
Inherited pending items keep their existing sequences; new items continue from that
counter, so collisions are impossible and inherited relative order survives.

**INV-39.** Exogenous cursors are inherited, so streams continue rather than restart.

**INV-74.** The same-instant guard is inherited too. A fork taken halfway through a
sequence of same-time commits continues counting toward `maxCommitsPerInstant` rather
than restarting it.

Checkpoints remain acceleration only (INV-41). With every checkpoint deleted, steps 2–3
degrade to a full replay from `t=0` and produce identical results.

### 4.2 Fork positions

- **At a commit boundary** — the cursor's `afterCommitId` is that commit; it is part of
  inherited history, and same-instant work ordered after it is inherited as pending.
- **Between commits** — the cursor is `(T, lastCommitId)`; the new branch's clock reads
  `T`, not the last commit's time. No synthetic event marks the fork.
- **Inside a commit** — impossible to express (INV-44); rejected.

---

## 5. Branch graph

```ts
interface Branch {
  id: BranchId;
  name?: string;
  parentBranchId?: BranchId;
  forkCursor?: TimelineCursor;
  createdBy: { type: "user" | "system"; description?: string };
  createdAt: Millis;          // virtual time of creation
  ranTo: Millis;              // furthest simulated virtual time
}
```

Arbitrary depth and breadth:

```
baseline
   ├── restock-at-10:30
   │      └── larger-restock
   └── discount-change
```

v0.1 devtools needs only a flat selector, but the kernel must not assume two branches.

**INV-50.** `switchBranch()` while scrubbed exits scrub first, emitting `scrub-exit`
then `branch-switch`. A cursor on one branch is meaningless on another beyond their
common ancestry; silently reinterpreting it would be worse than resetting the view.

---

## 6. Interventions and anchors

**INV-51.** Interventions are commands, not events. **INV-55.** They run through the
same commit machinery as scheduled work, live and in replay.

**INV-52.** Every recorded intervention carries a deterministic `commandId`
(DETERMINISM §7), an **anchor cursor**, and its resolved `(virtualTime, priority,
sequence)`.

```ts
interface ReplayIntervention {
  commandId: CommandId;
  anchor: TimelineCursor;
  command: SerializableCommand;
  virtualTime: Millis;
  priority: number;
  sequence: number;
}
```

**INV-53.** History through the anchor is immutable. Replay proceeds:

```
1. reconstruct the branch exactly through `anchor`
2. treat everything through `anchor` as fixed history — never reorder it
3. inject the intervention into the remaining pending work
4. apply the recorded (priority, sequence) only against work pending after `anchor`
```

This is what makes a late same-timestamp command safe. Suppose an autonomous event
commits at 10:30:00.000 and the user then dispatches a restock while the clock still
reads 10:30:00.000. Priority 0 alone would replay the restock *before* that committed
event, rewriting history. The anchor pins it after.

The replay invariant:

```
history through anchor
+ recorded intervention ordering
+ remaining deterministic schedule
= the original future
```

Replay stores the exact branch **head cursor** (time + `afterCommitId`) as well as the commit count. `ranTo` alone is insufficient when an intervention has committed at time T while lower-priority work at the same T remains pending.

Priority 0 therefore means "before pending same-instant work", never "before
already-committed same-instant history". This is the prefix/frontier ordering model of
ARCHITECTURE §6 (INV-15): an anchor establishes a history prefix that tuple ordering can
never cross.

---

## 7. Observables

**INV-59.** Observables are declared by the scenario and split by kind. Raw JSON diffs
are not a substitute — they produce hundreds of meaningless deltas and cannot express
"this event did not happen".

**INV-78.** Only numeric state observables may be sampled `every-commit`. Series,
deltas and charts are numeric; a string time-series has no meaningful delta and would
force `StateFinding.series` to carry a type it cannot plot. Text observables are
`at-horizon` only. Expressed as a discriminated union so the compiler enforces it:

```ts
type StateObservable<W> =
  | NumericStateObservable<W>
  | TextStateObservable<W>;

interface NumericStateObservable<W> {
  kind: "numeric";
  label: string;
  select: (state: Readonly<W>) => number | null;
  format?: "currency" | "integer" | "percent";
  sample: "at-horizon" | "every-commit";
  direction?: "higher-is-better" | "lower-is-better" | "neutral";
}

interface TextStateObservable<W> {
  kind: "text";
  label: string;
  select: (state: Readonly<W>) => string | null;
  format?: "text";
  sample: "at-horizon";
}

interface EventObservable {
  label: string;
  match: (event: AliveEvent) => boolean;
  expect?: "at-most-once" | "any";
}
```

Product Launch:

```ts
stateObservables: {
  revenue:      { kind: "numeric", label: "Revenue",
                  select: s => s.metrics.revenue,
                  format: "currency", sample: "every-commit",
                  direction: "higher-is-better" },
  arcLampStock: { kind: "numeric", label: "Arc Desk Lamp stock",
                  select: s => s.products["arc-lamp"].stock,
                  format: "integer", sample: "every-commit" },
  orderCount:   { kind: "numeric", label: "Orders",
                  select: s => Object.keys(s.orders).length,
                  format: "integer", sample: "at-horizon" },
},
eventObservables: {
  arcLampStockout: { label: "Arc Desk Lamp stockout",
                     match: e => e.type === "inventory.stockout"
                             && e.entityId === "arc-lamp",
                     expect: "at-most-once" },
}
```

### 7.1 Sampling across branches

**INV-60.** Two branches have different commit boundaries, so `every-commit` series sit
on different timestamp grids. Index-to-index comparison would be meaningless.

Each series is a **step function** — last value carried forward — and both branches are
sampled on the **union** of their commit grids up to the horizon. The union grid always
includes the fork time and the horizon itself.

`at-horizon` observables are read once, from state at the horizon.

Phase 3 derives report samples from the immutable committed patch history on demand. A
rolled-back commit is absent from that history and therefore cannot contribute a sample.
The public series is an **end-of-instant step function**: if several commits occur at the
same virtual millisecond, they collapse to the state after the final committed transition
at that instant. Commit-level detail remains available in the commit/event logs.

---

## 8. Counterfactual comparison

```ts
interface CompareOptions {
  until: Millis | "scenario-end";
  observables?: readonly string[];        // default: all declared
}

interface ComparisonReport {
  horizon: Millis;
  branches: { a: BranchId; b: BranchId };
  commonAncestry: TimelineCursor | null;
  interventions: {
    a: readonly ReplayIntervention[];     // on A after commonAncestry
    b: readonly ReplayIntervention[];     // on B after commonAncestry
  };
  stateFindings: readonly StateFinding[];
  eventFindings: readonly EventFinding[];
  causalLanguagePermitted: boolean;
  causalEventKey?: string;
  causalLanguageBlockedBy?: readonly string[];
}

type StateFinding = NumericStateFinding | TextStateFinding;

interface NumericStateFinding {
  kind: "numeric";
  key: string; label: string; format?: string;
  aAtHorizon: number | null;
  bAtHorizon: number | null;
  delta?: number;
  series?: { time: Millis; a: number | null; b: number | null }[];  // every-commit, collapsed end-of-instant
}

interface TextStateFinding {
  kind: "text";
  key: string; label: string;
  aAtHorizon: string | null;
  bAtHorizon: string | null;
  changed: boolean;
}

type Occurrence =
  | { status: "before-horizon"; at: Millis; eventId: EventId; commitId: CommitId }
  | { status: "not-before-horizon" }
  | { status: "after-horizon"; at: Millis; eventId: EventId; commitId: CommitId };

interface EventFinding {
  key: string; label: string;
  a: Occurrence; b: Occurrence;
  changed: boolean;
}
```

**INV-61.** `compareBranches` throws `ALIVE_HORIZON_NOT_REACHED` unless both branches
have fully evaluated the horizon. `ranTo >= horizon` is necessary but not sufficient: the
branch must also have **no pending frontier source with `virtualTime <= horizon`**. This
matters after a same-time intervention, where the branch clock may already equal T while
ordinary work at T is still pending. Without this rule an incomplete branch could report
"did not occur" and create a false counterfactual claim.

**INV-73.** An occurrence at exactly the horizon is `before-horizon` — the horizon is
inclusive, matching `advance`/`runUntil` processing `<= target` (ARCHITECTURE §3.1).

An observable event occurring only after the horizon is `{ status: "after-horizon" }`,
distinct from `not-before-horizon`. It is knowable only when that branch was simulated
past the horizon; otherwise the branch reports `not-before-horizon` and the UI must not
claim the event never happens.

The comparison is symmetric and works for arbitrary branch pairs — siblings, cousins,
ancestor/descendant. `commonAncestry` is the deepest shared graph cursor; both
intervention lists cover committed interventions after it **through the comparison
horizon**. Interventions after the horizon cannot affect the reported outcome and do not
block causal wording for that horizon.

### 8.1 When causal wording is permitted

**INV-62.** `causalLanguagePermitted` is computed by the kernel, not asserted by a
human. It is `true` only when **all** of these machine-checkable conditions hold for the
pair `(a = baseline, b = fork)` and one named event observable:

1. `commonAncestry !== null` and both branches' commit logs are identical through it
2. `interventions.a.length === 0` — the baseline has no post-ancestry intervention
3. `interventions.b.length === 1` — the fork has exactly one
4. every exogenous stream declared by the scenario is present in both branches with
   identical ordinals and emitted items through the horizon (INV-38)
5. both branches are compared at the same horizon (INV-61 satisfied)
6. the observable's occurrence in `a` is `before-horizon`
7. the observable's occurrence in `b` is `not-before-horizon` or `after-horizon`

When any fails, the report still renders in full and `causalLanguageBlockedBy` names
the failed conditions. Multiple differing interventions therefore produce a comparison
without a causal sentence.

The phrase "the only intended difference" is not used anywhere, because intent is not
machine-checkable. Conditions 2 and 3 are the operational substitute.

**INV-63.** Even when permitted, phrasing is always scoped:

> **In this simulation**, your 10:30 restock prevented the Arc Desk Lamp stockout.

Never unqualified. ALIVE compares two runs of a fictional model and makes no real-world
causal claim.

---

## 9. Reset and replay loading

```
reset()       → discard non-root branches, restore root to t=0, playback stopped
loadReplay()  → replace the entire branch graph; active branch per the file
```

Both emit `timeline:changed` with `invalidateAll: true`.

**INV-57.** `loadReplay` hard-fails on mismatched `formatVersion`, `semanticsVersion`,
`scenario.id`, `scenario.version`, `rng.algorithm` or `rng.version`:

```
ALIVE_FORMAT_VERSION_MISMATCH
ALIVE_SEMANTICS_VERSION_MISMATCH
ALIVE_SCENARIO_UNAVAILABLE
ALIVE_RNG_VERSION_MISMATCH
```

No best-effort load, no partial reconstruction, no silent coercion. `engineVersion`
mismatch warns only.

**INV-42.** Checkpoints are discarded on any version mismatch and recomputed by replay.
Never migrated.

---

## 10. Devtools and build gating

- **Historical mode** is unmistakable: `VIEWING HISTORY` banner, muted chrome, clock at
  the cursor time, actions reduced to `Return to Live` and `Fork From Here`.
- **Branch selector** lists branches with fork points; switching exits scrub first.
- **Counterfactual panel** is the hero. It renders `ComparisonReport` directly and shows
  the causal sentence only when `causalLanguagePermitted` is `true`; otherwise it shows
  the comparison and, in dev, `causalLanguageBlockedBy`.
- **Event inspector** shows `commitId`, `parentEventId`, children, `withinCommitOrder`,
  payload, actor, timestamp. No graph visualisation in v0.1.
- **Playback** is `1× / 5× / 20×` multipliers of the configured demonstration pace
  (ARCHITECTURE §9), not of real time.
- Keyboard-operable throughout; visible focus; `prefers-reduced-motion` respected;
  usable without a mouse.

**INV-64.** ALIVE is gated by an explicit build flag, not by `import.meta.env.DEV`.

```
local development                     → enabled
official ALIVE showcase deployment    → VITE_ALIVE_ENABLED=true, explicitly enabled
ordinary consumer production build    → disabled by default, kernel and panel
                                        tree-shaken out of the bundle
```

`import.meta.env.DEV` would make the hosted demo impossible, since a Vite production
build has `DEV === false` and the project needs a deployable live demo on GitHub
Pages / Vercel / Netlify. CI asserts both build configurations.

**INV-65.** The showcase uses fictional data and isolated mock endpoints only. ALIVE
never connects to production services, and scenarios must never contain real customer
data. Documented prominently in the README and CONTRIBUTING.
