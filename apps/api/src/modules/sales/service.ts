import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { conflict, notFound, unprocessable } from '../../common/errors';
import { fromCents, toCents } from '../../common/money';
import type { AuthContext } from '../../common/types';
import { withTransaction } from '../../db/transaction';
import { applyStockDelta, peekStock } from '../products/repository';
import { insertMovement } from '../stock-movements/repository';
import { enqueueProductUpdate } from '../sync/outbox';
import * as repo from './repository';
import type { CreateSaleInput } from './schemas';

export interface SaleBody {
  id: string;
  total: string;
  createdAt: string;
  items: { productId: string; sku: string; quantity: number; unitPrice: string }[];
}

export interface SaleResult {
  status: number;
  body: SaleBody;
  /** true when the response was replayed from a previous request with the same Idempotency-Key */
  replayed: boolean;
}

/** Same logical request => same hash, regardless of item order. */
function hashRequest(input: CreateSaleInput): string {
  const items = [...input.items].sort((a, b) => a.productId.localeCompare(b.productId));
  return createHash('sha256').update(JSON.stringify(items)).digest('hex');
}

async function insufficientStockError(client: PoolClient, auth: AuthContext, productId: string, requested: number) {
  const current = await peekStock(client, auth.tenantId, productId);
  if (!current) return notFound('Product');
  return conflict('INSUFFICIENT_STOCK', `Insufficient stock for SKU ${current.sku}`, {
    productId,
    sku: current.sku,
    requested,
    available: current.stock,
  });
}

/**
 * Registers a sale atomically.
 *
 * - All-or-nothing: everything happens in one transaction; if any item fails, the whole thing rolls back.
 * - No overselling: each item uses a conditional UPDATE (`stock >= qty`) that is atomic under the row lock,
 *   so concurrent sales serialise on the row and the loser sees the reduced stock and fails.
 * - Items are processed in productId order so two concurrent sales always lock rows in the same order
 *   (no deadlocks).
 * - Idempotent: with an Idempotency-Key, a retry returns the original response and changes nothing.
 * - The outbox event for each changed product is written in the same transaction; the request never
 *   waits for the external service.
 */
export async function createSale(
  auth: AuthContext,
  input: CreateSaleInput,
  idempotencyKey?: string,
): Promise<SaleResult> {
  return withTransaction(async (client) => {
    const requestHash = hashRequest(input);

    if (idempotencyKey) {
      const owned = await repo.reserveKey(client, auth.tenantId, idempotencyKey, requestHash);
      if (!owned) {
        const stored = await repo.getKey(client, auth.tenantId, idempotencyKey);
        if (stored && stored.requestHash !== requestHash) {
          throw unprocessable(
            'IDEMPOTENCY_KEY_REUSED',
            'This Idempotency-Key was already used with a different request body',
          );
        }
        if (stored) {
          return { status: stored.responseStatus, body: stored.responseBody as SaleBody, replayed: true };
        }
      }
    }

    const saleId = randomUUID();
    const items = [...input.items].sort((a, b) => a.productId.localeCompare(b.productId));
    const lines: SaleBody['items'] = [];
    const changed = [];
    let totalCents = 0n;

    for (const item of items) {
      const product = await applyStockDelta(client, auth.tenantId, item.productId, -item.quantity);
      if (!product) throw await insufficientStockError(client, auth, item.productId, item.quantity);
      lines.push({ productId: product.id, sku: product.sku, quantity: item.quantity, unitPrice: product.price });
      totalCents += toCents(product.price) * BigInt(item.quantity);
      changed.push(product);
    }

    const total = fromCents(totalCents);
    const { createdAt } = await repo.insertSale(client, {
      id: saleId,
      tenantId: auth.tenantId,
      userId: auth.userId,
      total,
    });

    for (const [index, product] of changed.entries()) {
      const line = lines[index]!;
      await repo.insertSaleItem(client, {
        saleId,
        tenantId: auth.tenantId,
        productId: product.id,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
      });
      await insertMovement(client, {
        tenantId: auth.tenantId,
        productId: product.id,
        userId: auth.userId,
        delta: -line.quantity,
        stockAfter: product.stock,
        reason: 'SALE',
        refId: saleId,
      });
      await enqueueProductUpdate(client, {
        tenantId: auth.tenantId,
        productId: product.id,
        sku: product.sku,
        stock: product.stock,
        price: product.price,
        version: product.version,
      });
    }

    const body: SaleBody = { id: saleId, total, createdAt, items: lines };
    if (idempotencyKey) {
      await repo.saveKeyResponse(client, auth.tenantId, idempotencyKey, 201, body);
    }
    return { status: 201, body, replayed: false };
  });
}
