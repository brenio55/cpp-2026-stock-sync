-- Sales, sale items and the stock movement history.
-- Composite foreign keys (x_id, tenant_id) make cross-tenant references impossible at the database level.

CREATE TABLE sales (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  user_id    uuid NOT NULL,
  total      numeric(12,2) NOT NULL CHECK (total >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (user_id, tenant_id) REFERENCES users (id, tenant_id)
);
CREATE INDEX sales_tenant_created_idx ON sales (tenant_id, created_at DESC);

CREATE TABLE sale_items (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL,
  sale_id    uuid NOT NULL,
  product_id uuid NOT NULL,
  quantity   integer NOT NULL CHECK (quantity > 0),
  unit_price numeric(12,2) NOT NULL CHECK (unit_price >= 0), -- price at the moment of the sale
  FOREIGN KEY (sale_id, tenant_id)    REFERENCES sales (id, tenant_id),
  FOREIGN KEY (product_id, tenant_id) REFERENCES products (id, tenant_id),
  -- the same product cannot appear twice in one sale
  UNIQUE (sale_id, product_id)
);

CREATE TABLE stock_movements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  product_id  uuid NOT NULL,
  user_id     uuid NOT NULL, -- who
  delta       integer NOT NULL CHECK (delta <> 0), -- quantity (negative = stock out)
  stock_after integer NOT NULL CHECK (stock_after >= 0),
  reason      text NOT NULL CHECK (reason IN ('SALE', 'ADJUSTMENT', 'CREATE')), -- why
  note        text,
  ref_id      uuid, -- the sale id when reason = 'SALE'
  created_at  timestamptz NOT NULL DEFAULT now(), -- when
  FOREIGN KEY (product_id, tenant_id) REFERENCES products (id, tenant_id),
  FOREIGN KEY (user_id, tenant_id)    REFERENCES users (id, tenant_id)
);
CREATE INDEX stock_movements_product_idx ON stock_movements (tenant_id, product_id, created_at DESC);
CREATE INDEX stock_movements_tenant_idx  ON stock_movements (tenant_id, created_at DESC);
