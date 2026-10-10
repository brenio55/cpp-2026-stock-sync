import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../common/errors';
import { translatePgError } from '../common/pg-errors';

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new AppError(404, 'ROUTE_NOT_FOUND', 'Route not found'));
};

function toAppError(err: unknown): AppError | null {
  if (err instanceof AppError) return err;
  if (err instanceof ZodError) {
    const details = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    return new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', details);
  }
  // body-parser errors carry a `type`
  const type = (err as { type?: string } | null)?.type;
  if (type === 'entity.parse.failed') return new AppError(400, 'INVALID_JSON', 'Request body is not valid JSON');
  if (type === 'entity.too.large') return new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
  return translatePgError(err);
}

/**
 * Single place that turns any error into the public error shape:
 * { statusCode, code, message, details?, correlationId }
 * Unknown errors are logged with full detail server-side and answered with a generic 500,
 * so stack traces and SQL never reach the client.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const correlationId = String(req.id);
  const known = toAppError(err);

  if (!known) {
    req.log.error({ err }, 'unhandled error');
  }
  const appError = known ?? new AppError(500, 'INTERNAL_ERROR', 'Internal server error');

  res.status(appError.statusCode).json({
    statusCode: appError.statusCode,
    code: appError.code,
    message: appError.message,
    ...(appError.details !== undefined && { details: appError.details }),
    correlationId,
  });
};
