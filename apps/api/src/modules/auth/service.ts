import bcrypt from 'bcryptjs';
import { pool } from '../../db/pool';
import { unauthorized, notFound } from '../../common/errors';
import type { AuthContext } from '../../common/types';
import { findUserByEmail, findUserById, type UserWithTenant } from './repository';
import { signToken } from './token';
import type { LoginInput } from './schemas';

// Compared against when the email is unknown, so response time does not reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

export interface PublicUser {
  id: string;
  email: string;
  role: UserWithTenant['role'];
  tenant: { id: string; name: string };
}

const toPublicUser = (u: UserWithTenant): PublicUser => ({
  id: u.id,
  email: u.email,
  role: u.role,
  tenant: { id: u.tenantId, name: u.tenantName },
});

export async function login(input: LoginInput): Promise<{ token: string; user: PublicUser }> {
  const user = await findUserByEmail(pool, input.email);
  const ok = await bcrypt.compare(input.password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok) {
    // Same message for unknown email and wrong password.
    throw unauthorized('Invalid email or password', 'INVALID_CREDENTIALS');
  }
  const token = signToken({ userId: user.id, tenantId: user.tenantId, role: user.role });
  return { token, user: toPublicUser(user) };
}

export async function me(auth: AuthContext): Promise<PublicUser> {
  const user = await findUserById(pool, auth.tenantId, auth.userId);
  if (!user) throw notFound('User');
  return toPublicUser(user);
}
