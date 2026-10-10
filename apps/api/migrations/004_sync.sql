-- Transactional outbox and per-update sync tracking.

-- Written in the same transaction as the stock/price change; the worker relays it to RabbitMQ.
CREATE TABLE outbox_events (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid NOT NULL,
  product_id   uuid NOT NULL,
  sku          text NOT NULL,
  stock        integer NOT NULL,
  price        numeric(12,2) NOT NULL,
  version      bigint NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  FOREIGN KEY (product_id, tenant_id) REFERENCES products (id, tenant_id)
);
-- Partial index: the relay only ever scans unpublished rows.
CREATE INDEX outbox_unpublished_idx ON outbox_events (id) WHERE published_at IS NULL;

-- One row per (product, version). Source of truth for GET /sync/status.
CREATE TABLE sync_updates (
  id         bigserial PRIMARY KEY,
  tenant_id  uuid NOT NULL,
  product_id uuid NOT NULL,
  sku        text NOT NULL,
  version    bigint NOT NULL,
  status     text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENT', 'FAILED', 'SUPERSEDED')),
  attempts   integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (product_id, tenant_id) REFERENCES products (id, tenant_id),
  -- makes the relay idempotent: re-publishing the same event cannot create a second row
  UNIQUE (tenant_id, product_id, version)
);
CREATE INDEX sync_updates_tenant_status_idx ON sync_updates (tenant_id, status);

CREATE TABLE sync_state (
  tenant_id       uuid PRIMARY KEY REFERENCES tenants(id),
  last_success_at timestamptz
);
