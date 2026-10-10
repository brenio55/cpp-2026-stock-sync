import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db/pool';
import { signToken } from '../../src/modules/auth/token';

export const app = createApp();
export const api = () => request(app);

// bcrypt cost 4 keeps user creation fast; production seeding uses a higher cost.
const HASH = bcrypt.hashSync('password123', 4);

export async function resetDb(): Promise<void> {
  await pool.query('TRUNCATE tenants RESTART IDENTITY CASCADE');
}

export interface TestUser {
  id: string;
  email: string;
  token: string;
}

export interface TestTenant {
  id: string;
  name: string;
  admin: TestUser;
  operator: TestUser;
}

export async function createTenant(name = `tenant-${randomUUID().slice(0, 8)}`): Promise<TestTenant> {
  const t = await pool.query('INSERT INTO tenants (name) VALUES ($1) RETURNING id', [name]);
  const tenantId: string = t.rows[0].id;

  const makeUser = async (role: 'admin' | 'operator'): Promise<TestUser> => {
    const email = `${role}-${randomUUID().slice(0, 8)}@${name}.test`;
    const u = await pool.query(
      'INSERT INTO users (tenant_id, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id',
      [tenantId, email, HASH, role],
    );
    const id: string = u.rows[0].id;
    return { id, email, token: signToken({ userId: id, tenantId, role }) };
  };

  return { id: tenantId, name, admin: await makeUser('admin'), operator: await makeUser('operator') };
}

export interface TestProduct {
  id: string;
  sku: string;
}

/** Inserts straight into the database (no outbox event), for arranging test state. */
export async function createProduct(
  tenantId: string,
  p: { sku?: string; stock?: number; price?: string; name?: string } = {},
): Promise<TestProduct> {
  const sku = p.sku ?? `SKU-${randomUUID().slice(0, 8)}`;
  const res = await pool.query(
    'INSERT INTO products (tenant_id, sku, name, price, stock) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [tenantId, sku, p.name ?? `Product ${sku}`, p.price ?? '10.00', p.stock ?? 0],
  );
  return { id: res.rows[0].id, sku };
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

export async function stockOf(productId: string): Promise<number> {
  const res = await pool.query('SELECT stock FROM products WHERE id = $1', [productId]);
  return res.rows[0].stock;
}

export async function countRows(table: string, where = 'true', params: unknown[] = []): Promise<number> {
  const res = await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params);
  return res.rows[0].n;
}
