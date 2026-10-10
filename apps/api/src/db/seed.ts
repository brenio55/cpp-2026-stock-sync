import bcrypt from 'bcryptjs';
import type { PoolClient } from 'pg';
import { pool } from './pool';
import { withTransaction } from './transaction';

// Development-only credentials, documented in the README so reviewers can test tenant isolation.
export const SEED_PASSWORD = 'password123';

interface SeedProduct {
  sku: string;
  name: string;
  price: string;
  stock: number;
}

interface SeedTenant {
  name: string;
  users: { email: string; role: 'admin' | 'operator' }[];
  products: SeedProduct[];
}

const TENANTS: SeedTenant[] = [
  {
    name: 'Acme Store',
    users: [
      { email: 'admin@acme.test', role: 'admin' },
      { email: 'operator@acme.test', role: 'operator' },
    ],
    products: [
      { sku: 'SHIRT-POLO-BLUE-M', name: 'Polo Shirt Blue M', price: '59.90', stock: 25 },
      { sku: 'SHIRT-POLO-BLUE-L', name: 'Polo Shirt Blue L', price: '59.90', stock: 10 },
      { sku: 'MUG-CERAMIC-WHT', name: 'Ceramic Mug White', price: '19.50', stock: 100 },
      { sku: 'CAP-TRUCKER-BLK', name: 'Trucker Cap Black', price: '34.00', stock: 0 }, // out of stock
      { sku: 'ABC-001', name: 'Acme Widget', price: '9.99', stock: 5 },
    ],
  },
  {
    name: 'Globex Retail',
    users: [
      { email: 'admin@globex.test', role: 'admin' },
      { email: 'operator@globex.test', role: 'operator' },
    ],
    products: [
      { sku: 'ABC-001', name: 'Globex Gadget', price: '149.00', stock: 8 }, // same SKU as Acme: unique per tenant, not global
      { sku: 'LAMP-DESK-LED', name: 'Desk Lamp LED', price: '89.90', stock: 40 },
      { sku: 'CHAIR-ERGO-GRY', name: 'Ergonomic Chair Grey', price: '699.00', stock: 3 },
      { sku: 'CABLE-USBC-2M', name: 'USB-C Cable 2m', price: '24.90', stock: 0 }, // out of stock
    ],
  },
];

async function seedTenant(client: PoolClient, tenant: SeedTenant, passwordHash: string): Promise<boolean> {
  const inserted = await client.query<{ id: string }>(
    'INSERT INTO tenants (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING id',
    [tenant.name],
  );
  const tenantId = inserted.rows[0]?.id;
  if (!tenantId) return false; // already seeded

  let adminId = '';
  for (const user of tenant.users) {
    const res = await client.query<{ id: string }>(
      'INSERT INTO users (tenant_id, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id',
      [tenantId, user.email, passwordHash, user.role],
    );
    if (user.role === 'admin') adminId = res.rows[0]!.id;
  }

  for (const p of tenant.products) {
    const res = await client.query<{ id: string }>(
      'INSERT INTO products (tenant_id, sku, name, price, stock) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [tenantId, p.sku, p.name, p.price, p.stock],
    );
    const productId = res.rows[0]!.id;
    // Same bookkeeping the products service will do: a CREATE movement plus an outbox event for the sync.
    if (p.stock > 0) {
      await client.query(
        `INSERT INTO stock_movements (tenant_id, product_id, user_id, delta, stock_after, reason)
         VALUES ($1, $2, $3, $4, $4, 'CREATE')`,
        [tenantId, productId, adminId, p.stock],
      );
    }
    await client.query(
      `INSERT INTO outbox_events (tenant_id, product_id, sku, stock, price, version)
       VALUES ($1, $2, $3, $4, $5, 1)`,
      [tenantId, productId, p.sku, p.stock, p.price],
    );
  }
  return true;
}

export async function seed(): Promise<void> {
  const passwordHash = await bcrypt.hash(SEED_PASSWORD, 10);
  for (const tenant of TENANTS) {
    const created = await withTransaction((client) => seedTenant(client, tenant, passwordHash));
    console.log(created ? `Seeded tenant "${tenant.name}"` : `Tenant "${tenant.name}" already exists, skipped`);
  }
}

if (require.main === module) {
  seed()
    .then(() => {
      console.log(`\nLogin with any seeded user, password: ${SEED_PASSWORD}`);
      for (const t of TENANTS) for (const u of t.users) console.log(`  ${u.email} (${u.role}, ${t.name})`);
    })
    .catch((err) => {
      console.error('Seed failed:', err.message);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
