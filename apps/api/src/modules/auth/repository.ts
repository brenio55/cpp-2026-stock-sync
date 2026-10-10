import type { Queryable, Role } from '../../common/types';

export interface UserWithTenant {
  id: string;
  tenantId: string;
  tenantName: string;
  email: string;
  passwordHash: string;
  role: Role;
}

// Login is the one query that is not tenant-scoped: it is how the tenant is discovered.
export async function findUserByEmail(db: Queryable, email: string): Promise<UserWithTenant | null> {
  const res = await db.query(
    `SELECT u.id, u.tenant_id, t.name AS tenant_name, u.email, u.password_hash, u.role
       FROM users u JOIN tenants t ON t.id = u.tenant_id
      WHERE lower(u.email) = lower($1)`,
    [email],
  );
  const r = res.rows[0];
  if (!r) return null;
  return {
    id: r.id,
    tenantId: r.tenant_id,
    tenantName: r.tenant_name,
    email: r.email,
    passwordHash: r.password_hash,
    role: r.role,
  };
}

export async function findUserById(db: Queryable, tenantId: string, userId: string): Promise<UserWithTenant | null> {
  const res = await db.query(
    `SELECT u.id, u.tenant_id, t.name AS tenant_name, u.email, u.password_hash, u.role
       FROM users u JOIN tenants t ON t.id = u.tenant_id
      WHERE u.tenant_id = $1 AND u.id = $2`,
    [tenantId, userId],
  );
  const r = res.rows[0];
  if (!r) return null;
  return {
    id: r.id,
    tenantId: r.tenant_id,
    tenantName: r.tenant_name,
    email: r.email,
    passwordHash: r.password_hash,
    role: r.role,
  };
}
