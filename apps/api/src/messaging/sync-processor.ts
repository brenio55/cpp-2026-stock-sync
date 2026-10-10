import type { Logger } from 'pino';
import type { AdsClient } from '../integrations/ads-client';
import { pool } from '../db/pool';
import * as repo from '../modules/sync/repository';
import type { SyncMessage, UpdateRef } from '../modules/sync/repository';
import { nextAction } from './retry-policy';

/** A message plus how many attempts have already failed for it. */
export interface Incoming {
  msg: SyncMessage;
  attempts: number;
}

export type Outcome =
  | { type: 'SENT' }
  | { type: 'SUPERSEDED' }
  | { type: 'RETRY'; delayMs: number; attempts: number }
  | { type: 'DEAD'; attempts: number; error: string };

export interface Result {
  item: Incoming;
  outcome: Outcome;
}

export interface ProcessorOptions {
  ads: AdsClient;
  limiter: { acquire(): Promise<void> };
  maxAttempts: number;
  retryDelaysMs: number[];
  log: Logger;
}

const ref = (i: Incoming): UpdateRef => ({ productId: i.msg.productId, version: i.msg.version, attempts: i.attempts });

/**
 * Turns a buffer of queue messages into calls to the ads service. It decides; it does not talk to the broker.
 * The consumer applies the returned outcomes (ack / publish to a retry queue / publish to the DLQ).
 *
 * Guarantees:
 *  - Tenant isolation: messages are grouped by tenant and every outbound batch contains one tenant only.
 *  - No stale overwrites: per product only the highest version is sent, and a version is dropped when the
 *    database already shows the same or a newer version sent, or a newer one pending.
 *  - Safe to repeat: a crash after sending but before acking just re-sends; the ads service ignores
 *    versions it has already seen, and finished rows are never overwritten (status guard in the repository).
 */
export class SyncProcessor {
  constructor(private readonly opts: ProcessorOptions) {}

  async processBatch(items: Incoming[]): Promise<Result[]> {
    const byTenant = new Map<string, Incoming[]>();
    for (const item of items) {
      const group = byTenant.get(item.msg.tenantId) ?? [];
      group.push(item);
      byTenant.set(item.msg.tenantId, group);
    }
    const results: Result[] = [];
    // Map iteration follows first appearance, so tenants are served in arrival order (no tenant starves).
    for (const [tenantId, group] of byTenant) {
      results.push(...(await this.processTenant(tenantId, group)));
    }
    return results;
  }

  private async processTenant(tenantId: string, group: Incoming[]): Promise<Result[]> {
    const results: Result[] = [];
    const supersededRefs: UpdateRef[] = [];
    const supersede = (item: Incoming, writeToDb: boolean) => {
      results.push({ item, outcome: { type: 'SUPERSEDED' } });
      if (writeToDb) supersededRefs.push(ref(item));
    };

    // 1. Within the batch keep only the newest version of each product.
    const newest = new Map<string, Incoming>();
    for (const item of group) {
      const current = newest.get(item.msg.productId);
      if (!current || item.msg.version > current.msg.version) {
        // the replaced item is older (needs its row closed), or absent
        if (current) supersede(current, current.msg.version < item.msg.version);
        newest.set(item.msg.productId, item);
      } else {
        // an exact duplicate shares the surviving item's row, so it must not close it
        supersede(item, item.msg.version < current.msg.version);
      }
    }

    // 2. Compare against what the database already knows.
    const state = await repo.getVersionState(pool, tenantId, [...newest.keys()]);
    const toSend: Incoming[] = [];
    for (const item of newest.values()) {
      const s = state.get(item.msg.productId);
      const alreadyCovered = s && (item.msg.version <= s.maxSent || item.msg.version < s.maxPending);
      if (alreadyCovered) supersede(item, true);
      else toSend.push(item);
    }
    await repo.markSuperseded(pool, tenantId, supersededRefs);
    if (toSend.length === 0) return results;

    // 3. One rate-limited request for this tenant.
    await this.opts.limiter.acquire();
    try {
      await this.opts.ads.sendBatch(
        tenantId,
        toSend.map(({ msg }) => ({ sku: msg.sku, stock: msg.stock, price: msg.price, version: msg.version })),
      );
    } catch (err) {
      const error = (err as Error).message.slice(0, 500);
      results.push(...(await this.handleFailure(tenantId, toSend, error)));
      return results;
    }

    await repo.markSent(pool, tenantId, toSend.map(ref));
    for (const item of toSend) results.push({ item, outcome: { type: 'SENT' } });
    return results;
  }

  private async handleFailure(tenantId: string, items: Incoming[], error: string): Promise<Result[]> {
    const results: Result[] = [];
    const retrying: Incoming[] = [];
    const dead: Incoming[] = [];

    for (const item of items) {
      const failedAttempts = item.attempts + 1;
      const action = nextAction(failedAttempts, this.opts.maxAttempts, this.opts.retryDelaysMs);
      if (action.type === 'retry') {
        retrying.push(item);
        results.push({ item, outcome: { type: 'RETRY', delayMs: action.delayMs, attempts: failedAttempts } });
      } else {
        dead.push(item);
        results.push({ item, outcome: { type: 'DEAD', attempts: failedAttempts, error } });
      }
    }

    await repo.markRetrying(pool, tenantId, retrying.map(ref), error);
    await repo.markFailed(pool, tenantId, dead.map(ref), error);
    this.opts.log.warn(
      { tenantId, retrying: retrying.length, deadLettered: dead.length, error },
      'sync batch failed',
    );
    return results;
  }
}
