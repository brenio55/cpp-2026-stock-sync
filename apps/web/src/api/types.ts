export type Role = 'admin' | 'operator';

export interface User {
  id: string;
  email: string;
  role: Role;
  tenant: { id: string; name: string };
}

export interface Product {
  id: string;
  sku: string;
  name: string;
  /** decimal string, e.g. "59.90" */
  price: string;
  stock: number;
  version: number;
}

export interface PageMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface Paged<T> {
  data: T[];
  meta: PageMeta;
}

export interface SaleItemInput {
  productId: string;
  quantity: number;
}

export interface Sale {
  id: string;
  total: string;
  createdAt: string;
  items: { productId: string; sku: string; quantity: number; unitPrice: string }[];
}

export interface StockMovement {
  id: string;
  sku: string;
  delta: number;
  stockAfter: number;
  reason: 'SALE' | 'ADJUSTMENT' | 'CREATE';
  note: string | null;
  userEmail: string;
  createdAt: string;
}

export interface SyncStatus {
  counts: { pending: number; sent: number; failed: number; superseded: number };
  lastSuccessAt: string | null;
  recentFailures: { id: number; sku: string; version: number; attempts: number; lastError: string | null; updatedAt: string }[];
}

/** details of an INSUFFICIENT_STOCK error */
export interface StockShortage {
  productId: string;
  sku: string;
  requested: number;
  available: number;
}
