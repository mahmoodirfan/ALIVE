# ● ALIVE — Fork your app's future

**You built the app. Now give it something to do.**

ALIVE is a deterministic scenario engine for living software demos. It puts a virtual
world behind an ordinary application, lets that world evolve over time, and then lets
you **rewind, fork the timeline, change one decision, and compare the future that did
not happen with the one that did.**

Repository status: **v0.5 demo milestone**.

## The 20-second idea

The included **Northstar Goods** demo starts as a normal shop-management dashboard.
Then:

```text
09:00   Run launch
        ↓
        orders arrive through normal HTTP
        ↓
        inventory falls
        ↓
11:12   Arc Desk Lamp sells out
        ↓
        rewind to 10:30
        ↓
        fork timeline + restock 8
        ↓
        run the same demand forward
        ↓
14:00   6 lamps remain
```

ALIVE compares the two actual branches and may report:

> **In this simulation, the 10:30 restock prevented the Arc Desk Lamp stockout.**

The UI uses a sentence template gated by the real comparison report. The engine
only permits that conclusion when the
branches share the required history, exogenous demand remains stable, the intervention
is isolated, and both branches are evaluated through the same horizon.

## What is in this repository

```text
packages/core          deterministic simulation kernel
packages/integration   API/effect contract + cache invalidation binding
packages/msw           MSW transport adapter
apps/demo-store        Northstar Goods React/Vite showcase + ALIVE devtools
docs/                  architecture, determinism, timelines, transport and demo docs
```

The host application does **not** use ALIVE as its React state store. Its data pages call
ordinary endpoints such as:

```ts
fetch('/api/orders')
```

MSW serves those endpoints from the current ALIVE view state. Normal commits trigger
**targeted TanStack Query invalidation**; scrub/fork/switch operations invalidate the
ALIVE-backed projection. No polling is used.

## Run the showcase

Requirements:

- Node 22
- pnpm 9.15.9

The lockfile includes all five workspace projects. Install and start the showcase:

```bash
corepack enable
corepack prepare pnpm@9.15.9 --activate
pnpm install --frozen-lockfile
pnpm demo
```

Open the Vite URL (normally `http://localhost:5173`). Installation generates the
MSW service worker without interactive prompts. Demo commands build the internal
workspace packages automatically, including on a fresh checkout.

See `docs/DEMO.md` for the exact demo flow.

## Verify

Once dependencies are available:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm demo:build
```

CI uses the committed lockfile with `--frozen-lockfile`. Type checking and tests
build internal packages first so their exported declarations and modules are available.

Connected Node 22 validation passes; browser/visual acceptance is still pending
because the verification environment's browser preview runtime could not start.
See `VERIFICATION.txt` for the exact checks and limitations. No hosted demo is claimed.

## Milestones

- **Phase 1** — deterministic transactional kernel
- **Phase 2** — scrub, checkpoints, branches and exact replay
- **Phase 3** — observables, branch comparison and causal gating
- **Phase 4** — API/MSW transport and targeted cache invalidation
- **Phase 5** — **Northstar Goods showcase, playback controller and ALIVE devtools**

No CLI, AI-agent skill, marketplace, hosted backend or additional scenarios are part of
this milestone.

## Why ALIVE is different

ALIVE combines ideas that separately exist in stateful mocking, event sourcing,
time-travel debugging and discrete-event simulation:

```text
stateful mock API
+ deterministic virtual time
+ stable exogenous behavior
+ retained alternative futures
+ counterfactual comparison
```

The result is not merely fake data and not merely Redux-style time travel. The product
moment is changing one decision and seeing which simulated consequence disappears.

## Documentation

- `docs/PRODUCT.md` — product boundary
- `docs/ARCHITECTURE.md` — kernel and package architecture
- `docs/DETERMINISM.md` — identity/RNG invariants
- `docs/TIMELINES.md` — scrub/fork/replay semantics
- `docs/TRANSPORT.md` — MSW/API/query integration
- `docs/DEMO.md` — Northstar Goods showcase
- `VERIFICATION.txt` — what was and was not independently verified in this environment

ALIVE is for demos, prototypes, development and isolated sandboxes. It must not be
connected to production payments, messages or production records.
