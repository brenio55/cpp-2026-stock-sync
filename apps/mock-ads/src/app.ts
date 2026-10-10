import express, { type Express } from 'express';
import { z } from 'zod';

/**
 * Mock of the external advertising service. It is deliberately hostile:
 *  - at most `rateLimitPerSecond` requests per sliding second (HTTP 429 above that)
 *  - ~`failureRate` of requests fail: half answer 500, half "time out" (the client gives up first), and in
 *    half of those timeouts the update WAS applied, so the caller cannot know whether it landed
 *  - ~`duplicateRate` of accepted batches are applied twice
 * The only state rule is the one a real service would need: an update is applied only if its `version`
 * is newer than the stored one, which makes duplicates and out-of-order delivery harmless.
 */
export interface MockOptions {
  rateLimitPerSecond: number;
  failureRate: number;
  duplicateRate: number;
  /** how long a simulated timeout stalls before answering; must exceed the client's timeout */
  hangMs: number;
  random: () => number;
  now: () => number;
}

export const defaultOptions: MockOptions = {
  rateLimitPerSecond: 5,
  failureRate: 0.2,
  duplicateRate: 0.1,
  hangMs: 8000,
  random: Math.random,
  now: Date.now,
};

const batchSchema = z.object({
  items: z
    .array(
      z.object({
        sku: z.string().min(1),
        stock: z.number().int().min(0),
        price: z.union([z.string(), z.number()]),
        version: z.number().int().min(1),
      }),
    )
    .min(1)
    .max(1000),
});

interface Stored {
  stock: number;
  price: string | number;
  version: number;
}

export interface Stats {
  received: number;
  rateLimited: number;
  failed500: number;
  timeouts: number;
  accepted: number;
  duplicateDeliveries: number;
  applied: number;
  staleIgnored: number;
}

const emptyStats = (): Stats => ({
  received: 0,
  rateLimited: 0,
  failed500: 0,
  timeouts: 0,
  accepted: 0,
  duplicateDeliveries: 0,
  applied: 0,
  staleIgnored: 0,
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createMockApp(overrides: Partial<MockOptions> = {}) {
  const opts: MockOptions = { ...defaultOptions, ...overrides };
  // Keyed per tenant: tenants never see or affect each other's data.
  const products = new Map<string, Map<string, Stored>>();
  let stats = emptyStats();
  let recentRequests: number[] = [];

  function apply(tenant: string, items: z.infer<typeof batchSchema>['items']) {
    const tenantProducts = products.get(tenant) ?? new Map<string, Stored>();
    products.set(tenant, tenantProducts);
    let applied = 0;
    let ignored = 0;
    for (const item of items) {
      const current = tenantProducts.get(item.sku);
      if (!current || item.version > current.version) {
        tenantProducts.set(item.sku, { stock: item.stock, price: item.price, version: item.version });
        applied++;
      } else {
        ignored++;
      }
    }
    stats.applied += applied;
    stats.staleIgnored += ignored;
    return { applied, ignored };
  }

  const app: Express = express();
  app.use(express.json({ limit: '1mb' }));

  app.post('/v1/products/batch', async (req, res) => {
    stats.received++;

    // 1. rate limit: sliding window of one second
    const now = opts.now();
    recentRequests = recentRequests.filter((t) => now - t < 1000);
    if (recentRequests.length >= opts.rateLimitPerSecond) {
      stats.rateLimited++;
      res.setHeader('Retry-After', '1');
      res.status(429).json({ error: 'rate limit exceeded' });
      return;
    }
    recentRequests.push(now);

    // 2. validation
    const tenant = req.get('x-tenant-id');
    const parsed = batchSchema.safeParse(req.body);
    if (!tenant || !parsed.success) {
      res.status(400).json({ error: 'invalid request' });
      return;
    }
    const { items } = parsed.data;

    // 3. random failures
    const roll = opts.random();
    if (roll < opts.failureRate / 2) {
      stats.failed500++;
      res.status(500).json({ error: 'internal error' });
      return;
    }
    if (roll < opts.failureRate) {
      stats.timeouts++;
      if (opts.random() < 0.5) apply(tenant, items); // applied, but the caller will never find out
      await sleep(opts.hangMs);
      res.status(503).json({ error: 'timed out' });
      return;
    }

    // 4. success, sometimes processed twice
    stats.accepted++;
    const result = apply(tenant, items);
    if (opts.random() < opts.duplicateRate) {
      stats.duplicateDeliveries++;
      apply(tenant, items);
    }
    res.json(result);
  });

  // Inspection helpers for tests and demos.
  app.get('/_debug/state', (req, res) => {
    const tenant = typeof req.query.tenant === 'string' ? req.query.tenant : undefined;
    const view = (m: Map<string, Stored>) => Object.fromEntries(m);
    res.json({
      stats,
      products: tenant
        ? view(products.get(tenant) ?? new Map())
        : Object.fromEntries([...products].map(([t, m]) => [t, view(m)])),
    });
  });
  app.post('/_debug/reset', (_req, res) => {
    products.clear();
    stats = emptyStats();
    recentRequests = [];
    res.status(204).end();
  });

  return app;
}
