-- Idempotency keys for POST /sales.
-- The row is inserted inside the sale transaction, so a concurrent duplicate blocks on the primary key
-- until the first request commits, then replays the stored response.

CREATE TABLE idempotency_keys (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  key             text NOT NULL,
  request_hash    text NOT NULL, -- sha256 of the request body, detects key reuse with a different payload
  response_status integer NOT NULL,
  response_body   jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);
