import { PRIORITY, type JsonValue, type Scenario } from '@alive-internal/core';
import {
  ARC_LAMP_ID,
  HERO_HORIZON,
  MINUTE,
  PRODUCT_IDS,
} from './constants.js';
import type { Customer, LaunchWorld, Order, Product, SupportTicket } from './types.js';

interface DemandOpportunity {
  at: number;
  orderId: string;
  customer: Omit<Customer, 'orders' | 'lifetimeValue' | 'joinedAt'>;
  productId: string;
  quantity: number;
}

const demand: readonly DemandOpportunity[] = [
  { at: 6 * MINUTE, orderId: 'NS-1041', customer: { id: 'c-maya', name: 'Maya Chen', city: 'Portland', email: 'maya@example.test' }, productId: PRODUCT_IDS.lamp, quantity: 1 },
  { at: 14 * MINUTE, orderId: 'NS-1042', customer: { id: 'c-amir', name: 'Amir Rahman', city: 'Austin', email: 'amir@example.test' }, productId: PRODUCT_IDS.stand, quantity: 1 },
  { at: 26 * MINUTE, orderId: 'NS-1043', customer: { id: 'c-sofia', name: 'Sofia Rossi', city: 'Brooklyn', email: 'sofia@example.test' }, productId: PRODUCT_IDS.notebook, quantity: 2 },
  { at: 38 * MINUTE, orderId: 'NS-1044', customer: { id: 'c-jules', name: 'Jules Martin', city: 'Montreal', email: 'jules@example.test' }, productId: PRODUCT_IDS.lamp, quantity: 1 },
  { at: 49 * MINUTE, orderId: 'NS-1045', customer: { id: 'c-noah', name: 'Noah Williams', city: 'Seattle', email: 'noah@example.test' }, productId: PRODUCT_IDS.cable, quantity: 1 },
  { at: 65 * MINUTE, orderId: 'NS-1046', customer: { id: 'c-aisha', name: 'Aisha Khan', city: 'Chicago', email: 'aisha@example.test' }, productId: PRODUCT_IDS.lamp, quantity: 1 },
  { at: 102 * MINUTE, orderId: 'NS-1047', customer: { id: 'c-elena', name: 'Elena Cruz', city: 'Miami', email: 'elena@example.test' }, productId: PRODUCT_IDS.lamp, quantity: 1 },
  { at: 132 * MINUTE, orderId: 'NS-1048', customer: { id: 'c-liam', name: 'Liam Osei', city: 'Boston', email: 'liam@example.test' }, productId: PRODUCT_IDS.lamp, quantity: 1 },
  { at: 145 * MINUTE, orderId: 'NS-1049', customer: { id: 'c-ivy', name: 'Ivy Park', city: 'San Diego', email: 'ivy@example.test' }, productId: PRODUCT_IDS.notebook, quantity: 1 },
  { at: 170 * MINUTE, orderId: 'NS-1050', customer: { id: 'c-ben', name: 'Ben Carter', city: 'Denver', email: 'ben@example.test' }, productId: PRODUCT_IDS.stand, quantity: 1 },
  { at: 200 * MINUTE, orderId: 'NS-1051', customer: { id: 'c-nadia', name: 'Nadia Ali', city: 'Toronto', email: 'nadia@example.test' }, productId: PRODUCT_IDS.lamp, quantity: 1 },
  { at: 255 * MINUTE, orderId: 'NS-1052', customer: { id: 'c-luca', name: 'Luca Moretti', city: 'San Francisco', email: 'luca@example.test' }, productId: PRODUCT_IDS.lamp, quantity: 1 },
  { at: 282 * MINUTE, orderId: 'NS-1053', customer: { id: 'c-zara', name: 'Zara Brooks', city: 'London', email: 'zara@example.test' }, productId: PRODUCT_IDS.cable, quantity: 2 },
] as const;

function makeProducts(): Product[] {
  return [
    { id: PRODUCT_IDS.lamp, name: 'Arc Desk Lamp', sku: 'ARC-01', price: 189, stock: 5, initialStock: 5, status: 'healthy', accent: 'amber' },
    { id: PRODUCT_IDS.stand, name: 'Orbit Stand', sku: 'ORB-02', price: 79, stock: 8, initialStock: 8, status: 'healthy', accent: 'blue' },
    { id: PRODUCT_IDS.notebook, name: 'Grid Notebook', sku: 'GRD-03', price: 24, stock: 20, initialStock: 20, status: 'healthy', accent: 'slate' },
    { id: PRODUCT_IDS.cable, name: 'Loop Cable Set', sku: 'LOP-04', price: 34, stock: 12, initialStock: 12, status: 'healthy', accent: 'green' },
  ];
}

function product(world: LaunchWorld, id: string): Product | undefined {
  return world.products.find((candidate) => candidate.id === id);
}

function ensureCustomer(world: LaunchWorld, opportunity: DemandOpportunity, at: number): Customer {
  const existing = world.customers.find((customer) => customer.id === opportunity.customer.id);
  if (existing) return existing;
  const created: Customer = {
    ...opportunity.customer,
    orders: 0,
    lifetimeValue: 0,
    joinedAt: at,
  };
  world.customers.unshift(created);
  return created;
}

function statusFor(stock: number): Product['status'] {
  if (stock <= 0) return 'sold-out';
  if (stock <= 2) return 'low';
  return 'healthy';
}

function jsonOpportunity(opportunity: DemandOpportunity): JsonValue {
  return {
    at: opportunity.at,
    orderId: opportunity.orderId,
    customer: { ...opportunity.customer },
    productId: opportunity.productId,
    quantity: opportunity.quantity,
  };
}

export function createProductLaunchScenario(): Scenario<LaunchWorld> {
  return {
    id: 'northstar-product-launch',
    version: '1.0.0',
    name: 'Northstar Goods — Product Launch',
    epoch: '2026-09-19T09:00:00.000Z',
    endTime: HERO_HORIZON,
    initialState: () => ({
      products: makeProducts(),
      customers: [],
      orders: [],
      tickets: [],
      lostDemand: [],
      metrics: { revenue: 0, orders: 0, unitsSold: 0, lostOrders: 0 },
    }),
    events: {
      'customer.demanded': (draft, event, ctx) => {
        const opportunity = event.payload as unknown as DemandOpportunity;
        ensureCustomer(draft, opportunity, ctx.time);
        const item = product(draft, opportunity.productId);
        if (!item || item.stock < opportunity.quantity) {
          ctx.emit({
            type: 'order.lost',
            actorId: opportunity.customer.id,
            entityId: opportunity.productId,
            slot: 'lost-demand',
            payload: {
              id: `lost-${opportunity.orderId}`,
              customerId: opportunity.customer.id,
              customerName: opportunity.customer.name,
              productId: opportunity.productId,
              quantity: opportunity.quantity,
              at: ctx.time,
              reason: 'out-of-stock',
            },
          });
          return;
        }
        ctx.emit({
          type: 'order.created',
          actorId: opportunity.customer.id,
          entityId: opportunity.orderId,
          slot: 'order',
          payload: {
            orderId: opportunity.orderId,
            customerId: opportunity.customer.id,
            customerName: opportunity.customer.name,
            productId: opportunity.productId,
            quantity: opportunity.quantity,
          },
        });
      },
      'order.created': (draft, event, ctx) => {
        const p = event.payload as unknown as { orderId: string; customerId: string; customerName: string; productId: string; quantity: number };
        const item = product(draft, p.productId);
        if (!item || item.stock < p.quantity) return;
        const total = item.price * p.quantity;
        item.stock -= p.quantity;
        item.status = statusFor(item.stock);
        const order: Order = {
          id: p.orderId,
          customerId: p.customerId,
          customerName: p.customerName,
          status: 'paid',
          total,
          createdAt: ctx.time,
          lines: [{ productId: p.productId, quantity: p.quantity, unitPrice: item.price }],
        };
        draft.orders.unshift(order);
        draft.metrics.revenue += total;
        draft.metrics.orders += 1;
        draft.metrics.unitsSold += p.quantity;
        const customer = draft.customers.find((candidate: Customer) => candidate.id === p.customerId);
        if (customer) {
          customer.orders += 1;
          customer.lifetimeValue += total;
        }
        ctx.emit({
          type: 'inventory.changed',
          entityId: item.id,
          slot: 'after-order',
          payload: { productId: item.id, stock: item.stock, delta: -p.quantity },
        });
        if (item.stock <= 2 && item.stock > 0) {
          ctx.emit({ type: 'inventory.low', entityId: item.id, slot: 'low-stock', payload: { productId: item.id, stock: item.stock } });
        }
        if (item.stock === 0) {
          ctx.emit({ type: 'inventory.stockout', entityId: item.id, slot: 'stockout', payload: { productId: item.id } });
        }
      },
      'order.lost': (draft, event) => {
        draft.lostDemand.unshift(event.payload as unknown as LaunchWorld['lostDemand'][number]);
        draft.metrics.lostOrders += 1;
      },
      'inventory.changed': () => {},
      'inventory.low': () => {},
      'inventory.stockout': () => {},
      'inventory.restocked': (draft, event, ctx) => {
        const p = event.payload as unknown as { productId: string; quantity: number };
        const item = product(draft, p.productId);
        if (!item) return;
        item.stock += p.quantity;
        item.status = statusFor(item.stock);
        ctx.emit({ type: 'inventory.changed', entityId: item.id, slot: 'after-restock', payload: { productId: item.id, stock: item.stock, delta: p.quantity } });
      },
      'order.cancel.requested': (draft, event, ctx) => {
        const p = event.payload as unknown as { orderId: string };
        const order = draft.orders.find((candidate: Order) => candidate.id === p.orderId);
        if (!order || order.status === 'cancelled') return;
        order.status = 'cancelled';
        draft.metrics.revenue -= order.total;
        draft.metrics.orders -= 1;
        const customer = draft.customers.find((candidate: Customer) => candidate.id === order.customerId);
        if (customer) {
          customer.orders -= 1;
          customer.lifetimeValue -= order.total;
        }
        for (const line of order.lines) {
          const item = product(draft, line.productId);
          if (!item) continue;
          item.stock += line.quantity;
          item.status = statusFor(item.stock);
          draft.metrics.unitsSold -= line.quantity;
          ctx.emit({ type: 'inventory.changed', entityId: item.id, slot: `cancel-${order.id}`, payload: { productId: item.id, stock: item.stock, delta: line.quantity } });
        }
        ctx.emit({ type: 'order.cancelled', entityId: order.id, slot: 'cancelled', payload: { orderId: order.id } });
      },
      'order.cancelled': () => {},
      'support.ticket.opened': (draft, event) => {
        const p = event.payload as unknown as SupportTicket;
        if (!draft.tickets.some((ticket: SupportTicket) => ticket.id === p.id)) draft.tickets.unshift(p);
      },
      'support.ticket.resolved': (draft, event, ctx) => {
        const p = event.payload as unknown as { ticketId: string };
        const ticket = draft.tickets.find((candidate: SupportTicket) => candidate.id === p.ticketId);
        if (!ticket || ticket.status === 'resolved') return;
        ticket.status = 'resolved';
        ticket.resolvedAt = ctx.time;
      },
    },
    commands: {
      restock: {
        validate: (state, command) => {
          const p = command.payload as unknown as { productId: string; quantity: number };
          if (!state.products.some((candidate) => candidate.id === p.productId)) return { code: 'ALIVE_PRECONDITION_FAILED', message: 'Unknown product.' };
          if (!Number.isSafeInteger(p.quantity) || p.quantity <= 0 || p.quantity > 100) return { code: 'ALIVE_INVALID_COMMAND', message: 'Quantity must be an integer from 1 to 100.' };
          return undefined;
        },
        events: (_state, command) => [{ type: 'inventory.restocked', entityId: (command.payload as unknown as { productId: string }).productId, payload: command.payload }],
      },
      'order.cancel': {
        validate: (state, command) => {
          const p = command.payload as unknown as { orderId: string };
          const order = state.orders.find((candidate) => candidate.id === p.orderId);
          if (!order) return { code: 'ALIVE_PRECONDITION_FAILED', message: 'Order not found.' };
          if (order.status === 'cancelled') return { code: 'ALIVE_PRECONDITION_FAILED', message: 'Order is already cancelled.' };
          return undefined;
        },
        events: (_state, command) => [{ type: 'order.cancel.requested', entityId: (command.payload as unknown as { orderId: string }).orderId, payload: command.payload }],
      },
      'ticket.resolve': {
        validate: (state, command) => {
          const p = command.payload as unknown as { ticketId: string };
          const ticket = state.tickets.find((candidate) => candidate.id === p.ticketId);
          if (!ticket) return { code: 'ALIVE_PRECONDITION_FAILED', message: 'Ticket not found.' };
          if (ticket.status === 'resolved') return { code: 'ALIVE_PRECONDITION_FAILED', message: 'Ticket is already resolved.' };
          return undefined;
        },
        events: (_state, command) => [{ type: 'support.ticket.resolved', entityId: (command.payload as unknown as { ticketId: string }).ticketId, payload: command.payload }],
      },
    },
    exogenous: [
      {
        id: 'launch-demand',
        from: demand[0]?.at ?? 0,
        until: demand[demand.length - 1]?.at,
        next: ({ ordinal }) => {
          const opportunity = demand[ordinal];
          if (!opportunity) return null;
          return {
            virtualTime: opportunity.at,
            type: 'customer.demanded',
            actorId: opportunity.customer.id,
            key: opportunity.orderId,
            payload: jsonOpportunity(opportunity),
          };
        },
      },
    ],
    bootstrap: [
      {
        key: 'support-ticket-arc',
        type: 'support.ticket.opened',
        virtualTime: 76 * MINUTE,
        priority: PRIORITY.domain,
        entityId: 'T-204',
        payload: {
          id: 'T-204',
          customerId: 'c-maya',
          customerName: 'Maya Chen',
          orderId: 'NS-1041',
          subject: 'Can I change the delivery address?',
          status: 'open',
          openedAt: 76 * MINUTE,
          resolvedAt: null,
        },
      },
      {
        key: 'cancel-orbit-order',
        type: 'order.cancel.requested',
        virtualTime: 92 * MINUTE,
        priority: PRIORITY.domain,
        entityId: 'NS-1042',
        payload: { orderId: 'NS-1042' },
      },
    ],
    stateObservables: {
      arcStock: { kind: 'numeric', label: 'Arc Desk Lamp stock', select: (state) => product(state as LaunchWorld, ARC_LAMP_ID)?.stock ?? null, format: 'integer', sample: 'every-commit', direction: 'higher-is-better' },
      revenue: { kind: 'numeric', label: 'Revenue', select: (state) => state.metrics.revenue, format: 'currency', sample: 'every-commit', direction: 'higher-is-better' },
      orders: { kind: 'numeric', label: 'Orders', select: (state) => state.metrics.orders, format: 'integer', sample: 'at-horizon' },
      lostOrders: { kind: 'numeric', label: 'Lost orders', select: (state) => state.metrics.lostOrders, format: 'integer', sample: 'at-horizon', direction: 'lower-is-better' },
      lampAvailability: { kind: 'text', label: 'Arc Desk Lamp availability', select: (state) => product(state as LaunchWorld, ARC_LAMP_ID)?.status ?? null, sample: 'at-horizon' },
    },
    eventObservables: {
      arcStockout: { label: 'Arc Desk Lamp stockout', match: (event) => event.type === 'inventory.stockout' && event.entityId === ARC_LAMP_ID, expect: 'at-most-once' },
    },
  };
}

export const PRODUCT_LAUNCH_DEMAND = demand;
