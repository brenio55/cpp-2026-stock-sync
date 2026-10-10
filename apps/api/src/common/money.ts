import { z } from 'zod';

/**
 * Money is a decimal string ("59.90") end to end, never a float:
 * PostgreSQL numeric(12,2) <-> JSON string <-> BigInt cents for arithmetic.
 * Input accepts a string or a number with at most two decimals.
 */
export const moneySchema = z
  .union([
    z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, 'must be a non-negative amount with at most 2 decimals'),
    z
      .number()
      .nonnegative()
      .max(9_999_999_999.99)
      .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, 'must have at most 2 decimals'),
  ])
  .transform((v) => Number(v).toFixed(2));

export function toCents(amount: string): bigint {
  const [whole = '0', frac = ''] = amount.split('.');
  return BigInt(whole) * 100n + BigInt(frac.padEnd(2, '0').slice(0, 2));
}

export function fromCents(cents: bigint): string {
  const whole = cents / 100n;
  const frac = (cents % 100n).toString().padStart(2, '0');
  return `${whole}.${frac}`;
}
