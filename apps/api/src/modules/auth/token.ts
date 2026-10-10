import jwt, { type SignOptions } from 'jsonwebtoken';
import { z } from 'zod';
import { env } from '../../config/env';
import type { AuthContext } from '../../common/types';

const payloadSchema = z.object({
  sub: z.string().uuid(),
  tid: z.string().uuid(),
  role: z.enum(['admin', 'operator']),
});

export function signToken(auth: AuthContext): string {
  return jwt.sign({ tid: auth.tenantId, role: auth.role }, env.JWT_SECRET, {
    subject: auth.userId,
    expiresIn: env.JWT_EXPIRES_IN as SignOptions['expiresIn'],
    algorithm: 'HS256',
  });
}

/** Returns the auth context, or null for any invalid, expired or malformed token. */
export function verifyToken(token: string): AuthContext | null {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] });
    const parsed = payloadSchema.safeParse(decoded);
    if (!parsed.success) return null;
    return { userId: parsed.data.sub, tenantId: parsed.data.tid, role: parsed.data.role };
  } catch {
    return null;
  }
}
