import { defineAliveApi, resourceKey } from '@alive-internal/integration';
import type { JsonValue } from '@alive-internal/core';
import type { LaunchWorld } from './types.js';

function json(value: unknown): JsonValue { return value as JsonValue; }

function numberField(body: JsonValue, field: string): number {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return Number.NaN;
  const value = (body as Record<string, JsonValue>)[field];
  return typeof value === 'number' ? value : Number.NaN;
}

export const launchApi = defineAliveApi<LaunchWorld>({
  routes: [
    {
      method: 'GET', path: '/api/overview', resolve: ({ state }) => json({
        metrics: state.metrics,
        lowStock: state.products.filter((product) => product.status !== 'healthy').map((product) => ({ id: product.id, name: product.name, stock: product.stock, status: product.status })),
        recentOrders: state.orders.slice(0, 5),
        openTickets: state.tickets.filter((ticket) => ticket.status === 'open').length,
      }),
    },
    { method: 'GET', path: '/api/orders', resolve: ({ state }) => json(state.orders) },
    { method: 'GET', path: '/api/products', resolve: ({ state }) => json(state.products) },
    { method: 'GET', path: '/api/customers', resolve: ({ state }) => json(state.customers) },
    { method: 'GET', path: '/api/tickets', resolve: ({ state }) => json(state.tickets) },
    {
      method: 'GET', path: '/api/activity', resolve: ({ state }) => json([
        ...state.orders.map((order) => ({ id: `order:${order.id}`, type: order.status === 'cancelled' ? 'order.cancelled' : 'order.created', label: `${order.customerName} · ${order.id}`, at: order.createdAt })),
        ...state.tickets.map((ticket) => ({ id: `ticket:${ticket.id}`, type: ticket.status === 'resolved' ? 'support.ticket.resolved' : 'support.ticket.opened', label: `${ticket.customerName} · ${ticket.subject}`, at: ticket.resolvedAt ?? ticket.openedAt })),
        ...state.lostDemand.map((lost) => ({ id: `lost:${lost.id}`, type: 'order.lost', label: `${lost.customerName} · out of stock`, at: lost.at })),
      ].sort((a, b) => b.at - a.at)),
    },
    {
      method: 'POST', path: '/api/products/:id/restock',
      command: ({ params, body }) => ({ type: 'restock', payload: { productId: params.id ?? '', quantity: numberField(body, 'quantity') } }),
      resolve: ({ state, params }) => json(state.products.find((product) => product.id === params.id) ?? null),
    },
    {
      method: 'POST', path: '/api/orders/:id/cancel',
      command: ({ params }) => ({ type: 'order.cancel', payload: { orderId: params.id ?? '' } }),
      resolve: ({ state, params }) => json(state.orders.find((order) => order.id === params.id) ?? null),
    },
    {
      method: 'POST', path: '/api/tickets/:id/resolve',
      command: ({ params }) => ({ type: 'ticket.resolve', payload: { ticketId: params.id ?? '' } }),
      resolve: ({ state, params }) => json(state.tickets.find((ticket) => ticket.id === params.id) ?? null),
    },
  ],
  effects: [
    { when: 'order.created', invalidate: () => [resourceKey('alive', 'orders'), resourceKey('alive', 'products'), resourceKey('alive', 'customers'), resourceKey('alive', 'overview'), resourceKey('alive', 'activity')] },
    { when: 'order.cancelled', invalidate: () => [resourceKey('alive', 'orders'), resourceKey('alive', 'products'), resourceKey('alive', 'customers'), resourceKey('alive', 'overview'), resourceKey('alive', 'activity')] },
    { when: 'order.lost', invalidate: () => [resourceKey('alive', 'activity'), resourceKey('alive', 'overview')] },
    { when: 'inventory.changed', invalidate: () => [resourceKey('alive', 'products'), resourceKey('alive', 'overview')] },
    { when: 'inventory.low', invalidate: () => [resourceKey('alive', 'products'), resourceKey('alive', 'overview')] },
    { when: 'inventory.stockout', invalidate: () => [resourceKey('alive', 'products'), resourceKey('alive', 'overview')] },
    { when: 'support.ticket.opened', invalidate: () => [resourceKey('alive', 'tickets'), resourceKey('alive', 'overview'), resourceKey('alive', 'activity')] },
    { when: 'support.ticket.resolved', invalidate: () => [resourceKey('alive', 'tickets'), resourceKey('alive', 'overview'), resourceKey('alive', 'activity')] },
  ],
});
