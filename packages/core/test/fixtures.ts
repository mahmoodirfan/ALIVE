/** Shared Phase 1 fixtures. Deliberately small so failures are readable. */
import { PRIORITY } from '../src/types.js';
import type { CommitSource, EmitSpec, Scenario, ScheduledItem } from '../src/types.js';

export interface ShopWorld {
  products: Record<string, { id: string; stock: number; price: number }>;
  orders: Record<string, { id: string; productId: string; qty: number }>;
  log: string[];
  metrics: { revenue: number; lowWarnings: number };
}

export interface BuildOptions {
  /** extra draw in an unrelated handler — proves keyed-RNG isolation */
  extraDraw?: boolean;
  /** suppress the conditional sibling emit — proves identity stability */
  suppressSibling?: boolean;
  endTime?: number;
}

export function shopScenario(o: BuildOptions = {}): Scenario<ShopWorld> {
  return {
    id: 'shop',
    version: '1.0.0',
    name: 'Shop',
    epoch: '2026-01-01T00:00:00.000Z',
    ...(o.endTime !== undefined ? { endTime: o.endTime } : {}),
    initialState: () => ({
      products: {
        lamp: { id: 'lamp', stock: 5, price: 100 },
        stand: { id: 'stand', stock: 50, price: 40 },
      },
      orders: {},
      log: [],
      metrics: { revenue: 0, lowWarnings: 0 },
    }),
    events: {
      'customer.arrived': (draft, event, ctx) => {
        draft.log.push(`arrived:${event.actorId ?? '?'}`);
        const wants = ctx.random.chance(0.5, 'purchase-decision');
        if (wants) {
          ctx.emit({
            type: 'order.created',
            entityId: `ord-${event.actorId ?? 'x'}`,
            payload: { productId: 'lamp', qty: 1 },
          });
        }
      },
      'order.created': (draft, event, ctx) => {
        const p = event.payload as { productId: string; qty: number };
        const product = draft.products[p.productId];
        if (!product) return;
        const id = event.entityId ?? event.id;
        draft.orders[id] = { id, productId: p.productId, qty: p.qty };
        product.stock -= p.qty;
        draft.metrics.revenue += product.price * p.qty;
        if (!o.suppressSibling && product.stock <= 3) {
          ctx.emit({
            type: 'inventory.low',
            entityId: product.id,
            slot: 'threshold',
            payload: { stock: product.stock },
          });
        }
        ctx.emit({
          type: 'revenue.changed',
          entityId: product.id,
          slot: 'sale',
          payload: { revenue: draft.metrics.revenue },
        });
      },
      'inventory.low': (draft) => {
        draft.metrics.lowWarnings += 1;
      },
      'revenue.changed': (draft, event, ctx) => {
        draft.log.push(`revenue:${event.entityId ?? '?'}`);
        if (o.extraDraw) {
          // unrelated draw; must not perturb any other actor's randomness
          ctx.random.float('unrelated-noise');
        }
      },
      'inventory.restocked': (draft, event) => {
        const p = event.payload as { productId: string; quantity: number };
        const product = draft.products[p.productId];
        if (product) product.stock += p.quantity;
        draft.log.push(`restock:${p.productId}`);
      },
      noop: () => {},
      boom: () => {
        throw new Error('handler exploded');
      },
    },
    commands: {
      'product.restock': {
        validate: (state, command) => {
          const p = command.payload as { productId: string; quantity: number };
          if (!state.products[p.productId]) {
            return { code: 'ALIVE_PRECONDITION_FAILED', message: 'unknown product' };
          }
          if (p.quantity <= 0) {
            return { code: 'ALIVE_INVALID_COMMAND', message: 'quantity must be positive' };
          }
          return undefined;
        },
        events: (_state, command): readonly EmitSpec[] => {
          const p = command.payload as { productId: string; quantity: number };
          return [
            {
              type: 'inventory.restocked',
              entityId: p.productId,
              payload: { productId: p.productId, quantity: p.quantity },
            },
          ];
        },
      },
      'command.boom': {
        events: (): readonly EmitSpec[] => [{ type: 'boom', payload: {} }],
      },
    },
    bootstrap: [
      {
        key: 'open',
        type: 'customer.arrived',
        virtualTime: 1000,
        priority: PRIORITY.domain,
        actorId: 'alice',
        payload: {},
      },
      {
        key: 'second',
        type: 'customer.arrived',
        virtualTime: 2000,
        priority: PRIORITY.domain,
        actorId: 'bob',
        payload: {},
      },
    ],
  };
}

/** Minimal scenario with a single controllable handler. */
export function tinyScenario(
  events: Scenario<{ n: number; log: string[] }>['events'],
  bootstrap: Scenario<{ n: number; log: string[] }>['bootstrap'] = [],
): Scenario<{ n: number; log: string[] }> {
  return {
    id: 'tiny',
    version: '1.0.0',
    name: 'Tiny',
    epoch: '2026-01-01T00:00:00.000Z',
    initialState: () => ({ n: 0, log: [] }),
    events,
    commands: {},
    bootstrap,
  };
}

/** Narrows a CommitSource to its ScheduledItem. Throws on an intervention source. */
export function scheduledOf(source: CommitSource): ScheduledItem {
  if (source.kind !== 'scheduled') throw new Error('expected a scheduled source');
  return source.item;
}
