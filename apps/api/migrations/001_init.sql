-- Tenants, users and products.
-- gen_random_uuid() is built into PostgreSQL 13+, no extension needed.

CREATE TABLE tenants (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  email         text NOT NULL,
  password_hash text NOT NULL,
  role          text NOT NULL CHECK (role IN ('admin', 'operator')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- lets child tables reference (id, tenant_id) so a row can never point at another tenant's user
  UNIQUE (id, tenant_id)
);
-- Login is by email alone, so emails are unique across all tenants (case-insensitive).
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));

CREATE TABLE products (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  sku        text NOT NULL,
  name       text NOT NULL,
  price      numeric(12,2) NOT NULL CHECK (price >= 0),
  stock      integer NOT NULL DEFAULT 0 CHECK (stock >= 0),
  -- bumped on every price/stock change; used to discard stale or duplicate sync updates
  version    bigint NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- SKU is unique per tenant. A soft-deleted product keeps its SKU reserved.
  UNIQUE (tenant_id, sku),
  UNIQUE (id, tenant_id)
);
CREATE INDEX products_tenant_name_idx ON products (tenant_id, name);
