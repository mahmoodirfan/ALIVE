# DETERMINISM.md — ALIVE v0.1

The determinism contract. If any rule here is violated, counterfactual comparison stops
meaning anything, because differences between branches can no longer be attributed to
the intervention.

The claim ALIVE must be able to defend:

```
same scenario + same scenario version
+ same seed + same RNG version
+ same semanticsVersion
+ same interventions (with commandId, anchor and resolved tuple)
= byte-identical commit log, event log and state
```

Invariant numbers refer to the registry in ARCHITECTURE.md §14.

---

## 1. Forbidden constructs

Inside `packages/core` and `scenarios/**`:

```
Math.random()      Date.now()      new Date() with no argument
performance.now()  crypto.randomUUID()   module-level mutable state
```

**INV-37.** Object iteration order must never influence results. Where a handler
iterates entities it iterates a sorted key array, never raw `Object.keys` order.
Enforced by a shuffled-insertion-order test asserting identical outcomes.

---

## 2. No global sequential RNG

Forbidden:

```ts
const rand = seededRandom(seed);
rand(); rand(); rand();
```

One mutable stream means a single extra draw anywhere shifts every later draw
everywhere. A fork consuming a different number of samples produces an entirely
different world, and the counterfactual becomes noise. This is the most important
kernel decision in the project.

---

## 3. Canonical tuple encoding

**INV-75.** Every hash input in ALIVE is produced by one versioned canonical tuple
encoder. Delimiter-joined strings are forbidden: `"a␟b" + "c"` and `"a" + "b␟c"` collide
whenever a component contains the delimiter, which silently fuses two distinct RNG keys
or two distinct entity ids.

Used by RNG keys, `EventId`, `ScheduledId`, `CommitId`, `BranchId` and `CommandId`
derivation. There is exactly one encoder; no call site builds its own string.

```ts
type TupleComponent =
  | ["s", string]     // UTF-8 string
  | ["i", number]     // finite integer; non-integers rejected
  | ["b", boolean]
  | ["z", null];      // explicit null / absent

declare function encodeTuple(
  components: readonly TupleComponent[]
): Uint8Array;
```

Wire format, `tupleEncodingVersion = 1`:

```
version byte           0x01
component count        decimal, ASCII, then 0x00
for each component:
    tag byte           's' | 'i' | 'b' | 'z'
    byte length        decimal ASCII of the UTF-8 payload length, then 0x00
    payload bytes      UTF-8 bytes (empty for 'z')
```

Length-prefixing makes the encoding unambiguous: a component may contain any byte
sequence, including `0x00`, separators, or the empty string, without affecting decoding
boundaries.

Rules:

- `"i"` components must be finite integers. Decimal, no exponent, no `+`, no leading
  zeros, `-0` normalised to `0`. `NaN`, `Infinity` and non-integers throw.
- Absent optional fields encode as `["z", null]`, never as `["s", ""]`. An entity id of
  `""` and an absent entity id must not collide.
- Strings are encoded as UTF-8 from an explicit encoder, never via `charCodeAt`
  (INV-34), and are **not** Unicode-normalised: `"é"` as U+00E9 and as U+0065 U+0301 are
  distinct components. Scenario authors who need them equal must normalise their own ids.
- `canonicalJson(value)` — used for command payloads (§7) — sorts object keys by UTF-16
  code unit, emits no whitespace, rejects any non-JSON value (INV-58), and is passed to
  the encoder as a single `"s"` component.

`tupleEncodingVersion` is part of both RNG compatibility and `semanticsVersion`.
Changing it changes every derived id and every random draw.

Golden vectors must cover: components containing `0x00`, `␟` and newlines; empty
strings; absent-vs-empty distinction; multi-byte and astral-plane Unicode; and integers
at `Number.MAX_SAFE_INTEGER` and `0`/`-0`.

---

## 4. Keyed RNG

**INV-31.** Randomness is a pure function of a key. No stream, no cursor, no mutable
state anywhere in the RNG.

```ts
interface RngKey {
  seed: string;        // public seed type is string
  subject: string;     // actorId | entityId | streamId | "scenario"
  cause: string;       // causal eventId, commandId, or exogenous anchor (§11)
  purpose: string;     // "purchase-decision", "quantity", ...
  draw: number;        // disambiguates multiple draws of one purpose
}
```

**INV-32.** `branchId` is never RNG entropy. Two branches reaching the same key get the
same value; that is what makes comparison valid.

Derivation, over the canonical encoding of §3 — never over a joined string:

```
bytes = encodeTuple([
          ["s", seed], ["s", subject], ["s", cause],
          ["s", purpose], ["i", draw]
        ])
h     = fnv1a64(bytes)
u     = splitmix64(splitmix64(splitmix64(h)))
float = top 53 bits of u / 2^53
```

**INV-33.** `BigInt` is permitted only inside the RNG module. It must never appear in
world state, event payloads, Immer patches, checkpoints or replay JSON (INV-58). The
module's public surface returns `number`, `boolean` or `string` only.

**INV-34.** No platform-dependent string hashing. FNV-1a runs over UTF-8 bytes from an
explicit encoder, never over `charCodeAt`, so results match across runtimes.

### 3.1 Scenario-facing API

The context knows `seed`, `cause` (the current event's id) and `subject` (its
actor/entity), so scenario code stays short:

```ts
ctx.random.chance(0.42, "purchase-decision")
ctx.random.float("discount-sensitivity")
ctx.random.int("quantity", 1, 4)
ctx.random.pick("product-choice", productIds)
ctx.random.exponential("interarrival", meanMs)
ctx.random.float("product-choice", 1)                 // explicit draw index
ctx.random.for({ subject: actorId }).chance(0.3, "follow-up")
```

**INV-35.** `ctx.random` is the only randomness available inside a handler.

### 3.2 Golden vectors

**INV-36.** `packages/core/test/rng.golden.test.ts` pins exact outputs for a fixed key
set:

```ts
expect(rng.float({ seed: "northstar-001", subject: "cust-7",
                   cause: "evt:...", purpose: "purchase-decision", draw: 0 }))
  .toBe(/* exact literal */);
```

Changing the algorithm changes these values, requires an `rng.version` bump, and
invalidates every existing replay file. Intentional: the RNG is part of the replay
format contract.

---

## 5. Event identity

**INV-10.** Event ids derive from **semantic** identity, never from positional emission
order. Positional identity reintroduces the sequential-stream bug one level up: a
suppressed conditional sibling shifts its neighbours' indices, changing their ids and
every draw keyed on them.

All `hash(...)` below means `fnv1a64(encodeTuple([...]))` rendered as lowercase hex with
a namespace prefix. Components are passed to the encoder individually (§3); they are
never joined into a string first.

```
root of a scheduled commit:
  eventId = scheduledId                                    (§7)
  — this covers every ScheduledItem origin: bootstrap, exogenous and
    handler-scheduled. An exogenous root does NOT get a second `evt:` identity;
    its `sch:` id derived from (streamId, ordinal) is its event id.

root event(s) of an intervention commit:
  eventId = "evt:" + hash(["s",commandId], ["s",type], discriminator)

handler-emitted child:
  eventId = "evt:" + hash(["s",parentEventId], ["s",type], discriminator)

discriminator = ["s", key ?? slot ?? entityId ?? actorId]  when one is present
              = ["z", null]                                when none is
```

One source, one root identity. A commit's root event id is always recoverable from
`CommitRecord.source.id`, and `commitId === "commit:" + source.id` (§9) holds for both
kinds of source. Children of an exogenous root use ordinary semantic child identity.

The `["z", null]` case is why absent and empty discriminators must not collide: an event
with `entityId: ""` and one with no entity at all are different events.

`withinCommitOrder` is never an input (INV-14). Neither is `sequence` (INV-13).

`slot` is an author-supplied label distinguishing children of the same type emitted for
different reasons:

```ts
ctx.emit({ type: "inventory.changed", entityId: id, slot: "sale" });
ctx.emit({ type: "inventory.changed", entityId: id, slot: "reservation" });
```

`key` is an author-supplied domain identifier for genuine repeats:

```ts
ctx.emit({ type: "payment.attempted", entityId: orderId, key: paymentAttemptId });
```

---

## 6. Collisions throw; they are never repaired positionally

**INV-11.** If two events within a branch derive the same `EventId`, the kernel throws:

```
ALIVE_EVENT_ID_COLLISION
  parent:  evt:order-a1042
  type:    payment.attempted
  entity:  order-a1042
  hint:    supply a stable `key` (e.g. paymentAttemptId) or `slot`
```

The commit rolls back under INV-21.

There is **no automatic occurrence numbering**. Numbering three repeated children 0, 1, 2
by encounter order means suppressing the first in a fork renames the other two — exactly
the positional failure INV-10 exists to eliminate.

`occurrence`, if a scenario uses it at all, must be an explicitly supplied
domain-stable value, never inferred from call order. In practice `key` covers every case
and `occurrence` is not part of the v0.1 API.

Correctness over convenience: an author who has genuine duplicates must name them.

---

## 7. ScheduledId derivation

**INV-12.** `scheduledId` becomes the root `EventId` of its commit, so it is part of
determinism. Every origin has an explicit rule. `sequence` is never an input (INV-13).

### Bootstrap

Requires an explicit stable scenario key:

```ts
bootstrap: [
  { key: "launch-opens", type: "store.opened", virtualTime: 0, priority: 20, payload: {} },
]

scheduledId = "sch:" + hash(["s","bootstrap"], ["s",scenarioId],
                           ["s",scenarioVersion], ["s",key])
```

Omitting `key` is a scenario validation error.

### Exogenous

```
scheduledId = "sch:" + hash(["s","exo"], ["s",streamId], ["i",ordinal])
```

### Handler-scheduled

```
scheduledId = "sch:" + hash(["s","sched"], ["s",parentEventId],
                           ["s",type], discriminator)
```

If two schedule calls in the same branch derive the same id, the kernel throws
`ALIVE_SCHEDULED_ID_COLLISION` and the commit rolls back. Enqueue position is never
used to disambiguate.

### Intervention

An intervention commit has no `ScheduledId`. Its root identity is the persisted
`commandId` (§8), and its `CommitId` derives from that (§9). Its emitted events derive
from `commandId` as shown in §5.

---

## 8. Command identity

**INV-54.** `commandId` is deterministic and persisted. No UUIDs, no counters that
depend on wall time.

```
commandId = "cmd:" + hash(
  ["s", branchId],
  ["i", anchor.virtualTime],
  anchor.afterCommitId ? ["s", anchor.afterCommitId] : ["z", null],
  ["s", command.type],
  ["s", canonicalJson(command.payload)],
  ["i", nthAtAnchor]     // 0-based index among commands dispatched at this exact anchor
)
```

`branchId` appears here because a command is a user act on a specific branch, not a
simulation outcome — this is identity, not RNG entropy, so INV-32 is not violated.

`nthAtAnchor` is deterministic on replay because the replay file lists interventions in
their recorded order with their recorded anchors; it is not an execution-position
counter in the sense INV-10 forbids, since the anchor fully pins the position.

`canonicalJson` sorts object keys and rejects non-JSON values, so payload formatting
cannot change the id.

The `commandId` is written into the replay file and **reused verbatim** during replay —
never recomputed from a different anchor.

---

## 9. CommitId derivation

**INV-69.** `CommitId` is deterministic, branch-independent, and derived from the commit
source. It never depends on `sequence`, a UUID, or a wall clock.

```
scheduled commit:      commitId = "commit:" + scheduledId
intervention commit:   commitId = "commit:" + commandId
```

The namespace prefix keeps the two spaces disjoint and makes a commit id
self-describing in logs.

Every commit has exactly one source (INV-19), and every source has a deterministic id
(§7, §8), so every commit has a defined id — including a command that emits no events.

Commit storage identity is `(branchId, commitId)`, exactly parallel to event storage
identity `(branchId, eventId)` (INV-8). Two branches that reach the same causal commit
give it the same `CommitId`, which is what lets `compareBranches` align commit logs when
testing common ancestry (INV-62 condition 1), and what makes a `TimelineCursor` carrying
`afterCommitId` meaningful when a fork inherits history.

Note the asymmetry with `CommandId`, which *does* include `branchId` (§7). A command is a
user act on a specific branch; a commit is the execution of a source. A scheduled commit
replayed identically in two branches is the same commit. An intervention is not shared
across branches in the first place, so its branch-dependent id does not break
branch-independence for anything that is.

---

## 10. BranchId derivation

**INV-70.** Branch ids are deterministic and persisted. No UUIDs, no wall clock.

```
root branch:  branchId = "branch:root"          (stable constant)

fork:         branchId = "branch:" + hash(
                ["s", "branch"],
                ["s", parentBranchId],
                ["i", forkCursor.virtualTime],
                forkCursor.afterCommitId ? ["s", forkCursor.afterCommitId]
                                         : ["z", null],
                ["i", forkOrdinalAtCursor]
              )
```

`forkOrdinalAtCursor` is the 0-based count of forks already created from that exact
cursor on that parent branch. Branch creation is an explicit user action, not a simulated
outcome, so an ordinal is deterministic for the same sequence of user actions — which is
precisely what replay reproduces.

`branchId` matters to determinism because `CommitRecord` stores it, the replay file
stores it, and `commandId` includes it (§8). A non-deterministic branch id would break
the byte-identical replay claim through the command id alone.

Replay persists each branch id and **reuses it verbatim** rather than recomputing it, so
that a future change to the ordinal rule cannot silently rewrite the ids inside an
existing file. A mismatch between a stored id and the recomputed one is a
`semanticsVersion` concern, caught by INV-57.

---

## 11. Exogenous vs endogenous

This section is why the Product Launch counterfactual means anything.

**Exogenous** — driven in from outside; must not depend on world state: customer arrival
times, which customer arrives, what they intend to buy, their traits.

**Endogenous** — consequences of world state: whether the purchase succeeds, whether
stock runs out, whether a ticket opens, whether a substitute is bought.

**INV-38.** Exogenous behaviour comes from declared `ExogenousStream`s and is identical
across all branches of a run.

```ts
interface ExogenousStream<W> {
  id: string;
  from: Millis;
  until?: Millis;
  // world-independent by signature: receives no state
  next(args: { ordinal: number; lastTime: Millis; random: RandomApi }): {
    virtualTime: Millis;
    type: string;
    payload: JsonValue;
    actorId?: string;
    key?: string;
  } | null;
}
```

- `next()` receives **no world state**. It cannot see inventory. Enforced by the
  signature, not by convention. The `W` parameter exists only for typing the stream's
  emitted payloads against the scenario.
- Draws inside `next()` key on `subject = streamId`,
  `cause = "exo:" + streamId + ":" + ordinal`.
- Items therefore have identical times, identities and payloads in every branch.

Stated plainly: **restocking inventory cannot conjure new customers.** The same
customers arrive at the same moments with the same intent; only what happens when they
meet the world differs.

**INV-39.** Per-stream `ordinal` high-water marks (`exogenousCursors`) are part of every
checkpoint and are inherited at fork, so a fork continues a stream rather than
restarting it.

---

## 12. Ordering determinism

**INV-15.** `(virtualTime, priority, sequence)`, all ascending, lower first, explicit
heap comparator, never `sort` stability.

**INV-16.** `sequence` comes from a per-branch monotonic counter assigned when a commit
source enters the queue. Immediate `ctx.emit` children never consume one.

**INV-17.** Priority bands: intervention 0, exogenous 10, domain 20, derived 30,
observation 40.

**INV-49.** At fork, the new branch's `nextSequence` is the value reconstructed at the
fork cursor. Inherited pending items keep their sequences; new items continue from that
counter. Collisions are impossible and inherited relative order is preserved.

**INV-52/53.** Interventions are injected at their recorded anchor. History through the
anchor is immutable; the recorded `(priority, sequence)` orders the intervention only
against work still pending after the anchor. Priority 0 therefore means "before pending
same-instant work", never "before already-committed same-instant history".

Tie-ordering tests must cover: same time different priority; same time same priority
different sequence; interventions and scheduled items at one instant; a late intervention
at the timestamp of an already-committed event; and all permutations of enqueue order
producing the same execution order.

---

## 13. Mandatory tests

**INV-66.** Tests are never weakened to make an implementation pass. If a test is wrong,
fix it in a separate commit with an explanation.

Phase 1–3 must ship all of these.

**Determinism**
1. Same seed → identical commit ids, event ids, order, timestamps, state.
2. Different seeds → legitimately different, internally consistent runs.
3. Draw isolation — an extra `ctx.random` draw in one unrelated handler leaves every
   other actor's draws unchanged.
4. Sibling suppression — suppressing a conditional sibling leaves unrelated sibling ids
   and draws unchanged; only `withinCommitOrder` shifts.
5. Exogenous stability — after forking and intervening on inventory, arrival times,
   customer identities and purchase intents are identical across branches.
6. Tie ordering — as §12.
7. Advance granularity — `advance(60)` equals `advance(30); advance(30)` in event log,
   state, commit ids, RNG draw set and limit behaviour.
8. Cross-runtime RNG golden vectors pass in Node and a browser-like environment.

**Commit transaction**
9. `commit/rollback-is-total` — a parent mutates state and calls `ctx.schedule`, a child
   throws; afterwards world, queue, `nextSequence`, exogenous cursors and event log are
   all unchanged and no notification fired.
10. Rollback also covers `ctx.cancel` and `ctx.reschedule`.

**Identity**
11. `identity/collision-throws` — ambiguous duplicate children throw
    `ALIVE_EVENT_ID_COLLISION`; adding a `key` resolves it.
12. `identity/scheduled-id-stability` — suppressing an unrelated sibling does not rename
    pending scheduled work.

**Cursors and timelines**
13. `cursor/no-intra-commit-position` — a fork or scrub targeting a position inside a
    multi-event commit is rejected.
14. Scrub immutability — scrubbing changes no branch, queue or history.
15. Fork preservation — the baseline future survives forking.
16. `fork/reconstructs-historical-queue` — forking a baseline already run to 14:00 at a
    10:30 cursor yields the queue that existed at 10:30, not the 14:00 queue.

**Interventions and replay**
17. `intervention/anchor-preserves-committed-history` — a command dispatched at the
    timestamp of an already-committed event replays after that event despite priority 0.
18. Full replay — export and reload; intermediate and final states match.
19. Patch/replay equivalence at every commit boundary (INV-43).
20. Checkpoint deletion — drop all checkpoints and patches; every branch reconstructs
    identically.
21. `replay/semantics-version-refused` — a file with a different `semanticsVersion` is
    rejected, not warned.

**Contracts**
22. `json/contract-violation` — a handler writing `undefined`, `NaN`, a `Date` or a
    `Map` into world state fails development validation with the offending path.
23. `kernel/headless-no-transport` — a simulation with no MSW, routes, resource keys,
    query client or API contract runs, commits, notifies, forks, compares and replays.

**Comparison**
24. `compare/sibling-branches` — two siblings report interventions on both sides, and
    `causalLanguagePermitted` is false.
25. Counterfactual correctness — baseline stocks out, restock branch does not, the
    report detects it.

**Identity derivation (Phase 0.2 additions)**
26. `commit-id/stable-across-branches` — the same causal scheduled commit carries the
    same `CommitId` in baseline and fork.
27. `branch-id/deterministic-fork` — the same sequence of user fork actions yields the
    same branch ids across runs and across replay.
28. `hash/tuple-encoding-unambiguous` — components containing separators, NUL bytes and
    newlines never collide; absent and empty discriminators differ.
29. `hash/unicode-golden-vectors` — multi-byte and astral-plane strings pin exact values
    in Node and a browser-like runtime.

**Scheduling constraints**
30. `scheduler/rejects-past-insertion` — scheduling behind the current commit throws
    `ALIVE_RETROACTIVE_SCHEDULE` and rolls the commit back.
31. `scheduler/rejects-retroactive-same-time-priority` — same-time work at a priority
    that would outrank the current source is rejected.
32. `scheduler/allows-same-time-later-order` — same-time, equal-or-greater priority,
    larger sequence is accepted.
33. `reschedule/cannot-cross-history-prefix` — moving pending work behind published
    history is rejected.

**Clock**
34. `clock/advance-through-empty-interval` — with an empty queue, `advance` and
    `runUntil` still reach the target and set `ranTo`.
35. `clock/horizon-is-inclusive` — a commit at exactly the horizon counts as inside it.
36. `clock/backward-run-rejected` — `runUntil` before head time throws
    `ALIVE_BACKWARD_RUN`.
37. `limits/same-instant-survives-runNext-boundaries` — repeated `runNext()` triggers
    the same-instant limit at the same point a single `advance()` would.

**Build**
38. Official demo production build with `VITE_ALIVE_ENABLED=true` includes simulation
    and devtools; an ordinary consumer production build excludes them.

---

## 14. Product Launch regression contract

**INV-67.** With the canonical demo seed, the baseline Arc Desk Lamp stockout occurs
within **11:00–11:30** virtual time, and the restock branch has no Arc Desk Lamp
stockout before the comparison horizon (14:00).

Asserted as a window, not an exact minute, so scenario tuning cannot silently drift the
stockout outside the 20-second video's story while every other test still passes.

**INV-68.** The window is achieved by tuning deterministic scenario parameters — arrival
rate, initial stock, purchase probabilities, restock quantity. Never by hard-coding a
timestamp, injecting a scripted stockout event, or special-casing the demo seed. Times
quoted in the README are produced by the simulation and are themselves covered by this
test.
