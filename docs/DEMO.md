# Northstar Goods — ALIVE Phase 5 showcase

The Phase 5 application exists to prove one claim:

> An ordinary HTTP-driven React application can be given a deterministic world, rewound,
> forked and compared without making ALIVE its application state store.

## 1. Stack

The showcase uses:

- React
- Vite
- TanStack Query
- Mock Service Worker
- `@alive-internal/core`
- `@alive-internal/integration`
- `@alive-internal/msw`

The store UI calls `/api/...` through ordinary `fetch()` wrappers. MSW is the data
boundary. The ALIVE developer panel is the control surface and may talk directly to the
simulation engine.

## 2. Fictional world

Northstar Goods is a fictional design shop launching four products:

| Product | Starting stock | Price |
| --- | ---: | ---: |
| Arc Desk Lamp | 5 | $189 |
| Orbit Stand | 8 | $79 |
| Grid Notebook | 20 | $24 |
| Loop Cable Set | 12 | $34 |

All names, customers, orders and business results in the demo are fictional simulation
data.

The canonical scenario seed is:

```text
northstar-launch-demo-v1
```

The virtual day runs from **09:00 to 14:00**.

## 3. Baseline story

Deterministic demand causes Arc Desk Lamp orders at:

```text
09:06
09:38
10:05
10:42
11:12
```

The fifth purchase reduces stock from one to zero, producing the baseline stockout at:

```text
11:12
```

Additional lamp demand later in the day is recorded as lost demand in that branch.

The scenario also includes a support ticket, an order cancellation and demand for the
other products so multiple application screens move from the same world state.

## 4. Hero counterfactual

The intended demo workflow is:

1. Press **Run launch**.
2. Allow the baseline to reach 14:00.
3. ALIVE shows **Try a different future**.
4. Rewind/scrub to **10:30**.
5. The ordinary store screens now show the historical view served by MSW.
6. Press **Fork + restock 8**.
7. A new branch is created at 10:30.
8. The restock is sent through `POST /api/products/arc-lamp/restock`.
9. Run the fork through 14:00.
10. Compare it with the retained baseline.

Under the canonical scenario:

```text
baseline:     Arc Desk Lamp stockout at 11:12
restock fork: no lamp stockout before 14:00
fork stock:   6 lamps remaining at 14:00
baseline lost Arc orders: 2
fork lost Arc orders:     0
```

The comparison card is built from `compareBranches()`; it is not prewritten demo text.

## 5. Network-boundary proof

The ordinary app pages obtain data from endpoints including:

```text
GET  /api/overview
GET  /api/orders
GET  /api/products
GET  /api/customers
GET  /api/tickets
GET  /api/activity
POST /api/products/:id/restock
POST /api/orders/:id/cancel
POST /api/tickets/:id/resolve
```

`createAliveHandlers()` maps those routes to the current ALIVE view state.

Normal simulation events are mapped to affected query keys. For example an order may
invalidate:

```text
['alive', 'orders']
['alive', 'products']
['alive', 'customers']
['alive', 'overview']
['alive', 'activity']
```

There is no `refetchInterval` in the application.

## 6. Playback

Wall-clock pacing is deliberately outside the deterministic kernel.

`PlaybackController` uses browser timers only to call deterministic kernel operations.
The supported demo speeds are:

```text
1×
2×
5×
```

The kernel itself remains unaware of real time.

## 7. Scrub semantics

While scrubbing:

- GET endpoints serve historical view state;
- host mutations are protected by the Phase 4 `409 ALIVE_HISTORICAL_VIEW` behavior;
- devtools offers **Return to live** and **Fork + restock 8**;
- the baseline head remains unchanged.

## 8. Production demo gating

The official showcase intentionally enables ALIVE in its production build:

```text
VITE_ALIVE_ENABLED=true
```

That is different from the consumer safety default described by the architecture. ALIVE
must be disabled by default in a normal production application unless a developer has
explicitly chosen to ship a simulation/demo environment.

## 9. Run locally

Use Node 22 and pnpm 9.15.9:

```bash
corepack enable
corepack prepare pnpm@9.15.9 --activate
pnpm install --frozen-lockfile
pnpm demo
```

`postinstall` generates the MSW worker with `--no-save` to avoid an interactive
prompt. Demo commands explicitly build workspace packages first. The refreshed
lockfile includes the browser dependencies.

## 10. Acceptance tests

`apps/demo-store/test/scenario.test.ts` verifies:

1. baseline lamp stockout occurs naturally at 11:12;
2. the 10:30 +8 restock is performed through the API contract;
3. the fork reaches the horizon without a lamp stockout;
4. `causalLanguagePermitted` is true for the scoped stockout conclusion;
5. historical scrub exposes 10:30 world state while leaving the baseline head at 14:00.

The demo is successful only if those behaviors come from the real kernel.

`http.test.ts` additionally runs real `fetch` calls through MSW’s Node adapter and
an active TanStack Query observer. It checks commit-driven refresh without polling,
historical HTTP reads, HTTP 409 mutation rejection, POST restocking, both lost-order
counts, causal gating, and baseline preservation after switching branches.
`playback.test.ts` checks stable React snapshot identity and clock/horizon behavior.
These are automated tests; browser service-worker and visual acceptance remain separate.
