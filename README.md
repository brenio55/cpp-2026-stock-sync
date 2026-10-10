# StockSync

A multi-tenant inventory platform. Each tenant manages a product catalogue and registers sales. Every change of stock or price is pushed, asynchronously and reliably, to an external advertising service that is slow, rate-limited and flaky, so ads never promote items that are out of stock.

- **Backend:** Node 22, Express 5, TypeScript, PostgreSQL (`pg`, plain SQL migrations), RabbitMQ
- **Frontend:** React 19 + Vite + TypeScript, React Query, React Router
- **Mock of the ads service:** a separate small Express app (5 req/s limit, ~20% failures and timeouts, duplicate deliveries)

## Quick start

Requirements: Docker with Compose v2.

```bash
docker compose up --build
```

| What | URL |
|---|---|
| Web UI | http://localhost:8080 |
| API | http://localhost:3000 (health: `/health`, **Swagger UI: `/docs`**) |
| RabbitMQ management | http://localhost:15672 (user `stocksync`, password `stocksync`) |
| Mock ads service | http://localhost:4000 (inspect what it received: `/_debug/state`) |

Compose starts PostgreSQL and RabbitMQ, runs a one-shot `migrate` job (migrations + demo seed, idempotent), then the `api`, the `worker` and the `web` containers.

### Demo users (password `password123`)

| Email | Role | Tenant |
|---|---|---|
| admin@acme.test | admin | Acme Store |
| operator@acme.test | operator | Acme Store |
| admin@globex.test | admin | Globex Retail |
| operator@globex.test | operator | Globex Retail |

Both tenants have a product with the SKU `ABC-001`, to show that a SKU is unique **per tenant**, not globally. Each tenant also has an out-of-stock product. To test isolation, log in as one tenant in a normal window and as the other in a private window.

> Port note: PostgreSQL is published on **5433** (not 5432) so it does not clash with a local PostgreSQL. Change it with `POSTGRES_PORT` in `.env`.

### Local development (without containers for the apps)

```bash
cp .env.example .env
npm install
npm run infra:up          # PostgreSQL + RabbitMQ only
npm run migrate && npm run seed

npm run dev -w @stocksync/api          # API        :3000
npm run dev:worker -w @stocksync/api   # worker (relay + sync consumer)
npm run dev -w @stocksync/mock-ads     # mock ads   :4000
npm run dev -w @stocksync/web          # web        :5173 (proxies /api to :3000)
```

### Tests, lint, build

```bash
npm run infra:up      # the API tests need PostgreSQL (RabbitMQ is not needed)
npm test              # API (48 tests) + mock ads (6 tests)
npm run lint
npm run typecheck
npm run build
```

The API tests create and use their own `stocksync_test` database (the name must end in `_test` or the suite refuses to run), so they never touch development data. CI (`.github/workflows/ci.yml`) runs lint, typecheck, tests and build against a PostgreSQL service container.

### Environment variables

See [`.env.example`](.env.example). The ones that matter:

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | – | PostgreSQL connection string (required) |
| `RABBITMQ_URL` | – | AMQP URL (required for the worker and `/health`) |
| `JWT_SECRET` | – | At least 32 characters (required). Compose uses a development default |
| `JWT_EXPIRES_IN` | `1h` | Token lifetime |
| `ADS_API_URL`, `ADS_TIMEOUT_MS` | `http://localhost:4000`, `3000` | Ads service location and per-request timeout |
| `SYNC_BATCH_SIZE` | `50` | Max updates per outbound batch |
| `SYNC_MAX_ATTEMPTS` | `5` | Attempts before an update is dead-lettered |
| `SYNC_RETRY_DELAYS_MS` | `5000,30000,120000` | Backoff schedule (the last delay repeats) |
| `SYNC_RATE_LIMIT_RPS` | `5` | Outbound requests per second |
| `MOCK_FAILURE_RATE`, `MOCK_RATE_LIMIT`, `MOCK_DUPLICATE_RATE`, `MOCK_HANG_MS` | `0.2`, `5`, `0.1`, `8000` | Chaos knobs of the mock (try `MOCK_FAILURE_RATE=1` to watch updates reach the dead-letter queue) |

---

## Architecture

```
 Browser ──► web (nginx) ──/api──► api (Express)
                                     │  one transaction per request
                                     ▼
                              PostgreSQL ◄────────────────────┐
                  products · sales · stock_movements          │
                  idempotency_keys · outbox_events            │ status
                  sync_updates · sync_state                   │
                                     │                        │
                           worker: outbox relay               │
                         (FOR UPDATE SKIP LOCKED)             │
                                     ▼                        │
                              RabbitMQ  sync.updates          │
                          retry queues (TTL) · sync.dlq       │
                                     │                        │
                           worker: sync consumer ─────────────┘
                  batch per tenant · rate limit 5/s · retry/backoff
                                     ▼
                             ads service (mock)
```

### The central idea: transactional outbox

A sale changes stock in PostgreSQL and must tell the ads service. Writing to the database and then publishing to RabbitMQ are two systems, so a crash between them either loses the notification (ads keep promoting an item that is gone) or announces a change that was rolled back.

Instead, the request **writes an `outbox_events` row in the same transaction** as the stock change. Both commit or neither does. A separate **relay** in the worker publishes outbox rows to RabbitMQ (with publisher confirms) and marks them published. The sale request never waits for RabbitMQ or the ads service: in the live test it answered in 19 ms with the ads service completely down.

Delivery is therefore *at-least-once*: duplicates and reordering are possible, and the design deals with them explicitly (below).

### Stock correctness under concurrency

Each item is updated with one conditional statement:

```sql
UPDATE products SET stock = stock - $q, version = version + 1
 WHERE tenant_id = $t AND id = $id AND deleted_at IS NULL AND stock >= $q
RETURNING ...
```

The check and the write are a single atomic statement under the row lock, so concurrent sales serialise on the row; the loser re-evaluates `stock >= $q` against the committed value and gets zero rows, which becomes `409 INSUFFICIENT_STOCK`. A `CHECK (stock >= 0)` constraint is a second, independent safety net.

- **All-or-nothing:** the whole sale is one transaction; if any item fails, everything rolls back (stock, sale, movements, outbox rows).
- **No deadlocks:** items are processed in `productId` order, so two sales that share products always lock rows in the same order. A test runs sales with items in opposite order concurrently.
- **Why not `SELECT ... FOR UPDATE` then `UPDATE`?** It works too, but costs an extra round trip and holds locks longer; the conditional update is smaller and has nothing to forget.

### Idempotency (`Idempotency-Key` header on `POST /sales`)

The key is inserted **inside the sale transaction** (`PRIMARY KEY (tenant_id, key)`). A concurrent duplicate blocks on that unique index until the first request finishes: if it committed, the duplicate replays the stored response (`Idempotent-Replayed: true`); if it rolled back, the duplicate runs normally. The same key with a different body is rejected with `422`. A *failed* sale (e.g. insufficient stock) rolls back, so it does **not** consume the key and the client can retry after restocking. The key is scoped per tenant. The frontend reuses the same key when retrying an unchanged request after a network error.

### Duplicates and out-of-order delivery

Every price/stock change bumps `products.version`, and each event carries the full current state plus that version (not a delta).

- **Consumer:** within a batch only the newest version of each product is sent; a message is dropped (status `SUPERSEDED`) when the database shows the same or a newer version already `SENT`, or a newer one `PENDING`. Finished rows are never overwritten by a late duplicate (status transitions are guarded by `WHERE status = 'PENDING'`).
- **Ads service (authoritative rule):** applies an update only if `version` is newer than what it stores, so even a request that timed out but was applied, or a duplicate, cannot corrupt state.

### Rate limiting, batching, retries

- **Batching:** the consumer buffers up to `SYNC_BATCH_SIZE` messages (or 200 ms), groups them **by tenant** and sends one request per tenant. RabbitMQ `prefetch` equals the batch size, which bounds the buffer.
- **Rate limit:** requests are spaced at least `1000/5 + 10` ms apart (a token bucket of capacity 1). A bucket that allows a burst of 5 would let 5 requests through at the end of one second and 5 at the start of the next, which a fixed-window server rejects. Slots are reserved synchronously so concurrent callers queue correctly.
- **Backoff:** a failed batch republishes each message to a **TTL retry queue** (`sync.retry.<ms>ms`) which dead-letters it back to the main queue when the TTL expires. The broker does the waiting, so nothing is held in memory and a worker restart loses nothing. Delays: 5 s → 30 s → 2 min (last repeats).
- **Dead letter:** after `SYNC_MAX_ATTEMPTS` the message goes to `sync.dlq`, the row becomes `FAILED` with the last error, and it appears in the status page. An admin can re-queue it (`POST /sync/failed/:id/retry`); that writes a fresh outbox event for the product's *current* state, so the API never needs a broker connection.
- **Crash safety:** the consumer publishes the retry/DLQ message *before* acking the original, so a crash in between duplicates instead of losing. If processing fails for infrastructure reasons (database down), messages are nacked back to the queue untouched.

### Tenant isolation

- The tenant comes **only from the verified JWT**, never from the body, query or path. Bodies are validated with `.strict()`, so a smuggled `tenantId` is rejected.
- Every repository function takes `tenantId` as its first parameter and puts it in the `WHERE` clause. Another tenant's resource answers **404** (not 403), so existence is not revealed.
- The database enforces it too: child tables reference `(id, tenant_id)` with **composite foreign keys**, so a movement, sale item or outbox event can never point at another tenant's product or user, whatever the application does.
- **Background jobs:** every queue message carries `tenantId`; the processor groups by tenant and never mixes tenants in one batch; one tenant's failures do not affect another's rows (tested). The mock ads service also keys its state per tenant.
- Authorization: `admin` manages products and re-queues failed syncs; `operator` can read products and register sales; both can read history and sync status.

### Error handling

One error middleware produces `{ statusCode, code, message, details?, correlationId }`. Validation errors (Zod) list the offending fields. Unknown errors are logged in full on the server and answered with a generic 500; PostgreSQL errors are translated by SQLSTATE code (unique → 409, check → 422, ...) without forwarding the driver's message. A test makes the database fail on purpose and asserts that the response contains no SQL, table names or stack. Every request has an `x-request-id` (accepted from the caller if well-formed, generated otherwise), which appears in all log lines and in error bodies.

### Money

Prices are `numeric(12,2)` in the database, **decimal strings** in JSON (`"59.90"`), and BigInt cents for arithmetic. Floats are never used for money (`0.1 + 0.2` stays `0.30`).

## Decisions and trade-offs

| Decision | Why | Trade-off |
|---|---|---|
| **Express** (not NestJS) | Small, explicit; routes → service → repository are visible in the code | Validation, DI and docs are assembled by hand (Zod, plain modules, hand-written OpenAPI) |
| **`pg` + SQL migrations** (no ORM) | The correctness guarantees *are* SQL (conditional `UPDATE`, `ON CONFLICT`, `SKIP LOCKED`); an ORM would hide or fight them | More mapping code; no generated types (Kysely would be the next step) |
| **RabbitMQ** | Native ack/nack, per-message TTL queues and dead-letter exchanges give backoff and DLQ without custom scheduling; `prefetch` bounds memory | One more service to run; the broker is not transactional with PostgreSQL (hence the outbox) |
| **Outbox table** | Removes the dual-write problem; the request path has no broker dependency | Polling adds up to `RELAY_POLL_MS` (500 ms) latency; published rows accumulate (see limitations) |
| **Separate worker process** | A slow or broken ads service can never affect request latency; scale API and worker independently | Two entrypoints to run |
| **Version number per product** | Simple, monotonic ordering signal that works across retries and duplicates | Ordering is per product, not global (that is all the ads service needs) |
| **Rate limiter in the consumer process** | Enough for one worker, and simple to reason about | Not shared between several workers (see limitations) |
| **Soft delete, SKU stays reserved** | Keeps movement history and sync references intact; a deleted product is advertised with stock 0 | A deleted SKU cannot be reused |
| **JWT in `sessionStorage`** | Survives a reload without a cookie/CSRF setup | Readable by injected scripts; httpOnly cookies would be stronger |
| **Prices as strings** | Exact decimals end to end | Clients must not parse them as floats |

## API summary

Interactive documentation: **http://localhost:3000/docs**.

| Method | Path | Access |
|---|---|---|
| POST | `/auth/login`, GET `/auth/me` | public / any user |
| GET | `/products?page&limit&q&outOfStock` | admin, operator |
| POST, PATCH, DELETE | `/products`, `/products/:id` | admin |
| POST | `/products/:id/adjust-stock` (signed `delta`, optional `note`) | admin |
| POST | `/sales` (`Idempotency-Key` header) | admin, operator |
| GET | `/stock-movements?productId&page&limit` | admin, operator |
| GET | `/sync/status` | admin, operator |
| POST | `/sync/failed/:id/retry` | admin |
| GET | `/health` | public (counts only: DB, broker, queue depth, last sync) |

## Frontend

Login, product list (loading / empty / error / filtered-empty states, search, stock filter, pagination), sale form, stock history, and a sync status page that polls every 3 s. Notable points:

- The sale form shows the shortage precisely (SKU, requested, available), marks the offending row `aria-invalid`, moves focus to the error alert, and says that nothing was sold. After a **network failure** it tells the user the outcome is unknown and that pressing the button again is safe, because the retry reuses the same `Idempotency-Key` (verified in a browser test).
- Accessibility: labelled controls, skip link, focus moved to the content on navigation, `role="alert"/"status"` messages, semantic tables with captions, visible focus, reduced-motion respected, light and dark themes. All pages pass **axe-core (WCAG 2 A/AA)** with no violations.
- Logging out clears the React Query cache so one user's data is never shown to the next.

## What was verified, and how

- **48 API tests** against a real PostgreSQL, including the four required ones: concurrent sales cannot oversell (`sales.concurrency.test.ts`), tenant isolation (`tenant-isolation.test.ts`), idempotency (`idempotency.test.ts`) and the sync retry behaviour (`sync-retry.test.ts`), plus atomicity, validation, error-leak, relay and rate-limiter tests. The mock service has its own 6 tests.
- **Mutation check:** I replaced the atomic `UPDATE` with a naive read-then-write. The concurrency tests then failed (25 of 25 sales "succeeded" against a stock of 10), so the tests do detect the bug they claim to detect. The code was restored afterwards.
- **Live chaos run** with the real RabbitMQ and the mock: with a 60% failure rate all updates still converged and the database and the mock ended identical (9/9 products). With the mock at 100% failure, a sale answered in 19 ms, the update used all 5 attempts, landed in `sync.dlq` and showed as `FAILED`; after the mock recovered, the admin retry delivered it.
- **Browser end-to-end** (Playwright, 28 checks) against both the dev server and the full Docker stack: login/redirects, filters, error and empty states, insufficient stock, retry with the same idempotency key, tenant separation in the UI, logout, mobile width, axe.

## Known limitations and what I would do with more time

- **Outbox growth:** published `outbox_events` rows are never deleted. Add a periodic cleanup (or partitioning) for rows older than N days.
- **Relay latency and scale:** the relay polls every 500 ms. `LISTEN/NOTIFY` would cut latency; for large volumes, change-data-capture (e.g. Debezium).
- **Rate limit is per process.** With several workers the 5 req/s budget would be exceeded. It needs a shared limiter (e.g. a Redis token bucket) or a single consumer for that queue. The mock still enforces the limit with `429`, which the retry path handles.
- **A 429 counts as a failed attempt.** A smarter client would honour `Retry-After` without consuming an attempt.
- **Batch failure is all-or-nothing.** The mock accepts or rejects a whole batch; a real API with partial results would need per-item outcomes.
- **The DLQ copy stays after a manual retry.** `sync.dlq` is an audit trail; the database row is the source of truth, and the retry re-enqueues through the outbox. A tool to inspect or purge `sync.dlq` is missing.
- **No login rate limiting / lockout, no refresh tokens, no password reset, no user management UI.** A user disabled after a token is issued stays valid until the token expires (stateless JWT).
- **No admin UI for products.** Products are managed through the API (Swagger UI); the frontend covers the flows requested.
- **Row-level security** in PostgreSQL would add a third layer under the application filter and composite foreign keys.
- **Product picker** loads up to 100 products; a search-as-you-type picker would be needed for big catalogues.
- **Observability:** logs are structured with correlation ids and `/health` reports queue depth and last sync, but there are no metrics (Prometheus) or tracing across the API → outbox → worker hop.
- **Frontend tests:** the UI is covered by an end-to-end script run during development, not by a committed test suite.
- **RabbitMQ and PostgreSQL are single instances** with no HA.

## Use of AI tools

I used **Claude Code (Anthropic)** as a pair-programming assistant for: the initial plan and trade-off discussion, scaffolding and boilerplate (configs, Dockerfiles, CI), a first draft of the modules, the tests and the frontend, and this README.

How I validated the output instead of trusting it:

- Read and reasoned about the critical paths (the atomic stock update, the idempotency transaction, the outbox relay, the version rules in the processor, the retry/DLQ topology) and adjusted them, for example the rate limiter capacity and the rule that duplicate versions in one batch must not close their own tracking row.
- Wrote tests that assert behaviour rather than implementation, ran the concurrency and idempotency suites repeatedly to rule out flakiness, and **ran a mutation check** to prove the concurrency test fails on a racy implementation.
- Ran the system for real: the full Docker stack, the real broker, a hostile mock at 60% and 100% failure, and a browser test with an accessibility scanner. That found and fixed a real bug (focus was not moving to the sale error alert because the focus call ran before the alert was rendered).
- Checked the database directly (constraints, composite foreign keys, row counts, mock-versus-database comparison) rather than relying on API responses alone.

## Repository layout

```
apps/
  api/            Express API and worker (one codebase, two entrypoints)
    migrations/   numbered SQL files, applied by src/db/migrate.ts
    src/
      server.ts, worker.ts, app.ts
      config/     env validation (Zod, fails fast)
      db/         pool, withTransaction, migrate, seed
      common/     errors, pg error translation, money, pagination, logger
      middleware/ authenticate, authorize, error-handler
      modules/    auth · products · sales · stock-movements · sync · health  (routes → service → repository)
      messaging/  rabbit topology, outbox-relay, sync-consumer, sync-processor, rate-limiter, retry-policy
      integrations/ads-client.ts
      docs/       OpenAPI description
    tests/
  mock-ads/       the unreliable external service
  web/            React frontend (+ nginx.conf)
docker-compose.yml  ·  .env.example  ·  .github/workflows/ci.yml
```
