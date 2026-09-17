export type ProductStatus = 'healthy' | 'low' | 'sold-out';
export type OrderStatus = 'paid' | 'cancelled';
export type TicketStatus = 'open' | 'resolved';

export interface Product {
  id: string;
  name: string;
  sku: string;
  price: number;
  stock: number;
  initialStock: number;
  status: ProductStatus;
  accent: string;
}

export interface Customer {
  id: string;
  name: string;
  city: string;
  email: string;
  orders: number;
  lifetimeValue: number;
  joinedAt: number;
}

export interface OrderLine {
  productId: string;
  quantity: number;
  unitPrice: number;
}

export interface Order {
  id: string;
  customerId: string;
  customerName: string;
  status: OrderStatus;
  total: number;
  createdAt: number;
  lines: OrderLine[];
}

export interface SupportTicket {
  id: string;
  customerId: string;
  customerName: string;
  orderId: string;
  subject: string;
  status: TicketStatus;
  openedAt: number;
  resolvedAt: number | null;
}

export interface LostDemand {
  id: string;
  customerId: string;
  customerName: string;
  productId: string;
  quantity: number;
  at: number;
  reason: 'out-of-stock';
}

export interface LaunchWorld {
  products: Product[];
  customers: Customer[];
  orders: Order[];
  tickets: SupportTicket[];
  lostDemand: LostDemand[];
  metrics: {
    revenue: number;
    orders: number;
    unitsSold: number;
    lostOrders: number;
  };
}
