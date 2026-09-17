# ARCHITECTURE.md — ALIVE v0.5 demo milestone

Status: **living architecture contract.** Phase 1.2 implements the deterministic kernel
in `packages/core`; scrub/fork/replay are implemented in Phase 2; observables and
counterfactual branch comparison are implemented through Phase 3. Phase 4 adds transport/integration; Phase 5 adds the concrete Northstar Goods React/Vite showcase, browser playback controller and developer tools without changing the deterministic kernel boundary.

Invariants are `INV-n`. The complete registry is §14. **Every invariant number refers to
exactly one concept.** It may be restated or referenced in other sections and documents;
conflicting definitions are forbidden. The registry is the authority for what a number
means and where its home definition lives.

---

## 1. Ownership boundary

**INV-1.** ALIVE owns canonical simulation world state. It does not own host
application state (React state, Redux, Zustand, TanStack Query cache).

**INV-2.** `packages/core` must not import React, MSW, TanStack Query, Redux, Zustand,
or browser-only APIs. It runs unchanged in Node and in a worker.

**INV-3.** The kernel is fully usable with **no API contract, no routes, no
`ResourceKey`s, no HTTP and no query client**. A headless simulation must run, commit,
notify, fork, compare and replay with none of the transport layer present. Transport is
strictly downstream.

```
                    ┌───────────────────┐
                    │   ALIVE kernel    │   knows nothing about HTTP
                    │ world state       │
                    │ virtual clock     │
                    │ scheduler         │
                    │ commit machinery  │
                    │ branch graph      │
                    │ keyed RNG         │
                    └─────────┬─────────┘
                    committed │ timeline:changed
                ┌─────────────┴─────────────┐
        ┌───────▼────────┐          ┌───────▼───────────┐
        │ MSW adapter    │          │ query binding     │
        │ + api contract │          │ + api contract    │
        └───────┬────────┘          └───────┬───────────┘
                │                           │
          ordinary HTTP app          host cache invalidation
```

The API contract is defined by the **application**, not the scenario, and is consumed
independently by the MSW adapter and by the query binding.

---

## 2. View state vs head state

**INV-4.** `getState()` returns **view state**:

```
live      → active branch head
scrubbing → historical state at the scrub cursor
```

**INV-5.** `getHeadState()` always returns the active branch head, regardless of scrub.

**INV-6.** Commands always resolve against the active branch head. `dispatch()` while
scrubbed throws `ALIVE_HISTORICAL_VIEW`. The MSW adapter maps that to `409 Conflict`.
Reads continue to serve historical state, so `GET` works while scrubbed with no
app-side awareness.

---

## 3. Public kernel API

**INV-7.** The kernel is wall-clock independent and contains no playback. There is no
`start()`, `pause()`, `setRate()` or timer anywhere in `packages/core`. Pacing belongs
to the demo's `PlaybackController` (§9).

```ts
type Millis   = number;        // non-negative safe-integer ms since scenario epoch
type BranchId = string;
type CommitId = string;
type EventId  = string;
type ScheduledId = string;
type CommandId   = string;

type ViewMode = "live" | "scrubbing";
type RunState = "ready" | "ended" | "faulted";

interface CreateSimulationOptions<W> {
  scenario: Scenario<W>;
  seed: string;
  limits?: Partial<SafetyLimits>;
  checkpointEvery?: number;      // commits between checkpoints; defaults to 0; 0 disables
}

declare function createSimulation<W>(o: CreateSimulationOptions<W>): Simulation<W>;

interface Simulation<W> {
  // deterministic advance — the only way time moves (§3.1)
  advance(duration: Millis): RunResult;       // duration >= 0
  runUntil(time: Millis): RunResult;          // time >= head time
  runNext(): StepResult;                      // exactly one commit source

  // state
  getState(): Readonly<W>;                    // view state (INV-4)
  getHeadState(): Readonly<W>;                // head state (INV-5)
  getTime(): Millis;                          // view time
  getHeadTime(): Millis;
  getViewMode(): ViewMode;
  getRunState(): RunState;
  getEvents(q?: EventQuery): readonly AliveEvent[];
  getCommits(q?: CommitQuery): readonly CommitRecord[];

  // commands
  dispatch(command: SerializableCommand): DispatchResult;

  // scrub — inspection only
  enterScrub(target: TimelineCursorInput): TimelineCursor;
  moveScrub(target: TimelineCursorInput): TimelineCursor;
  exitScrub(): void;
  getScrubCursor(): TimelineCursor | null;

  // branching
  forkAt(target: TimelineCursorInput, opts?: ForkOptions): Branch;
  switchBranch(branchId: BranchId): void;
  getBranches(): readonly Branch[];
  getActiveBranchId(): BranchId;

  // counterfactual
  compareBranches(a: BranchId, b: BranchId, opts: CompareOptions): ComparisonReport;

  // persistence
  exportReplay(opts?: ExportOptions): ReplayFile;
  loadReplay(replay: ReplayFile): void;
  reset(): void;

  // notifications
  on(c: "committed", fn: (n: CommitNotification) => void): Unsubscribe;
  on(c: "timeline:changed", fn: (n: TimelineChangeNotification) => void): Unsubscribe;
  on(c: "error", fn: (e: ListenerError) => void): Unsubscribe;

  dispose(): void;
}

interface RunResult {
  commits: number;
  eventsProcessed: number;
  virtualTime: Millis;                        // head time after the call
  stoppedBecause: "target-reached" | "scenario-end";
}

interface StepResult {
  committed: boolean;
  commitId?: CommitId;
  eventsProcessed: number;
  virtualTime: Millis;                        // head time after the call
  stoppedBecause: "committed" | "no-work" | "scenario-end";
}

interface DispatchResult {
  accepted: boolean;
  rejection?: CommandRejection;
  commandId?: CommandId;
  commitId?: CommitId;
  emitted?: readonly EventId[];
}
```

### 3.1 Virtual clock advancement

**INV-72.** Advancement semantics are exact and total. `"queue-empty"` is not a stop
reason: an empty queue must never prevent the clock reaching a requested target, or a
branch's `ranTo` would falsely sit behind a comparison horizon.

**`advance(duration)`**

```
require duration >= 0                      else ALIVE_INVALID_DURATION
target = head time + duration
process every eligible pending commit source with virtualTime <= target,
  in pending-frontier order (§6)
set head time = target
```

capped by `scenario.endTime` if present: head time = min(target, endTime), run state
becomes `"ended"`, `stoppedBecause = "scenario-end"`. Otherwise
`stoppedBecause = "target-reached"`.

The clock advances freely through intervals containing no work. This is required for
forks at arbitrary times between commits, for comparison horizons, and for `at-horizon`
observables.

**`runUntil(target)`**

```
require target >= head time                else ALIVE_BACKWARD_RUN
```

Then identical to `advance(target - head)`. Backward movement is scrubbing, not running;
the error message says so.

**`runNext()`**

Executes exactly one pending commit source and moves head time to that source's
`virtualTime`. If no source is pending: no commit occurs, **head time does not change**,
and the result is `{ committed: false, stoppedBecause: "no-work" }`.

`runNext()` is therefore not a substitute for `advance()` when the goal is to reach a
timestamp — it cannot cross an empty interval.

**INV-73.** A commit with `virtualTime == horizon` is **inside** the horizon. Both
`advance`/`runUntil` (which process `<= target`) and counterfactual comparison (which
treats occurrences at the horizon as `before-horizon`) use the same inclusive rule.
Comparison depends on this, so it is stated once and applied everywhere.


---

## 4. Data model

### 4.1 Scenario — simulation semantics only

At construction, the kernel validates the scenario and detaches/freezes its registry and
array structure (`events`, `commands`, `rules`, `exogenous`, `bootstrap`). Callers cannot
replace handlers or streams after `createSimulation()`. Executable function closures are
retained by identity, so scenario authors remain responsible for keeping captured external
state deterministic.

**INV-28.** `Scenario<W>` contains no HTTP, route, resource-key or cache concept.

```ts
interface Scenario<W> {
  id: string;
  version: string;                  // semver; part of replay compatibility
  name: string;
  epoch: string;                    // ISO datetime mapped to virtualTime 0
  endTime?: Millis;

  initialState: (ctx: InitContext) => W;

  events: Record<string, EventHandler<W>>;
  commands: Record<string, CommandHandler<W>>;
  rules?: readonly RuleDefinition<W>[];
  exogenous?: readonly ExogenousStream<W>[];
  bootstrap?: readonly BootstrapItem[];

  stateObservables?: Record<string, StateObservable<W>>;
  eventObservables?: Record<string, EventObservable>;
}
```

### 4.2 Events

```ts
interface AliveEvent<T = JsonValue> {
  readonly id: EventId;               // branch-independent, semantic (DETERMINISM §4)
  readonly type: string;
  readonly commitId: CommitId;
  readonly virtualTime: Millis;       // equals the commit's virtualTime

  readonly withinCommitOrder: number; // execution/log order inside the commit
  readonly depth: number;             // causal depth within the commit

  readonly actorId?: string;
  readonly entityId?: string;
  readonly slot?: string;             // explicit semantic discriminator
  readonly key?: string;              // explicit domain discriminator

  readonly parentEventId?: EventId;   // absent for the commit's first event(s)
  readonly causeId: string;           // parentEventId ?? commitId

  readonly payload: T;
}
```

**INV-8.** Recorded events are immutable. Storage identity is `(branchId, eventId)`;
`branchId` is a property of the store, not of the record.

**INV-9.** `eventId` is branch-independent. Two branches producing the same causal
event give it the same id, which is what lets `compareBranches` align them.

**INV-14.** `withinCommitOrder` is presentation and execution ordering only. It never
participates in `EventId` derivation, RNG keys, or branch alignment. A suppressed
sibling shifts `withinCommitOrder` for later siblings and must change nothing else.

### 4.3 Scheduler items and interventions

**INV-18.** Scheduler items are serializable plain data. No closures, functions, class
instances, `Date`, `Map`, `Set` or `BigInt`. Handlers resolve from the scenario registry
by `type` at execution time.

```ts
interface ScheduledItem<P = JsonValue> {
  readonly scheduledId: ScheduledId;   // becomes the root EventId (DETERMINISM §6)
  readonly virtualTime: Millis;
  readonly priority: number;
  readonly sequence: number;

  readonly type: string;
  readonly payload: P;

  readonly actorId?: string;
  readonly entityId?: string;
  readonly slot?: string;
  readonly key?: string;
  readonly parentEventId?: EventId;
  readonly origin: "bootstrap" | "exogenous" | "handler";
  readonly streamId?: string;          // exogenous only
  readonly ordinal?: number;           // exogenous only
}

interface InterventionItem {
  readonly commandId: CommandId;       // deterministic, DETERMINISM §7
  readonly anchor: TimelineCursor;     // history through here is immutable
  readonly virtualTime: Millis;
  readonly priority: number;           // intervention band, default 0
  readonly sequence: number;
  readonly command: SerializableCommand;
}

type CommitSource =
  | { kind: "scheduled";    item: ScheduledItem }
  | { kind: "intervention"; item: InterventionItem };
```

**INV-51.** User interventions are commands, not events. A command is validated against
head state and, if accepted, emits domain events.

```ts
interface SerializableCommand<P = JsonValue> {
  readonly type: string;
  readonly payload: P;
}

interface CommandRejection {
  code: "ALIVE_HISTORICAL_VIEW" | "ALIVE_UNKNOWN_COMMAND"
      | "ALIVE_INVALID_COMMAND" | "ALIVE_PRECONDITION_FAILED";
  message: string;
  details?: JsonValue;
}
```

### 4.4 Handler, command and rule interfaces

Pinned here so Phase 1 does not invent semantics.

```ts
type EventHandler<W> = (
  draft: Draft<W>,
  event: AliveEvent,
  ctx: HandlerContext<W>
) => void;

interface HandlerContext<W> {
  readonly time: Millis;                   // the commit's virtualTime
  readonly commitId: CommitId;
  readonly random: RandomApi;              // DETERMINISM §3
  emit(spec: EmitSpec): void;              // immediate child, same commit
  schedule(spec: ScheduleSpec): ScheduledId;   // future work, §4.5
  cancel(scheduledId: ScheduledId): boolean;
  reschedule(scheduledId: ScheduledId, virtualTime: Millis): boolean;
}

interface EmitSpec<P = JsonValue> {
  type: string;
  payload: P;
  actorId?: string;
  entityId?: string;
  slot?: string;
  key?: string;
}

interface ScheduleSpec<P = JsonValue> {
  type: string;
  virtualTime: Millis;
  payload: P;
  priority?: number;                       // default: domain band (20)
  actorId?: string;
  entityId?: string;
  slot?: string;
  key?: string;
}
```

**INV-76.** Command handlers do not mutate world state. They validate against immutable
head state and return root domain-event specifications; those events run through normal
event handlers inside the same intervention commit. Commands request actions; domain
events change the world.

```ts
interface CommandHandler<W> {
  validate?(
    state: Readonly<W>,
    command: SerializableCommand
  ): CommandRejection | void;

  events(
    state: Readonly<W>,
    command: SerializableCommand,
    ctx: CommandContext
  ): readonly EmitSpec[];
}

interface CommandContext {
  readonly time: Millis;
  readonly commandId: CommandId;
  readonly commitId: CommitId;             // equals "commit:" + commandId
  readonly random: RandomApi;              // cause = commandId
}
```

`validate` runs before the commit opens and sees the head state untouched by this
command. `events` is pure: it reads state, returns specs, and performs no mutation and
no scheduling.

**INV-77.** Rules produce events; they never mutate the draft.

```ts
interface RuleDefinition<W> {
  id: string;                              // stable, used in ids and errors
  when: string | readonly string[];        // event type(s) that arm the rule
  if?(draft: Readonly<W>, event: AliveEvent): boolean;
  emit(draft: Readonly<W>, event: AliveEvent): readonly EmitSpec[];
}
```

Rules are evaluated in declaration order against the cumulative draft (INV-24). Rule
output is appended to the cascade in rule declaration order, then spec order within a
rule. A rule-emitted event's `parentEventId` is the event that armed the rule, and its
`slot` defaults to `"rule:" + rule.id`, which keeps its identity semantic.

```ts
interface InitContext {
  readonly epoch: string;
  readonly random: RandomApi;              // subject = "scenario", cause = "init"
}
```

`InitContext` exposes keyed randomness only. No wall-clock value, no mutable stream, no
world access — there is no world yet.

### 4.5 Temporal constraints on scheduling

**INV-71.** Ordinary scheduled work may never enter the queue at a position that
logically precedes the commit that scheduled it. While processing a source with tuple
`(cT, cP, cS)`:

| new item | rule |
|----------|------|
| `newTime > cT` | valid (subject to `scenario.endTime`) |
| `newTime == cT` | valid only if `(newTime, newPriority, newSequence) > (cT, cP, cS)` in pending-frontier order |
| `newTime < cT` | always invalid |

A newly scheduled item always draws a larger `sequence`, so same-time scheduling at
equal or numerically greater priority is valid; same-time scheduling at a priority that
would outrank the current source is not.

Violations throw `ALIVE_RETROACTIVE_SCHEDULE` and roll the whole commit back (INV-21).

`reschedule()` obeys the same relation against the current source, and additionally may
never move an item behind the committed history prefix (§6).

**Anchored user interventions are the deliberate exception.** Their position relative to
committed history is defined by their anchor, not by the tuple alone (INV-53).

**INV-23.** There is no `ctx.read()`. Handlers read current cumulative values directly
from `draft`. A child handler therefore observes mutations made by earlier handlers in
the same commit. Command validation receives an immutable view of the head *before* the
intervention commit begins; that is the only pre-commit view in the system.

**INV-24.** Cascade order within a commit is fixed:

```
1. execute the current event's handler; its draft mutations apply immediately
2. append its ctx.emit children to the cascade queue, in call order
3. evaluate rules in declaration order against the cumulative draft
4. append rule-produced events to the cascade queue, in rule declaration order
5. pop the next cascade item and repeat
```

`ctx.schedule` does not extend the cascade; it stages future work.

**INV-35.** `ctx.random` is the only randomness available to a handler.

---

## 5. Commit model

**INV-19.** A **commit** is exactly one `CommitSource` plus its entire synchronous
cascade. Scheduled work and interventions enter the *same* commit machinery.

**INV-55.** There is one commit implementation. `dispatch()` executes an intervention
commit synchronously for the HTTP mutation path using exactly the code path replay
uses. There is no separate "live" and "replay" command logic.

### 5.1 Transaction and staging

**INV-20.** A commit is transactional across **every** class of effect, not just world
state. Nothing is published until the whole cascade succeeds.

```
begin commit (source)
  ├── world draft                    (Immer produce, patches enabled)
  ├── staged events                  (ordered, with withinCommitOrder)
  ├── staged schedule additions
  ├── staged cancellations
  ├── staged reschedules
  ├── staged sequence allocations    (from a scratch counter, not the branch counter)
  ├── staged exogenous cursor advances
  └── staged observable samples
       │
  execute full synchronous cascade (INV-24)
       │
  validate limits and invariants (INV-22, JSON contract if enabled)
       │
  ┌────┴─────────────────────────────────────────────┐
  SUCCESS                                       FAILURE
  atomically publish all staged effects         discard everything:
  finalize world, queue, cursors                  world unchanged
  advance branch nextSequence                     queue unchanged
  append CommitRecord + patches                   nextSequence unchanged
  emit `committed`                                exogenous cursors unchanged
                                                  event log unchanged
                                                  no notification
                                                  error propagates to caller
```

**INV-21.** On failure nothing survives. A `ctx.schedule` performed by a parent handler
must not remain in the queue if a later child handler throws. The same holds for
`ctx.cancel` and `ctx.reschedule`. Sequence numbers allocated during a failed commit are
released; the branch counter is only advanced at publish.

```ts
interface CommitRecord {
  commitId: CommitId;
  branchId: BranchId;
  virtualTime: Millis;
  source: { kind: "scheduled" | "intervention"; id: ScheduledId | CommandId };
  schedulerTuple: { virtualTime: Millis; priority: number; sequence: number };
  events: readonly AliveEvent[];      // withinCommitOrder ascending
  patches: readonly Patch[];
  inversePatches: readonly Patch[];
}
```

### 5.2 Deterministic safety limits

**INV-22.** Limits never depend on how a caller slices `advance()`:

```ts
interface SafetyLimits {
  maxCausalDepth: number;        // default 32, per commit
  maxEventsPerCommit: number;    // default 512
  maxCommitsPerInstant: number;  // default 4096, per distinct virtualTime
}
```

Breach throws `ALIVE_CASCADE_LIMIT` with the offending chain, and the commit rolls back
under INV-21. Never truncate silently. `advance(60)` and `advance(30); advance(30)` must
be identical in every observable respect, limit behaviour included.

**INV-74.** `maxCommitsPerInstant` is **timeline state, not call state**. The branch
carries:

```ts
interface InstantGuard {
  at: Millis | null; // null before the first committed instant
  count: number;     // commits already published at `at` on this branch
}
```

On publishing a commit at time `T`: if `at !== T` the guard resets to `{ at: T, count: 1 }`,
otherwise `count` increments. The limit is checked before publish.

The guard is part of every checkpoint and is reconstructed at a fork cursor (INV-48), so a
fork taken halfway through a same-instant sequence inherits the count rather than
restarting it. It may equivalently be recomputed from the commit log; either is
acceptable provided the result is identical.

Without this, `runNext()` called repeatedly would bypass a limit that a single
`advance()` would trigger. Required test:
`limits/same-instant-survives-runNext-boundaries`.

---

## 6. Ordering

**INV-15.** The ordering model is **not** a flat tuple order over all work. It is:

```
IMMUTABLE HISTORY PREFIX          +          ORDERED PENDING FRONTIER
already-published commits                    everything not yet published
never reordered, never crossed               ordered by (virtualTime, priority, sequence)
```

Within the pending frontier the relation is `(virtualTime, priority, sequence)`, all
ascending, lower first, via an explicit binary-heap comparator unit-tested over every tie
permutation. Never `Array.prototype.sort` stability, never insertion order.

The prefix/frontier split exists because tuple ordering alone is wrong once anchors
exist. A user intervention at 10:30 with priority 0 must still fall *after* an autonomous
commit already published at 10:30 with priority 20. Its anchor (INV-53) places it in the
frontier that begins after that commit; the tuple then orders it only against other
pending work. **An anchor establishes a history prefix that tuple ordering can never
cross.**

This was stated incorrectly in Phase 0.1 as a flat total order. Corrected here.

**INV-16.** `sequence` is drawn from a per-branch monotonic counter, assigned when a
**commit source** enters that branch's frontier. Immediate `ctx.emit` children are not
commit sources and never consume a sequence number.

**INV-17.** Priority bands are fixed constants, versioned with `semanticsVersion`:

```
0    intervention      (reserved; scheduled work may not use priority 0)
10   exogenous
20   domain          (default for handler-scheduled work)
30   derived
40   observation
```

**INV-13.** `sequence` is ordering metadata. It never appears in any identity derivation
— not `EventId`, not `ScheduledId`, not `CommitId`, not `BranchId`.

**INV-71** (§4.5) prevents ordinary scheduling from inserting work behind the current
commit. Together with INV-53, nothing except an explicitly anchored intervention can ever
be positioned relative to published history, and even that only *after* it.

## 7. Notifications

### 7.1 `committed`

**INV-25.** Fires exactly once per **successful** commit, after all staged effects are
published, and never while scrubbing.

**INV-26.** The payload contains no transport concept — no query keys, no resource
keys, no HTTP, no MSW, no TanStack.

```ts
interface CommitNotification {
  commitId: CommitId;
  branchId: BranchId;
  virtualTime: Millis;
  events: readonly AliveEvent[];
}
```

During `advance()` over a long interval, notifications are queued and flushed at the end
of the call in commit order. Consumers receive every commit; coalescing is a consumer
concern.

Listener callbacks are integration code, not part of simulation semantics. If a listener
throws after a commit has published, the commit remains successful, the branch is not
faulted, and remaining listeners are still invoked. The failure is recorded and surfaced
through the separate `error` channel.

### 7.2 `timeline:changed`

**INV-27.** Fires when the view or branch topology changes, never for ordinary progress.

```ts
type TimelineChangeReason =
  | "scrub-enter" | "scrub-move" | "scrub-exit"
  | "fork" | "branch-switch" | "reset" | "replay-load";

interface TimelineChangeNotification {
  reason: TimelineChangeReason;
  branchId: BranchId;
  cursor: TimelineCursor | null;
  invalidateAll: boolean;      // true for every reason in v0.1
}
```

---

## 8. Transport layer — outside the kernel

**INV-28.** The API contract is defined by the application and lives outside
`packages/core`. The kernel never sees it.

```ts
type ResourceKey = readonly string[];      // ["products"], ["products","arc-lamp"]

interface AliveApiContract<W> {
  routes: readonly RouteDef<W>[];
  effects: readonly EffectRule[];
}

declare function defineAliveApi<W>(c: AliveApiContract<W>): AliveApiContract<W>;

type RouteDef<W> =
  | {
      method: "GET";
      path: string;
      resolve: (a: { state: Readonly<W>; params; query }) => JsonValue;
      successStatus?: number;
    }
  | {
      method: "POST" | "PATCH" | "DELETE";
      path: string;
      command: (a: { params; query; body: JsonValue }) => SerializableCommand;
      resolve?: (a: { state: Readonly<W>; params; query; body; dispatch }) => JsonValue;
      successStatus?: number;
    };

interface EffectRule {
  when: string | ((e: AliveEvent) => boolean);
  invalidate: (event: AliveEvent) => readonly ResourceKey[];
}
```

**INV-29.** `invalidate` is a pure function of the **event alone**. It must not read
world state. Notifications may be flushed after several commits, at which point live
state represents a later commit than the event being processed; deriving keys from state
would then be wrong.

Two independent consumers:

```ts
// MSW adapter — serves reads from getState(), routes mutations to dispatch()
const handlers = createAliveHandlers({ http, HttpResponse }, alive, apiContract);

// query binding — listens to both channels, maps events to keys, invalidates
bindAliveQueryInvalidation(alive, queryClient, apiContract);
```

The binding subscribes to `committed` (targeted invalidation from
`effects[].invalidate(event)`, deduplicated/coalesced in one microtask) and to
`timeline:changed` (`invalidateAll` → one full invalidation, or a configured query-prefix
invalidation so unrelated host caches are untouched).

**INV-30.** `refetchInterval` is forbidden in the demo app. Freshness comes from
`committed` → effect rules → cache invalidation. If the demo needs polling, the effect
contract is wrong.

Product Launch routes:

```
GET  /api/products   /api/orders   /api/customers   /api/tickets   /api/metrics
POST /api/orders/:id/cancel   /api/products/:id/restock   /api/tickets/:id/resolve
```

Mutation mapping:

```
accepted                     → 200 + projection of the affected resource
ALIVE_HISTORICAL_VIEW        → 409 { code, message, hint: "fork to intervene" }
ALIVE_PRECONDITION_FAILED    → 422
ALIVE_UNKNOWN_COMMAND        → 404
```

---

## 9. Playback boundary

**INV-7.** No pacing in the kernel. The demo owns:

```ts
interface PlaybackConfig {
  virtualMillisPerTick: number;   // e.g. 60_000 virtual ms per tick
  wallMillisPerTick: number;      // e.g. 250 real ms per tick
  rateMultiplier: 1 | 5 | 20;
}

interface PlaybackController {
  play(): void;
  pause(): void;
  setRate(r: 1 | 5 | 20): void;
  isPlaying(): boolean;
}
```

`1× / 5× / 20×` are multipliers of a configured **demonstration pace**, not of real
time. This is what lets the 20-second video cover several virtual hours.

The controller calls `advance(virtualMillisPerTick * rateMultiplier)` on a timer. It
stops itself before calling `enterScrub()`. Removing the controller entirely must not
change any simulation result, and timers never appear in replay semantics.

The Phase 5 React adapter reads a cached playback snapshot through
`useSyncExternalStore`. Its object identity changes only when playing/speed changes;
clock ticks still notify control-shell subscribers. This preserves INV-7 without
causing React to rerender indefinitely on an unchanged snapshot.

---

## 10. State, patches, checkpoints

**INV-40.** Immer with patches enabled, one `produce` per commit, recorded in
`CommitRecord`.

**INV-41.** Full replay from scenario inputs is authoritative. Patches and checkpoints
are acceleration only. Deleting all of them must leave every timeline reconstructible.

```ts
interface TimelineCheckpoint<W> {
  branchId: BranchId;
  cursor: TimelineCursor;
  world: W;                                  // JSON-safe
  pending: readonly ScheduledItem[];
  pendingInterventions: readonly InterventionItem[];
  nextSequence: number;
  exogenousCursors: Record<string, number>;
  scenarioId: string;
  scenarioVersion: string;
  rngVersion: number;
  semanticsVersion: number;
  engineVersion: string;
}
```

**INV-42.** A checkpoint is discarded on any mismatch of `scenarioVersion`,
`rngVersion`, or `semanticsVersion`. Never migrated; always recomputed.

Immer’s patch API constrains its TypeScript input to `Objectish`. The four internal
patch calls assert that boundary after the kernel’s JSON validation; public `W` stays
unconstrained, and the calls and replay semantics are unchanged (INV-41, INV-43, INV-58).

**INV-43.** Mandatory equivalence: at **every** commit boundary of a run,
`stateViaPatches(cursor)` deep-equals `stateViaFullReplay(cursor)`.

---

## 11. JSON-safe data contract

**INV-58.** These must contain JSON-safe plain data only:

```
world state · event payloads · command payloads · scheduled payloads
checkpoint contents · replay file contents
```

```ts
type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [k: string]: JsonValue };
```

Prohibited anywhere in those structures:

```
undefined   NaN   Infinity   -Infinity   BigInt   Date instances
Map   Set   class instances   functions   symbols   cyclic references
```

Date/time values are ISO strings. Virtual instants and durations are non-negative
`Number.isSafeInteger(...)` milliseconds. Scheduled priorities are safe integers >= 1;
priority 0 is reserved exclusively for interventions.

The TypeScript generic does not force `W extends JsonValue` (ergonomically painful with
nested records), but JSON safety is an unconditional persistence contract. Values are
validated, detached from caller-owned references and frozen when they enter persistent
world/event/scheduler history. Sparse arrays and non-data properties are rejected.
There is no public option that disables replay-safety validation. Violations throw
`ALIVE_NON_JSON_VALUE` with the offending path.

---

## 12. Replay compatibility

```ts
interface ReplayFile {
  formatVersion: 1;
  semanticsVersion: number;          // kernel behavioural semantics
  engineVersion: string;             // informational only
  scenario: { id: string; version: string };
  rng: { algorithm: "alive-splitmix64-fnv1a"; version: number; seed: string };
  branches: readonly ReplayBranch[];
  activeBranchId: BranchId;
}

interface ReplayBranch {
  id: BranchId;
  name?: string;
  parentBranchId?: BranchId;
  forkAt?: TimelineCursor;
  head: TimelineCursor;              // exact head; preserves same-time pending work
  headCommitCount: number;
  forkCommitCount?: number;
  interventions: readonly ReplayIntervention[];
  ranTo: Millis;
}

interface ReplayIntervention {
  commandId: CommandId;
  anchor: TimelineCursor;            // history through here is immutable
  command: SerializableCommand;
  virtualTime: Millis;
  priority: number;
  sequence: number;
}
```

**INV-56.** Future events are never serialized as the source of truth. Scheduling is
reproduced from scenario logic plus recorded interventions.

**INV-57.** `loadReplay` **hard-fails** on mismatch of `formatVersion`,
`semanticsVersion`, `scenario.id`, `scenario.version`, `rng.algorithm`, or
`rng.version`. `engineVersion` mismatch produces a warning only.

`semanticsVersion` exists because replay behaviour depends on scheduler ordering,
priority bands, commit batching, command injection, identity derivation, fork
reconstruction, safety limits and rule evaluation order — none of which change the JSON
shape or the RNG. A patch release that reorders rule evaluation would silently produce a
different world from the same file; `semanticsVersion` makes that a refusal instead.

A `semanticsVersion` bump is required by any change to: scheduler ordering or the
prefix/frontier model (INV-15 to INV-17, INV-71), commit batching or transaction
boundaries (INV-19 to INV-24), clock advancement or horizon inclusivity (INV-72, INV-73),
the same-instant guard (INV-74), command injection or anchoring (INV-52, INV-53),
identity derivation (INV-10 to INV-12, INV-69, INV-70, DETERMINISM §4–§9), the canonical
tuple encoding (INV-75), fork reconstruction (INV-48, INV-49), or rule evaluation order
(INV-24, INV-77).

---

## 13. Repository and naming

```
alive/
├── apps/demo-store/        Phase 5: implemented React + Vite + TanStack Query + devtools
├── packages/
│   ├── core/               kernel; only runtime dep is immer
│   ├── integration/        API/effect contract + query invalidation binding
│   └── msw/                integration contract → MSW v2 handlers
├── scenarios/product-launch/
├── docs/
└── CLAUDE.md
```

The API/effect contract and query binding live in `packages/integration`; the MSW adapter lives in `packages/msw`. The concrete Product Launch scenario, browser playback controller and devtools live in `apps/demo-store` and remain application concerns rather than kernel dependencies.

pnpm workspaces · TypeScript strict · Vitest · ESLint · Prettier · GitHub Actions
(install, lint, typecheck, test, build). No `any` in public API. No placeholder
implementations. Nothing published to npm; packages are private `@alive-internal/*`.

---

## 14. Invariant registry

Every ID below describes one concept. The "Home" column is its authoritative definition;
restatements elsewhere must not conflict with it.

| ID | Concept | Home |
|----|---------|------|
| INV-1 | Kernel owns world state, not host state | ARCH §1 |
| INV-2 | Kernel imports no framework or transport library | ARCH §1 |
| INV-3 | Kernel fully usable with no API contract present | ARCH §1 |
| INV-4 | `getState()` is view state | ARCH §2 |
| INV-5 | `getHeadState()` is active branch head | ARCH §2 |
| INV-6 | Dispatch while scrubbed throws `ALIVE_HISTORICAL_VIEW` | ARCH §2 |
| INV-7 | No playback or wall-clock dependence in kernel | ARCH §3, §9 |
| INV-8 | Events immutable; storage identity `(branchId, eventId)` | ARCH §4.2 |
| INV-9 | `eventId` is branch-independent | ARCH §4.2 |
| INV-10 | Event identity is semantic, never positional | DET §4 |
| INV-11 | No automatic occurrence numbering; collisions throw | DET §5 |
| INV-12 | `ScheduledId` derivation rules per origin | DET §6 |
| INV-13 | `sequence` is ordering metadata, never identity | ARCH §6 |
| INV-14 | `withinCommitOrder` never feeds identity, RNG or alignment | ARCH §4.2 |
| INV-15 | Total order `(virtualTime, priority, sequence)`, explicit comparator | ARCH §6 |
| INV-16 | `sequence` allocated per branch, to commit sources only | ARCH §6 |
| INV-17 | Fixed versioned priority bands | ARCH §6 |
| INV-18 | Scheduler items are serializable plain data | ARCH §4.3 |
| INV-19 | Commit = one `CommitSource` + full synchronous cascade | ARCH §5 |
| INV-20 | Commit is transactional across all staged effect classes | ARCH §5.1 |
| INV-21 | Failed commit discards everything, emits nothing | ARCH §5.1 |
| INV-22 | Safety limits independent of `advance()` slicing | ARCH §5.2 |
| INV-23 | No `ctx.read()`; handlers read the cumulative draft | ARCH §4.4 |
| INV-24 | Fixed cascade and rule evaluation order | ARCH §4.4 |
| INV-25 | `committed` fires once per successful commit, never while scrubbing | ARCH §7.1 |
| INV-26 | `CommitNotification` contains no transport concept | ARCH §7.1 |
| INV-27 | `timeline:changed` covers view and topology only | ARCH §7.2 |
| INV-28 | API contract lives outside the kernel and outside the scenario | ARCH §4.1, §8 |
| INV-29 | `invalidate` derives from the event alone | ARCH §8 |
| INV-30 | No `refetchInterval` in the demo | ARCH §8 |
| INV-31 | RNG is keyed and stateless | DET §3 |
| INV-32 | `branchId` is never RNG entropy | DET §3 |
| INV-33 | `BigInt` confined to the RNG module | DET §3 |
| INV-34 | No platform-dependent string hashing | DET §3 |
| INV-35 | `ctx.random` is a handler's only randomness | ARCH §4.4 |
| INV-36 | Golden vectors pin RNG output; change bumps `rng.version` | DET §3.2 |
| INV-37 | No iteration-order dependence | DET §1 |
| INV-38 | Exogenous streams receive no world state | DET §8 |
| INV-39 | Exogenous cursors checkpointed and inherited at fork | DET §8 |
| INV-40 | One Immer `produce` with patches per commit | ARCH §10 |
| INV-41 | Full replay authoritative; patches/checkpoints acceleration | ARCH §10 |
| INV-42 | Checkpoints discarded on version mismatch, never migrated | ARCH §10 |
| INV-43 | Patch/replay equivalence at every commit boundary | ARCH §10 |
| INV-44 | Cursors identify commit boundaries, never intra-commit | TL §1 |
| INV-45 | Playback stops before scrub; kernel has no running state | TL §2 |
| INV-46 | Scrub mutates nothing | TL §2 |
| INV-47 | Fork preserves the parent branch and its entire future | TL §4 |
| INV-48 | Fork reconstructs historical timeline state by checkpoint + replay | TL §4.1 |
| INV-49 | Fork `nextSequence` is the reconstructed value at the cursor | TL §4.1 |
| INV-50 | `switchBranch` while scrubbed exits scrub first | TL §5 |
| INV-51 | Interventions are commands, not events | ARCH §4.3 |
| INV-52 | Every intervention records `commandId`, anchor and resolved tuple | TL §6 |
| INV-53 | History through the anchor is immutable | TL §6 |
| INV-54 | `commandId` is deterministic; no UUIDs | DET §7 |
| INV-55 | One commit machinery for live dispatch and replay | ARCH §5 |
| INV-56 | Future events never serialized as source of truth | ARCH §12 |
| INV-57 | Hard-fail replay on format/semantics/scenario/RNG mismatch | ARCH §12 |
| INV-58 | JSON-safe data contract | ARCH §11 |
| INV-59 | Observables declared by scenario, split by kind | TL §7 |
| INV-60 | Step-function sampling on the union grid | TL §7.1 |
| INV-61 | Both branches must have fully evaluated the horizon | TL §8 |
| INV-62 | `causalLanguagePermitted` is machine-checkable | TL §8.1 |
| INV-63 | Causal wording always scoped "in this simulation" | TL §8.1 |
| INV-64 | ALIVE gated by explicit build flag, off by default in consumer builds | TL §10 |
| INV-65 | Fictional data only; never connects to production services | TL §10 |
| INV-66 | Tests are never weakened to make an implementation pass | DET §10 |
| INV-67 | Product Launch stockout regression window | DET §11 |
| INV-68 | Window achieved by parameter tuning, never hard-coding | DET §11 |
| INV-69 | `CommitId` derivation and branch-independence | DET §8 |
| INV-70 | `BranchId` derivation | DET §9 |
| INV-71 | No retroactive scheduling or rescheduling | ARCH §4.5 |
| INV-72 | Exact clock advancement; no `queue-empty` stop | ARCH §3.1 |
| INV-73 | A commit at the horizon is inside the horizon | ARCH §3.1 |
| INV-74 | Same-instant guard is timeline state, not call state | ARCH §5.2 |
| INV-75 | Canonical versioned tuple encoding for all hashing | DET §3.0 |
| INV-76 | Command handlers emit events; they never mutate state | ARCH §4.4 |
| INV-77 | Rules emit events; they never mutate the draft | ARCH §4.4 |
| INV-78 | Only numeric state observables may be sampled `every-commit` | TL §7 |

---

# Architecture Adversarial Review

Each case was tested against the semantics above. Where a case broke the design, the
correction is recorded and folded into the invariants.

### A. Conditional sibling emission

Stock ≤ 3 gates an `inventory.low` emit; `revenue.changed` always follows. In a fork
with stock 11 the first emit is suppressed.

Positional identity would shift `revenue.changed`'s index, change its id, and break
every RNG draw keyed on it. Under INV-10 its id derives from `(parentEventId, type,
slot)`. `withinCommitOrder` shifts from 1 to 0 and, under INV-14, affects nothing else.
**Holds.**

### B. Restock counterfactual — demand stability

`ExogenousStream.next()` takes no world state (INV-38) and keys draws on
`(streamId, ordinal)`. Arrival times, customer identities and purchase intents are
identical across branches regardless of inventory.

Legitimate divergence remains: a customer who finds the lamp sold out in the baseline
may buy an Orbit Stand there and an Arc Desk Lamp in the fork. That is a consequence of
the intervention, and the comparison should show it. **Holds.**

### C. Commit rollback

A parent handler mutates stock, calls `ctx.schedule` for a restock reminder, then a
child handler throws.

Under the staging model (INV-20, INV-21): the world draft is discarded, the staged
schedule addition never reaches the queue, the scratch sequence allocation is released
so `nextSequence` is unchanged, exogenous cursors are unchanged, no `CommitRecord` is
appended, and no `committed` notification fires. The caller receives the error.

This was a defect in the Phase 0 documents, which scoped the transaction to world state
only. **Corrected.** Test: `commit/rollback-is-total`.

### D. Atomic cursor

A commit contains four domain events. A fork is attempted "after event 2".

`TimelineCursorInput` cannot express it: positions are `{ time }`, `{ afterCommitId }`
or `{ commitIndex }`. A raw event id is not a cursor input. `{ time: T }` resolves to
the last **commit** at or before T, never inside one. Attempting to construct a cursor
from an intra-commit event throws `ALIVE_INVALID_CURSOR`.

There is no valid state "after child 2 but before child 3", because the commit is a
single atomic transition. This was wrong in Phase 0, which used `afterEventId`.
**Corrected, INV-44.** Test: `cursor/no-intra-commit-position`.

### E. Late same-timestamp intervention

An autonomous event commits at 10:30:00.000. The user then dispatches a restock while
the clock still reads 10:30:00.000. Priority 0 alone would replay the restock *before*
the already-committed event, rewriting history.

The anchor cursor fixes it: the intervention records
`anchor = (10:30:00.000, afterCommitId = C_that_event)`. Replay reconstructs through the
anchor first — that commit is history and immutable — then injects the intervention and
applies its `(priority, sequence)` only against work still pending after the anchor.

This was a real defect in Phase 0. **Corrected, INV-52 and INV-53.** Test:
`intervention/anchor-preserves-committed-history`.

### F. Historical fork queue

The baseline has already run to 14:00. Its head queue no longer holds the items that
were pending at 10:30 and have since executed. Filtering the head queue would produce a
fork missing most of its future.

INV-48 requires reconstruction: restore the nearest checkpoint at or before the cursor,
replay deterministically to the cursor, capture world, pending queue, pending
interventions, `nextSequence` and exogenous cursors, then clone that historical snapshot.
Phase 0 said "inherits pending items" without saying from where. **Corrected.** Test:
`fork/reconstructs-historical-queue`.

### G. Semantic collision without a discriminator

One parent emits three `payment.attempted` children on the same entity. All three derive
the same semantic id.

Automatic occurrence numbering would reintroduce positional identity: suppress the first
attempt in a fork and the remaining two are renamed. Instead the kernel throws
`ALIVE_EVENT_ID_COLLISION` naming the parent, type and entity, and the author supplies
`key: paymentAttemptId`. **Corrected, INV-11.** Test: `identity/collision-throws`.

### H. API independence

A headless simulation is created with no MSW, no routes, no `ResourceKey`s, no query
client and no `AliveApiContract`. It runs, commits, emits `committed`, forks, compares
and replays. `Scenario<W>` has no `api` field to omit. The Phase 0 documents violated
this by embedding the contract in the scenario and query keys in the notification.
**Corrected, INV-3, INV-26, INV-28.** Test: `kernel/headless-no-transport`.

### I. Advance granularity

`advance(60)` vs `advance(30); advance(30)`: the queue drains in total order either way,
and INV-22 forbids per-call limits. Only notification flush boundaries differ, which is
not semantic. Test asserts identical event log, state, commit ids and RNG draw set.
**Holds.**

### J. Checkpoint deletion

Delete every checkpoint and patch set. Each branch reconstructs from
`scenario + seed + forkAt cursor + interventions (with anchors)`, recursively through
parents to the root. INV-41 and INV-56. **Holds.**

### K. Branch switch while scrubbed

Resolved: exits scrub first, emitting `scrub-exit` then `branch-switch`. A cursor on
branch A is meaningless on B beyond common ancestry. **Resolved, INV-50.**

### L. Observable grid misalignment

Two branches have different commit boundaries, so `every-commit` series sit on different
grids. Each series is a step function sampled on the union of both grids up to the
horizon. **Resolved, INV-60.**

### M. Horizon not reached

`compareBranches` throws `ALIVE_HORIZON_NOT_REACHED` unless both branches have fully
evaluated the horizon: `ranTo >= horizon` **and** no pending frontier source remains at
or before the horizon. This closes the same-timestamp intervention hole where the branch
clock already equals T but ordinary work at T is still pending. Otherwise an incomplete
branch could report "did not occur" and the panel would make a false claim.
**Resolved, INV-61.**

### N. Sibling-branch comparison

Two sibling branches each carry their own post-ancestry interventions. A single
`interventions` array cannot express that. `ComparisonReport.interventions` is
`{ a, b }`, both listing interventions after the common ancestry cursor, and
`causalLanguagePermitted` requires `a` to be empty and `b` to hold exactly one.
**Corrected, INV-62.** Test: `compare/sibling-branches`.

### O. Public showcase build

`import.meta.env.DEV` gating would make the hosted demo impossible, since production
builds have `DEV === false`. Replaced by an explicit `VITE_ALIVE_ENABLED` flag: off by
default in consumer production builds, explicitly on for the official deployment, on in
local development. **Corrected, INV-64.** Test: two build configurations asserted in CI.


### P. Composite: late intervention, same-time child, past reschedule, empty interval, deep fork

A single walkthrough exercising five corrections at once. Baseline branch
`branch:root`, all times on the same instant T = 10:30:00.000 unless stated.

**1. One hundred same-time commits.** An exogenous burst produces 100 commit sources at
T. They drain in frontier order `(T, 10, s₁…s₁₀₀)`. The `InstantGuard` reaches
`{ at: T, count: 100 }` on the branch (INV-74), well under the 4096 default.

**2. Ordinary same-time scheduled child.** During commit 40, a handler calls
`ctx.schedule({ type: "inventory.audit", virtualTime: T, priority: 20 })`. Current tuple
is `(T, 10, s₄₀)`; the new item gets `(T, 20, s_new)` with `s_new > s₄₀`. Same time,
numerically greater priority, larger sequence → strictly after the current source in the
frontier → accepted (INV-71). It executes after the remaining burst items only because
priority 20 sorts after 10, which is the intended semantic.

**3. Past reschedule attempt.** During commit 60 a handler calls
`ctx.reschedule(auditId, T - 5min)`. That is behind the committed history prefix, so it
throws `ALIVE_RETROACTIVE_SCHEDULE` and **commit 60 rolls back entirely** (INV-21): its
world mutations, its staged schedule calls, its sequence allocations, and the
`InstantGuard` increment are all discarded. The guard remains at 59. Without INV-21 the
guard would have been corrupted by a failed commit.

**4. Fork halfway through.** The user scrubs to `(T, afterCommitId = commit:…₅₀)` and
forks. Reconstruction (INV-48) restores the nearest checkpoint, replays to that cursor,
and captures world state, the 50 still-pending burst items with their original sequences,
pending interventions, `nextSequence`, exogenous cursors, **and the `InstantGuard` at
`{ at: T, count: 50 }`**. The fork therefore continues counting toward the same-instant
limit rather than restarting — which is the whole point of INV-74 being timeline state.

`BranchId` for the fork is `hash("branch", "branch:root", canonicalCursor, 0)` (INV-70),
stable across replay.

**5. Late intervention at the same timestamp.** On the fork, the user dispatches a
restock while head time still reads T, after commit 50 has published. The intervention
records `anchor = (T, commit:…₅₀)`, `commandId` derived from
`(branchId, anchor, type, canonicalJson(payload), nthAtAnchor=0)` (INV-54),
`commitId = "commit:" + commandId` (INV-69), and tuple `(T, 0, s_new)`.

Priority 0 orders it **first in the frontier that begins after the anchor** — ahead of
the 50 remaining burst items — but it cannot precede commits 1–50, because the anchor
makes that prefix immutable (INV-15, INV-53). A flat tuple order would have placed it
before all 100. This is the case that forced the ordering model to be rewritten.

**6. Empty interval advance.** Both branches are then advanced to the 14:00 horizon.
Between the last commit at ~11:12 and 14:00 the queue is empty on the fork. Under INV-72
the clock still reaches 14:00, head time is set to the target, and `ranTo = 14:00` on
both branches — so `compareBranches(..., { until: 14:00 })` does not throw
`ALIVE_HORIZON_NOT_REACHED` (INV-61). Under the old `"queue-empty"` stop reason the fork
would have stalled at 11:12 and the hero comparison would have been impossible to
perform. **Corrected.**

**7. Horizon inclusivity.** Had the baseline stockout landed exactly at 14:00, INV-73
counts it as `before-horizon`, so the comparison reports a stockout rather than silently
dropping it at the boundary.

Every step holds under the Phase 0.2 semantics. Steps 3, 4, 5 and 6 would each have
failed under Phase 0.1.

### Q. Remaining known weakness

A scenario author can still break determinism by closing over module-level mutable state
in a handler. The `ctx.random`-only surface, the removal of `ctx.read()` and lint rules
make the correct path easiest, but this is convention-enforced, not type-enforced.
Accepted for v0.1; the same-seed regression test catches it in CI for the one shipped
scenario.

## Connected workspace validation

Workspace imports resolve the packages’ built `dist` exports. Root typecheck and test
commands, plus demo dev/build commands, explicitly build the three internal packages
first so a clean checkout needs no pre-existing outputs. MSW worker generation uses
`msw init public --no-save` to avoid interactive install prompts. These setup changes
preserve INV-2, INV-3 and INV-28; no transport dependency enters the kernel.
