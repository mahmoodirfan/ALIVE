# PRODUCT.md — ALIVE v0.1

> You built the app. Now give it something to do.

## 1. What ALIVE is

ALIVE is a deterministic scenario engine for software demos. It gives a prototype a
simulated world with virtual time, scheduled events, actors, consequences, user
intervention, branching futures, and counterfactual comparison between those futures.

The one-line technical framing, used in the README and everywhere else:

> A deterministic scenario engine for living software demos: stateful mock APIs,
> virtual time, timeline branching and counterfactual replay.

## 2. What ALIVE is for

The product exists to support one demonstration:

> **Change one decision. See the future that did not happen.**

Time travel alone is Redux DevTools. Relational fake data alone is Mirage. Stateful mock
endpoints alone are MSW. ALIVE's claim is the combination, and specifically the last
term: a preserved baseline future compared against a user-altered future along
scenario-declared observables.

## 3. Prior art, stated honestly

ALIVE is not novel in its parts. The README must acknowledge:

- stateful mock servers (MSW, Mirage JS) — entity relationships behind a network boundary
- time-travel debugging (Redux DevTools) — replay of a recorded action log
- discrete-event simulation — virtual clock, priority scheduler, event cascades
- event sourcing — state as a fold over an immutable commit log

What ALIVE combines that these do not, individually:

```
virtual clock
+ deterministic scenario behavior
+ network-boundary integration
+ branching futures
+ counterfactual comparison
```

Do not frame ALIVE as "better Faker". Do not attack other projects.

## 4. Integration posture

ALIVE owns its own canonical world state. It does **not** own host application state
(ARCHITECTURE.md INV-1).

The headline integration is the network boundary: the host app keeps calling
`fetch("/api/orders")` and MSW answers from the simulation. Direct kernel access exists
for greenfield demos and tests, and is secondary.

The kernel itself has no idea HTTP exists. The API contract is defined by the
application and consumed independently by the MSW adapter and the cache binding
(INV-3, INV-28). A headless simulation runs with none of it present.

Honest README wording, required:

> Existing applications that already use an API boundary usually require minimal
> integration. Applications with client-side caches also need a cache invalidation
> binding so the UI refreshes as the simulation advances and when timelines change.

Do not claim universal one-line integration.

## 5. Scope of v0.1

In scope:

- deterministic kernel: clock, priority scheduler, transactional commit machinery,
  commands, keyed RNG, semantic identity, reducers
- time navigation: commit cursors, scrub, fork with historical reconstruction, branch
  graph, checkpoints, replay export/import
- counterfactual engine: observables, branch comparison, horizon, machine-checked
  causal gating
- application-side transport: API contract, MSW adapter, query binding (implemented Phase 4)
- one polished React showcase: Northstar Goods Product Launch + devtools (implemented Phase 5)
- one scenario: Northstar Goods Product Launch
- one demo app (React + Vite + TanStack Query) with a `PlaybackController` and devtools

Explicitly excluded from v0.1:

```
CLI                 AI skill              scenario marketplace
second demo         third demo            hosted SaaS
authentication      cloud persistence     LLM actors
Python / mobile     VS Code / Chrome ext  DB introspection
production replay   Kafka                 multiplayer
enterprise features
```

Nothing is published to npm during v0.1; workspace packages stay private under
`@alive-internal/*` until the name is settled.

## 6. The scenario

**Northstar Goods Product Launch.** A fictional design company launches four desk
products: Arc Desk Lamp, Orbit Stand, Grid Notebook, Loop Cable Set.

Shape of the run: launch opens, customers arrive, orders occur, stock declines, a
support ticket appears, the Arc Desk Lamp trends toward stockout. The user intervenes by
restocking from a forked historical point.

Regression contract (DETERMINISM.md INV-67, INV-68): with the canonical demo seed the
baseline Arc Desk Lamp stockout occurs within 11:00–11:30 virtual time, and the restock
branch avoids stockout through the 14:00 horizon. Enforced by tuning deterministic
scenario parameters, never by hard-coding a timestamp.

## 7. The 20-second product test

```
0–3s    ordinary store dashboard, nothing unusual
3s      press "Run Launch"
4–10s   orders appear through the ordinary UI; inventory falls; metrics move
10s     Arc Desk Lamp reaches dangerous stock
11s     pause; scrub back to 10:30 — banner reads VIEWING HISTORY
13s     "Fork From Here"
14s     restock +8
15–18s  run the fork forward to the horizon
18s     counterfactual panel:
            ORIGINAL       sold out — 11:12
            YOUR TIMELINE  4 remaining — 14:00
            In this simulation, your restock prevented the stockout.
20s     both branches visible in the branch selector
```

Playback speeds are multipliers of a configured demonstration pace, not of real time
(ARCHITECTURE.md §9) — which is what lets twenty seconds of video cover several virtual
hours.

If this is not compelling, do not add features. Fix this.

## 8. Causal language

The UI may say "your restock prevented the stockout" only when scoped: **"In this
simulation…"** (INV-63), and only when the kernel's machine-checked conditions hold
(INV-62). ALIVE compares two runs of a fictional model and makes no real-world causal
claim.

## 9. Demonstrability and safety

The official showcase is deployed as a production build with ALIVE explicitly enabled
via `VITE_ALIVE_ENABLED` (INV-64). Ordinary consumer production builds exclude ALIVE by
default. The showcase uses fictional data and isolated mock endpoints only; ALIVE never
connects to production services (INV-65).

## 10. No fabricated traction

No invented star counts, adopters, testimonials, or benchmarks. Only measured claims.
