import { conflict, notFound } from '../../common/errors';
import { pageMeta } from '../../common/pagination';
import type { AuthContext } from '../../common/types';
import { pool } from '../../db/pool';
import { withTransaction } from '../../db/transaction';
import { insertMovement } from '../stock-movements/repository';
import { enqueueProductUpdate } from '../sync/outbox';
import * as repo from './repository';
import type { ProductRow } from './repository';
import type { AdjustStockInput, CreateProductInput, ListProductsInput, UpdateProductInput } from './schemas';

export type Product = Omit<ProductRow, 'tenantId'>;

const toProduct = ({ tenantId: _tenantId, ...rest }: ProductRow): Product => rest;

const snapshot = (p: ProductRow, overrides: Partial<{ stock: number }> = {}) => ({
  tenantId: p.tenantId,
  productId: p.id,
  sku: p.sku,
  stock: overrides.stock ?? p.stock,
  price: p.price,
  version: p.version,
});

export async function listProducts(auth: AuthContext, input: ListProductsInput) {
  const { items, total } = await repo.listProducts(pool, auth.tenantId, input);
  return { data: items.map(toProduct), meta: pageMeta(input.page, input.limit, total) };
}

export async function getProduct(auth: AuthContext, id: string): Promise<Product> {
  const product = await repo.findProduct(pool, auth.tenantId, id);
  if (!product) throw notFound('Product');
  return toProduct(product);
}

export async function createProduct(auth: AuthContext, input: CreateProductInput): Promise<Product> {
  return withTransaction(async (client) => {
    // A duplicate (tenant, sku) raises 23505, translated to 409 SKU_ALREADY_EXISTS by the error handler.
    const product = await repo.insertProduct(client, auth.tenantId, input);
    if (product.stock > 0) {
      await insertMovement(client, {
        tenantId: auth.tenantId,
        productId: product.id,
        userId: auth.userId,
        delta: product.stock,
        stockAfter: product.stock,
        reason: 'CREATE',
      });
    }
    await enqueueProductUpdate(client, snapshot(product));
    return toProduct(product);
  });
}

export async function updateProduct(auth: AuthContext, id: string, input: UpdateProductInput): Promise<Product> {
  return withTransaction(async (client) => {
    const current = await repo.findProduct(client, auth.tenantId, id, { forUpdate: true });
    if (!current) throw notFound('Product');

    const price = input.price ?? current.price;
    // Only a price change is relevant to the ads service; a rename must not create sync traffic.
    const priceChanged = Number(price) !== Number(current.price);
    const updated = await repo.updateProductDetails(client, auth.tenantId, id, {
      name: input.name ?? current.name,
      price,
      bumpVersion: priceChanged,
    });
    if (priceChanged) await enqueueProductUpdate(client, snapshot(updated));
    return toProduct(updated);
  });
}

export async function deleteProduct(auth: AuthContext, id: string): Promise<void> {
  await withTransaction(async (client) => {
    const current = await repo.findProduct(client, auth.tenantId, id, { forUpdate: true });
    if (!current) throw notFound('Product');
    const deleted = await repo.softDeleteProduct(client, auth.tenantId, id);
    // A deleted product must stop being advertised: tell the ads service it has no stock.
    await enqueueProductUpdate(client, snapshot(deleted, { stock: 0 }));
  });
}

export async function adjustStock(auth: AuthContext, id: string, input: AdjustStockInput): Promise<Product> {
  return withTransaction(async (client) => {
    const updated = await repo.applyStockDelta(client, auth.tenantId, id, input.delta);
    if (!updated) {
      const current = await repo.peekStock(client, auth.tenantId, id);
      if (!current) throw notFound('Product');
      throw conflict('INSUFFICIENT_STOCK', `Adjustment would make stock negative for SKU ${current.sku}`, {
        sku: current.sku,
        available: current.stock,
        requestedDelta: input.delta,
      });
    }
    await insertMovement(client, {
      tenantId: auth.tenantId,
      productId: id,
      userId: auth.userId,
      delta: input.delta,
      stockAfter: updated.stock,
      reason: 'ADJUSTMENT',
      note: input.note,
    });
    await enqueueProductUpdate(client, snapshot(updated));
    return toProduct(updated);
  });
}
