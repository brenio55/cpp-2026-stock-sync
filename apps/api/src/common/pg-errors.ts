import { AppError } from './errors';

interface PgLikeError {
  code?: string;
  constraint?: string;
}

/**
 * Translates PostgreSQL error codes into safe client errors.
 * Only the code and constraint name are inspected; the driver's message/detail (which can contain SQL
 * fragments and row values) is never forwarded to the client.
 */
export function translatePgError(err: unknown): AppError | null {
  if (typeof err !== 'object' || err === null) return null;
  const { code, constraint } = err as PgLikeError;
  switch (code) {
    case '23505': // unique_violation
      if (constraint === 'products_tenant_id_sku_key') {
        return new AppError(409, 'SKU_ALREADY_EXISTS', 'A product with this SKU already exists');
      }
      return new AppError(409, 'DUPLICATE_RESOURCE', 'The resource already exists');
    case '23514': // check_violation (e.g. stock >= 0)
      return new AppError(422, 'CONSTRAINT_VIOLATION', 'The operation violates a data constraint');
    case '23503': // foreign_key_violation
      return new AppError(409, 'INVALID_REFERENCE', 'The operation references a resource that does not exist');
    case '22003': // numeric_value_out_of_range
      return new AppError(422, 'VALUE_OUT_OF_RANGE', 'A numeric value is out of range');
    case '22P02': // invalid_text_representation (e.g. malformed uuid)
      return new AppError(400, 'INVALID_INPUT', 'A value has an invalid format');
    default:
      return null;
  }
}
