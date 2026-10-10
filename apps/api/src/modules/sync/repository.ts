import type { Queryable } from '../../common/types';

/** What travels through RabbitMQ. Always the full current state of one product at one version. */
export interface SyncMessage {
  outboxId: number;
  tenantId: string;
  productId: string;
  sku: string;
  stock: number;
  price: string;
  version: number;
}

export interface UpdateRef {
  productId: string;
  version: number;
  /** failed attempts made before this one */
  attempts: number;
}

export interface SyncStatus {
  counts: { pending: number; sent: number; failed: number; superseded: number };
  lastSuccessAt: string | null;
  recentFailures: {
    id: number;
    sku: string;
    version: number;
    attempts: number;
    lastError: string | null;
    updatedAt: string;
  }[];
}

/** Tenant-scoped sync report. `pending` includes events still waiting in the outbox. */
export async function getStatus(db: Queryable, tenantId: string): Promise<SyncStatus> {
  const [byStatus, outbox, state, failures] = await Promise.all([
    db.query('SELECT status, count(*)::int AS n FROM sync_updates WHERE tenant_id = $1 GROUP BY status', [tenantId]),
    db.query('SELECT count(*)::int AS n FROM outbox_events WHERE tenant_id = $1 AND published_at IS NULL', [tenantId]),
    db.query('SELECT last_success_at FROM sync_state WHERE tenant_id = $1', [tenantId]),
    db.query(
      `SELECT id, sku, version, attempts, last_error, updated_at FROM sync_updates
        WHERE tenant_id = $1 AND status = 'FAILED' ORDER BY updated_at DESC, id DESC LIMIT 20`,
      [tenantId],
    ),
  ]);

  const n = (status: string) => byStatus.rows.find((r) => r.status === status)?.n ?? 0;
  return {
    counts: {
      pending: n('PENDING') + outbox.rows[0].n,
      sent: n('SENT'),
      failed: n('FAILED'),
      superseded: n('SUPERSEDED'),
    },
    lastSuccessAt: state.rows[0]?.last_success_at?.toISOString() ?? null,
    recentFailures: failures.rows.map((r) => ({
      id: r.id,
      sku: r.sku,
      version: r.version,
      attempts: r.attempts,
      lastError: r.last_error,
      updatedAt: r.updated_at.toISOString(),
    })),
  };
}

/** Highest SENT and PENDING version per product, used to drop stale and duplicate updates. */
export async function getVersionState(
  db: Queryable,
  tenantId: string,
  productIds: string[],
): Promise<Map<string, { maxSent: number; maxPending: number }>> {
  const res = await db.query(
    `SELECT product_id,
            COALESCE(max(version) FILTER (WHERE status = 'SENT'), 0)    AS max_sent,
            COALESCE(max(version) FILTER (WHERE status = 'PENDING'), 0) AS max_pending
       FROM sync_updates
      WHERE tenant_id = $1 AND product_id = ANY($2::uuid[])
      GROUP BY product_id`,
    [tenantId, productIds],
  );
  return new Map(res.rows.map((r) => [r.product_id, { maxSent: r.max_sent, maxPending: r.max_pending }]));
}

type Transition = 'SENT' | 'SUPERSEDED' | 'FAILED' | 'PENDING';

/**
 * Moves updates out of PENDING. The `status = 'PENDING'` guard means a finished update (SENT/FAILED/SUPERSEDED)
 * is never overwritten by a late duplicate message.
 * `attempts` is stored as previous failures + 1 for the outcomes that consumed an attempt.
 */
async function transition(
  db: Queryable,
  tenantId: string,
  refs: UpdateRef[],
  status: Transition,
  opts: { countAttempt: boolean; error?: string },
): Promise<void> {
  if (refs.length === 0) return;
  await db.query(
    `UPDATE sync_updates s
        SET status = $2,
            attempts = t.attempts + $3,
            last_error = $4,
            updated_at = now()
       FROM unnest($5::uuid[], $6::bigint[], $7::int[]) AS t(product_id, version, attempts)
      WHERE s.tenant_id = $1 AND s.product_id = t.product_id AND s.version = t.version AND s.status = 'PENDING'`,
    [
      tenantId,
      status,
      opts.countAttempt ? 1 : 0,
      opts.error ?? null,
      refs.map((r) => r.productId),
      refs.map((r) => r.version),
      refs.map((r) => r.attempts),
    ],
  );
}

export async function markSent(db: Queryable, tenantId: string, refs: UpdateRef[]): Promise<void> {
  if (refs.length === 0) return;
  await transition(db, tenantId, refs, 'SENT', { countAttempt: true });
  await db.query(
    `INSERT INTO sync_state (tenant_id, last_success_at) VALUES ($1, now())
     ON CONFLICT (tenant_id) DO UPDATE SET last_success_at = EXCLUDED.last_success_at`,
    [tenantId],
  );
}

export const markSuperseded = (db: Queryable, tenantId: string, refs: UpdateRef[]) =>
  transition(db, tenantId, refs, 'SUPERSEDED', { countAttempt: false });

/** A failed attempt that will be retried: stays PENDING, records the attempt count and the error. */
export const markRetrying = (db: Queryable, tenantId: string, refs: UpdateRef[], error: string) =>
  transition(db, tenantId, refs, 'PENDING', { countAttempt: true, error });

/** Retries exhausted: dead-lettered. */
export const markFailed = (db: Queryable, tenantId: string, refs: UpdateRef[], error: string) =>
  transition(db, tenantId, refs, 'FAILED', { countAttempt: true, error });

export interface FailedUpdate {
  id: number;
  productId: string;
  version: number;
}

export async function lockFailedUpdate(db: Queryable, tenantId: string, id: number): Promise<FailedUpdate | null> {
  const res = await db.query(
    `SELECT id, product_id, version FROM sync_updates
      WHERE tenant_id = $1 AND id = $2 AND status = 'FAILED' FOR UPDATE`,
    [tenantId, id],
  );
  const r = res.rows[0];
  return r ? { id: r.id, productId: r.product_id, version: r.version } : null;
}

export async function setUpdateStatus(
  db: Queryable,
  tenantId: string,
  id: number,
  status: 'PENDING' | 'SUPERSEDED',
): Promise<void> {
  await db.query(
    `UPDATE sync_updates SET status = $3, attempts = 0, last_error = NULL, updated_at = now()
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id, status],
  );
}

/** Current state of a product including soft-deleted ones (a deleted product is advertised as stock 0). */
export async function getProductState(db: Queryable, tenantId: string, productId: string) {
  const res = await db.query(
    `SELECT sku, stock, price, version, deleted_at IS NOT NULL AS deleted
       FROM products WHERE tenant_id = $1 AND id = $2`,
    [tenantId, productId],
  );
  const r = res.rows[0];
  return r
    ? { sku: r.sku as string, stock: r.deleted ? 0 : (r.stock as number), price: r.price as string, version: r.version as number }
    : null;
}
