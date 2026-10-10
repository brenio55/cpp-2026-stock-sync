import type { Request } from 'express';
import type { Pool, PoolClient } from 'pg';
import { unauthorized } from './errors';

export type Role = 'admin' | 'operator';

/** Who is calling. Always derived from the verified JWT, never from request input. */
export interface AuthContext {
  userId: string;
  tenantId: string;
  role: Role;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

/** Anything repositories can run queries on: the pool, or a client inside a transaction. */
export type Queryable = Pick<Pool | PoolClient, 'query'>;

/** Returns the authenticated context; throws 401 if the authenticate middleware did not run. */
export function getAuth(req: Request): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}
