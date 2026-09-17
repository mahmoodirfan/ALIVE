# ALIVE transport layer — Phase 4

This document is the implementation contract for the application-side transport layer.
It does not change kernel semantics.

## 1. Boundary

`packages/core` remains transport-agnostic (INV-2 / INV-3 / INV-28).

Phase 4 adds:

- `packages/integration` — API/effect contract, transport-neutral route execution, and
  cache invalidation binding.
- `packages/msw` — converts that contract into MSW v2-style request handlers.

The kernel does not import either package.

## 2. API contract

```ts
const api = defineAliveApi<World>({
  routes: [
    {
      method: "GET",
      path: "/api/products/:id",
      resolve: ({ state, params }) => state.products[params.id] ?? null,
    },
    {
      method: "POST",
      path: "/api/products/:id/restock",
      command: ({ params, body }) => ({
        type: "product.restock",
        payload: { id: params.id, quantity: body.quantity },
      }),
      resolve: ({ state, params }) => state.products[params.id] ?? null,
    },
  ],
  effects: [
    {
      when: "inventory.changed",
      invalidate: (event) => [["products"], ["product", event.entityId!]],
    },
  ],
});
```

Routes are unique by `(method, path)`. Route projections must return JSON-safe data.
Mutation routes create an ALIVE command; they never mutate the simulation directly.

## 3. MSW adapter

MSW's current v2 API is based on `http.<method>()` plus `HttpResponse.json()`. ALIVE keeps
those primitives injected so MSW remains outside the core/integration dependency graph:

```ts
import { http, HttpResponse } from "msw";
import { createAliveHandlers } from "@alive-internal/msw";

export const handlers = createAliveHandlers(
  { http, HttpResponse },
  alive,
  api,
);
```

The host app continues to use ordinary `fetch()`/Axios calls.

The resolver accepts MSW's optional (`undefined`) path parameters and omits absent
values from the normalized route parameters. This keeps the injected runtime
compatible with real MSW v2 types without adding MSW to the kernel (INV-2 / INV-28).

Read routes always call `alive.getState()`. Because `getState()` means current **view
state**, normal GET requests automatically return historical projections while scrubbed.

Mutation mapping:

| ALIVE result | HTTP |
|---|---:|
| accepted | route `successStatus` or 200 |
| `ALIVE_HISTORICAL_VIEW` | 409 |
| `ALIVE_PRECONDITION_FAILED` | 422 |
| `ALIVE_UNKNOWN_COMMAND` | 404 |
| `ALIVE_INVALID_COMMAND` | 400 |
| faulted branch | 409 |

Malformed request JSON returns `400 ALIVE_BAD_REQUEST` without dispatching a command.

## 4. Freshness without polling

There are two kernel notification channels:

- `committed` — ordinary simulated progress.
- `timeline:changed` — scrub/fork/switch/reset/replay view changes.

The API contract's `effects` map committed events to cache/resource keys. The mapping is a
pure function of each event alone (INV-29).

```ts
{
  when: "order.created",
  invalidate: (event) => [
    ["orders"],
    ["products"],
    ["product", String(event.payload.productId)],
  ],
}
```

`bindAliveQueryInvalidation()` batches all targeted invalidations delivered in the same
kernel notification flush into one microtask and deduplicates identical keys. With TanStack-style prefix matching, descendant keys
are also removed when a shorter queued key already covers them.

```ts
const binding = bindAliveQueryInvalidation(alive, queryClient, api);
```

The query client is structural: it only needs TanStack Query-compatible
`invalidateQueries({ queryKey, exact })` behavior. Phase 4 therefore does not make
TanStack Query a runtime dependency.

A `timeline:changed` notification with `invalidateAll: true` supersedes any queued
targeted invalidations. By default it performs one full QueryClient invalidation; pass
`timelineQueryKey` to scope this to an ALIVE-owned query prefix in a larger application.

`refetchInterval` is not part of the ALIVE demo architecture (INV-30).

## 5. Failure containment

Transport/cache code is integration code, not simulation semantics.

- query invalidation exceptions/rejections are sent to optional `onError` and never throw
  back into the kernel notification callback;
- mutation HTTP failures do not modify historical state;
- disposing the binding unsubscribes both notification channels and suppresses already
  queued microtask work;
- effect keys are validated at use time and malformed effects do not corrupt the
  simulation.

## 6. Phase 4 acceptance test

The transport phase is complete when this sequence works without polling:

```text
kernel commits order.created
        ↓
committed notification
        ↓
effect rules → ["orders"], ["products"]
        ↓
query binding invalidates those keys
        ↓
active app queries refetch through ordinary fetch()
        ↓
MSW handler reads alive.getState()
        ↓
UI receives the new world state
```

And during scrub:

```text
enter scrub
  ↓
timeline:changed → full query invalidation
  ↓
GET /api/orders → historical view state
POST /api/products/x/restock → 409 + fork hint
```
