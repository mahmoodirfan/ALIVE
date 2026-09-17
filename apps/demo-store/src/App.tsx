import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { ComparisonReport } from '@alive-internal/core';
import { Devtools } from './components/Devtools.js';
import { Icon, type IconName } from './components/Icons.js';
import { MetricCard } from './components/MetricCard.js';
import { StatusPill } from './components/StatusPill.js';
import { api } from './lib/http.js';
import { queryKeys } from './lib/queries.js';
import { formatMoney, formatVirtualTime } from './lib/time.js';
import { useSimulationRevision } from './lib/useSimulation.js';
import { simulation } from './runtime.js';
import { HERO_HORIZON } from './scenario/constants.js';
import type { Customer, LaunchWorld, Order, Product, SupportTicket } from './scenario/types.js';

interface Overview {
  metrics: LaunchWorld['metrics'];
  lowStock: Array<{ id: string; name: string; stock: number; status: Product['status'] }>;
  recentOrders: Order[];
  openTickets: number;
}

type Page = 'Overview' | 'Orders' | 'Products' | 'Customers' | 'Support' | 'Activity';
const nav: Array<{ label: Page; icon: IconName }> = [
  { label: 'Overview', icon: 'grid' }, { label: 'Orders', icon: 'bag' }, { label: 'Products', icon: 'box' },
  { label: 'Customers', icon: 'users' }, { label: 'Support', icon: 'message' }, { label: 'Activity', icon: 'pulse' },
];

function query<T>(key: readonly unknown[], path: string) {
  return useQuery({ queryKey: key, queryFn: () => api<T>(path) });
}

function Empty({ title, note }: { title: string; note: string }) {
  return <div className="empty-state"><div className="empty-mark">●</div><strong>{title}</strong><span>{note}</span></div>;
}

function OverviewPage() {
  const overview = query<Overview>(queryKeys.overview, '/api/overview');
  const products = query<Product[]>(queryKeys.products, '/api/products');
  const data = overview.data;
  const arc = products.data?.find((product) => product.id === 'arc-lamp');
  if (!data) return <Empty title="Launch is quiet" note="Start the simulation and this store will begin to move." />;
  return <>
    <section className="metrics-grid">
      <MetricCard label="Revenue" value={formatMoney(data.metrics.revenue)} icon={<Icon name="pulse" />} meta={<span className="meta-positive">Live from paid orders</span>} />
      <MetricCard label="Orders" value={String(data.metrics.orders)} icon={<Icon name="bag" />} meta={<span>{data.metrics.unitsSold} units sold</span>} />
      <MetricCard label="Arc Desk Lamp" value={String(arc?.stock ?? 0)} icon={<Icon name="box" />} meta={arc?.status === 'sold-out' ? <span className="meta-negative">Sold out</span> : <span>{arc?.status === 'low' ? 'Low stock' : 'In stock'}</span>} />
      <MetricCard label="Support" value={String(data.openTickets)} icon={<Icon name="message" />} meta={<span>Open tickets</span>} />
    </section>
    <section className="overview-grid">
      <article className="panel sales-panel">
        <div className="panel-head"><div><span className="eyebrow">Launch pulse</span><h2>Revenue is built from the orders below</h2></div><StatusPill tone="blue">Live simulation</StatusPill></div>
        <RevenueBars orders={data.recentOrders} />
      </article>
      <article className="panel inventory-watch">
        <div className="panel-head"><div><span className="eyebrow">Inventory watch</span><h2>What needs attention</h2></div></div>
        {data.lowStock.length === 0 ? <div className="calm-state"><span className="calm-dot"/>All products comfortably stocked</div> : data.lowStock.map((item) => <div className="watch-row" key={item.id}><div><strong>{item.name}</strong><span>{item.stock} remaining</span></div><StatusPill tone={item.status === 'sold-out' ? 'bad' : 'warn'}>{item.status === 'sold-out' ? 'Sold out' : 'Low'}</StatusPill></div>)}
      </article>
    </section>
    <article className="panel table-panel">
      <div className="panel-head"><div><span className="eyebrow">Latest orders</span><h2>The launch as it happens</h2></div></div>
      {data.recentOrders.length === 0 ? <Empty title="No orders yet" note="Press Run Launch in ALIVE to start the day." /> : <OrdersTable orders={data.recentOrders} compact />}
    </article>
  </>;
}

function RevenueBars({ orders }: { orders: Order[] }) {
  const points = [...orders].reverse();
  const max = Math.max(200, ...points.map((order) => order.total));
  return <div className="bar-chart" aria-label="Recent order values">
    {points.length === 0 ? Array.from({ length: 8 }, (_, i) => <div key={i} className="bar ghost" style={{ height: `${18 + i * 6}%` }} />) : points.map((order) => <div key={order.id} className="bar-wrap"><div className="bar" style={{ height: `${Math.max(18, order.total / max * 100)}%` }} /><span>{formatVirtualTime(order.createdAt)}</span></div>)}
  </div>;
}

function OrdersTable({ orders, compact = false }: { orders: Order[]; compact?: boolean }) {
  const cancel = useMutation({ mutationFn: (id: string) => api<Order>(`/api/orders/${id}/cancel`, { method: 'POST', body: '{}' }) });
  return <div className="table-scroll"><table><thead><tr><th>Order</th><th>Customer</th><th>Time</th><th>Total</th><th>Status</th>{!compact && <th/>}</tr></thead><tbody>{orders.map((order) => <tr key={order.id}><td><strong>{order.id}</strong></td><td>{order.customerName}</td><td>{formatVirtualTime(order.createdAt)}</td><td>{formatMoney(order.total)}</td><td><StatusPill tone={order.status === 'paid' ? 'good' : 'neutral'}>{order.status}</StatusPill></td>{!compact && <td className="cell-action">{order.status === 'paid' && <button className="text-button" onClick={() => cancel.mutate(order.id)}>Cancel</button>}</td>}</tr>)}</tbody></table></div>;
}

function OrdersPage() {
  const orders = query<Order[]>(queryKeys.orders, '/api/orders');
  return <article className="panel table-panel page-panel"><div className="panel-head"><div><span className="eyebrow">Orders</span><h2>Every transaction in this timeline</h2></div><span className="table-count">{orders.data?.length ?? 0} records</span></div>{orders.data?.length ? <OrdersTable orders={orders.data} /> : <Empty title="No orders yet" note="The launch has not started." />}</article>;
}

function ProductsPage() {
  const products = query<Product[]>(queryKeys.products, '/api/products');
  const restock = useMutation({ mutationFn: ({ id, quantity }: { id: string; quantity: number }) => api<Product>(`/api/products/${id}/restock`, { method: 'POST', body: JSON.stringify({ quantity }) }) });
  return <div className="product-grid">{products.data?.map((product) => <article className="product-card" key={product.id}><div className={`product-visual product-${product.accent}`}><span>{product.sku}</span><Icon name="box" size={36}/></div><div className="product-body"><div className="product-title"><div><h3>{product.name}</h3><span>{formatMoney(product.price)}</span></div><StatusPill tone={product.status === 'healthy' ? 'good' : product.status === 'low' ? 'warn' : 'bad'}>{product.status === 'healthy' ? 'Healthy' : product.status === 'low' ? 'Low stock' : 'Sold out'}</StatusPill></div><div className="stock-line"><strong>{product.stock}</strong><span>units available</span></div><div className="stock-track"><i style={{ width: `${Math.min(100, product.stock / Math.max(product.initialStock, 1) * 100)}%` }}/></div><button className="secondary-button" onClick={() => restock.mutate({ id: product.id, quantity: product.id === 'arc-lamp' ? 8 : 4 })}>Restock</button></div></article>)}</div>;
}

function CustomersPage() {
  const customers = query<Customer[]>(queryKeys.customers, '/api/customers');
  return <article className="panel page-panel"><div className="panel-head"><div><span className="eyebrow">Customers</span><h2>People entering the launch</h2></div></div><div className="customer-list">{customers.data?.map((customer) => <div className="customer-row" key={customer.id}><div className="avatar">{customer.name.split(' ').map((part) => part[0]).join('').slice(0,2)}</div><div className="customer-main"><strong>{customer.name}</strong><span>{customer.city} · {customer.email}</span></div><div className="customer-number"><strong>{customer.orders}</strong><span>orders</span></div><div className="customer-number"><strong>{formatMoney(customer.lifetimeValue)}</strong><span>lifetime</span></div></div>)}{!customers.data?.length && <Empty title="No customers yet" note="Customers appear as deterministic demand events arrive." />}</div></article>;
}

function SupportPage() {
  const tickets = query<SupportTicket[]>(queryKeys.tickets, '/api/tickets');
  const resolve = useMutation({ mutationFn: (id: string) => api<SupportTicket>(`/api/tickets/${id}/resolve`, { method: 'POST', body: '{}' }) });
  return <article className="panel page-panel"><div className="panel-head"><div><span className="eyebrow">Support</span><h2>Customer conversations</h2></div></div><div className="ticket-list">{tickets.data?.map((ticket) => <div className="ticket-row" key={ticket.id}><div className="ticket-icon"><Icon name="message"/></div><div className="ticket-copy"><strong>{ticket.subject}</strong><span>{ticket.customerName} · {ticket.orderId} · {formatVirtualTime(ticket.openedAt)}</span></div><StatusPill tone={ticket.status === 'open' ? 'warn' : 'good'}>{ticket.status}</StatusPill>{ticket.status === 'open' && <button className="text-button" onClick={() => resolve.mutate(ticket.id)}>Resolve</button>}</div>)}{!tickets.data?.length && <Empty title="Inbox clear" note="A support request arrives during the launch." />}</div></article>;
}

interface ActivityItem { id: string; type: string; label: string; at: number; }

function ActivityPage() {
  const activity = query<ActivityItem[]>(queryKeys.activity, '/api/activity');
  const items = activity.data ?? [];
  return <article className="panel page-panel"><div className="panel-head"><div><span className="eyebrow">Activity</span><h2>What the store has experienced</h2></div><StatusPill tone="blue">API projection</StatusPill></div><div className="activity-list">{items.slice(0, 30).map((item) => <div className="activity-row" key={item.id}><span className={`activity-dot event-${item.type.includes('lost') ? 'bad' : item.type.includes('resolved') ? 'good' : 'normal'}`}/><div><strong>{item.type.replaceAll('.', ' ')}</strong><span>{item.label}</span></div><time>{formatVirtualTime(item.at)}</time></div>)}{items.length === 0 && <Empty title="Nothing has happened yet" note="Run the launch to populate the activity feed." />}</div></article>;
}

function MainPage({ page }: { page: Page }) {
  if (page === 'Overview') return <OverviewPage/>;
  if (page === 'Orders') return <OrdersPage/>;
  if (page === 'Products') return <ProductsPage/>;
  if (page === 'Customers') return <CustomersPage/>;
  if (page === 'Support') return <SupportPage/>;
  return <ActivityPage/>;
}

export function App() {
  const [page, setPage] = useState<Page>('Overview');
  useSimulationRevision();
  const comparison: ComparisonReport | null = useMemo(() => {
    const active = simulation.getActiveBranchId();
    if (active === 'branch:root') return null;
    const branches = simulation.getBranches();
    const root = branches.find((branch) => branch.id === 'branch:root');
    const current = branches.find((branch) => branch.id === active);
    if (!root || !current || root.ranTo < HERO_HORIZON || current.ranTo < HERO_HORIZON) return null;
    try { return simulation.compareBranches('branch:root', active, { until: 'scenario-end' }); } catch { return null; }
  }, [simulation.getActiveBranchId(), simulation.getHeadTime(), simulation.getBranches().length]);

  return <div className="app-frame">
    <aside className="sidebar">
      <div className="brand"><span className="alive-orb"><i/></span><div><strong>ALIVE</strong><small>Northstar Goods</small></div></div>
      <nav>{nav.map((item) => <button key={item.label} className={page === item.label ? 'active' : ''} onClick={() => setPage(item.label)}><Icon name={item.icon}/><span>{item.label}</span></button>)}</nav>
      <div className="sidebar-story"><Icon name="spark"/><strong>Product Launch</strong><span>A deterministic Saturday at Northstar Goods.</span></div>
      <div className="sidebar-foot"><span className="live-dot"/>Simulated world</div>
    </aside>
    <main className="content-shell">
      <header className="topbar"><div><span className="eyebrow">Saturday, 19 September</span><h1>{page}</h1></div><div className="top-actions"><div className="launch-chip"><span className="live-dot"/><div><small>Launch clock</small><strong>{formatVirtualTime(simulation.getState() ? (simulation.getViewMode() === 'scrubbing' ? simulation.getScrubCursor()?.virtualTime ?? simulation.getHeadTime() : simulation.getHeadTime()) : 0)}</strong></div></div><button className="avatar-button">IM</button></div></header>
      <section className="page-content"><MainPage page={page}/></section>
    </main>
    <Devtools comparison={comparison}/>
  </div>;
}
