# CLAUDE.md — working rules for ALIVE

Read this before editing anything in this repository.

## Current state

**Phase 5 showcase complete (repository demo milestone v0.5.0).**
`docs/` is the implementation contract. `packages/core` contains the deterministic
kernel/time-navigation/counterfactual engine; `packages/integration` contains the shared
API/effect/cache contract; `packages/msw` contains the MSW v2 adapter; `apps/demo-store` contains the completed Phase 5 Northstar Goods showcase and developer tools.

## Before editing code

1. Open the files you intend to change. Never reason about code you have not read.
2. Read `docs/ARCHITECTURE.md`. Add `docs/DETERMINISM.md` for anything touching RNG,
   identity, ordering or limits, and `docs/TIMELINES.md` for anything touching cursors,
   scrub, fork, interventions or comparison.
3. Name the invariant(s) your change affects, by number. The registry is
   ARCHITECTURE.md §14 and is the authority for what a number means and where its home
   definition lives. Invariants may be restated across documents; conflicting
   definitions are forbidden.
4. If the change contradicts a documented invariant: **stop**, write down the
   contradiction, propose the smallest correction, update the document, then implement.

Architecture documents and code change in the same commit. Never one without the other.
Never leave a stale invariant reference.

## After each coherent unit of work

```
pnpm typecheck && pnpm lint && pnpm test
```

Fix failures before continuing. **Never weaken a test to make an implementation pass**
(INV-66). If a test is wrong, fix it in a separate commit with an explanation.

## Phase order

```
0    architecture                                                        done
0.1  architecture corrections                                            done
0.2  semantics corrections (ids, ordering, clock, encoding, handlers)     done
1    kernel: clock, priority scheduler, commit machinery + transaction,
     commands, keyed RNG, identity, reducers, causality, log                 done
1.1  rollback/payload/listener verification hardening                         done
1.2  immutable snapshots, safe numeric domains, reserved intervention order,
     Unicode-safe identity inputs, rule purity                                done
2    time navigation: Immer patches, cursors, scrub, checkpoints,
     branching, fork reconstruction, replay export/import                     done
3    counterfactual: observables, comparison, horizon, causal gating          done
4    transport: api contract, MSW adapter, query binding                         done
5    demo: React/Vite app, PlaybackController, devtools, the 20-second story
```

Do not start a phase until the previous one passes typecheck, lint and tests, and the
documents still match the code. Do not build UI before the kernel passes its tests. Do
not build the demo before the counterfactual engine works headlessly.

## The invariants easiest to break

- **INV-2 / INV-3** the kernel imports no framework or transport library, and works with
  no API contract at all. `Scenario<W>` has no `api` field; `CommitNotification` has no
  query keys.
- **INV-19 / INV-20 / INV-21** a commit is one `CommitSource` plus its cascade, and the
  transaction covers world state *and* queue, cancellations, reschedules, sequence
  allocation, exogenous cursors, event log and observable samples. Failure discards all
  of it.
- **INV-22** safety limits never depend on `advance()` slicing.
- **INV-44** cursors name commit boundaries. There is no position inside a commit.
- **INV-10 / INV-11** event identity is semantic; collisions throw rather than being
  repaired by encounter order.
- **INV-13 / INV-14** neither `sequence` nor `withinCommitOrder` ever feeds identity,
  RNG keys or branch alignment.
- **INV-31 / INV-32** RNG is keyed and stateless; `branchId` is never entropy.
- **INV-38** exogenous streams receive no world state, so demand is branch-stable.
- **INV-48** fork reconstructs historical timeline state by checkpoint + replay, never
  by filtering the parent's head queue.
- **INV-52 / INV-53** every intervention records `commandId` and an anchor; history
  through the anchor is immutable.
- **INV-57** replay hard-fails on `semanticsVersion` mismatch.
- **INV-7** no playback, timers or wall-clock dependence in `packages/core`.
- **INV-15** ordering is *immutable history prefix + ordered pending frontier*, not a
  flat tuple order. The tuple orders only within the frontier.
- **INV-71** handlers may never schedule or reschedule behind the current commit.
- **INV-72 / INV-73** the clock crosses empty intervals to reach its target; a commit at
  the horizon is inside the horizon.
- **INV-74** the same-instant guard is branch state, so repeated `runNext()` cannot
  bypass a limit a single `advance()` would hit.
- **INV-75** every hash input goes through the one canonical tuple encoder. Never join
  strings with a delimiter.
- **INV-69 / INV-70** `CommitId` and `BranchId` have derivation rules; neither uses
  `sequence`, a UUID or a clock.
- **INV-76 / INV-77** command handlers and rules emit events; only event handlers touch
  the draft.

Full registry: ARCHITECTURE.md §14, 78 entries, one concept each.

## Hard prohibitions

In `packages/core` and `scenarios/**`:

```
Math.random()   Date.now()   new Date() with no argument   performance.now()
crypto.randomUUID()   module-level mutable state   closures in scheduler items
BigInt outside the RNG module   iteration-order dependence
timers, intervals, or any wall-clock read
undefined / NaN / Infinity / Date / Map / Set / class instances in world state,
  payloads, checkpoints or replay files
```

Also forbidden in the kernel: joining strings with a delimiter to build a hash input
(INV-75), mutating the draft from a command handler or rule (INV-76, INV-77), and
`"queue-empty"` as an `advance`/`runUntil` stop reason (INV-72).

In the demo: `refetchInterval` (INV-30), and `import.meta.env.DEV` as the ALIVE gate
(INV-64 — use `VITE_ALIVE_ENABLED`).

Anywhere: `any` in a public API. Placeholder implementations. Unexplained TODOs on
correctness paths. Speculative abstraction for a second scenario v0.1 does not have.

## Semantics version

Bumping `semanticsVersion` is required by any change to scheduler ordering or the
prefix/frontier model, priority bands, commit batching or transaction boundaries, clock
advancement or horizon inclusivity, the same-instant guard, command injection or
anchoring, any identity derivation (event, scheduled, commit, branch, command), the
canonical tuple encoding, fork reconstruction, safety limits, or rule evaluation order.
These change replay results without changing the JSON shape or the RNG, so the version is
the only thing that catches them (INV-57). The authoritative list is ARCHITECTURE.md §12.

## Scope discipline

v0.1 is: kernel, time navigation, counterfactual, transport layer, one scenario, one
demo.

Not in v0.1: CLI, AI skill, second or third scenario, hosted service, LLM actors,
authentication, cloud persistence, Python or mobile SDKs, editor extensions, DB
introspection, production traffic replay, Kafka, multiplayer, enterprise features.

Nothing is published to npm. Packages stay private under `@alive-internal/*`.

## The test that decides everything

After each phase, ask: does this make a prototype feel meaningfully more alive, or have
we built infrastructure?

The v0.1 acceptance test:

1. run the baseline past the Arc Desk Lamp stockout
2. the baseline is preserved
3. scrub back before the stockout
4. fork
5. restock
6. run the fork to the same horizon
7. compare
8. the report shows the baseline stocked out and the fork did not
9. both timelines reproduce from their replay data
10. same seed + same interventions = same result, every time
