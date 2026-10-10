import type { RequestHandler } from 'express';
import { forbidden } from '../common/errors';
import type { Role } from '../common/types';

/** Allows the request only when the authenticated user has one of the given roles. Run after `authenticate`. */
export const requireRole =
  (...roles: Role[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.auth || !roles.includes(req.auth.role)) {
      return next(forbidden());
    }
    next();
  };
