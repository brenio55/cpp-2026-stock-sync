import type { RequestHandler } from 'express';
import { verifyToken } from '../modules/auth/token';
import { unauthorized } from '../common/errors';

/** Verifies the Bearer JWT and attaches `req.auth`. The tenant comes from the token and nowhere else. */
export const authenticate: RequestHandler = (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return next(unauthorized());
  }
  const auth = verifyToken(header.slice('Bearer '.length).trim());
  if (!auth) {
    return next(unauthorized('Invalid or expired token', 'INVALID_TOKEN'));
  }
  req.auth = auth;
  next();
};
