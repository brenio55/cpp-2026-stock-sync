import { z } from 'zod';
import { moneySchema } from '../../common/money';
import { paginationSchema } from '../../common/pagination';

export const idParamSchema = z.string().uuid();

const sku = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/, 'may only contain letters, digits, dot, underscore and hyphen');
const name = z.string().trim().min(1).max(200);

export const createProductSchema = z
  .object({
    sku,
    name,
    price: moneySchema,
    stock: z.number().int().min(0).max(1_000_000_000).default(0),
  })
  .strict();
export type CreateProductInput = z.infer<typeof createProductSchema>;

// sku is immutable (it is the external key) and stock only changes through sales or adjustments.
export const updateProductSchema = z
  .object({ name: name.optional(), price: moneySchema.optional() })
  .strict()
  .refine((v) => v.name !== undefined || v.price !== undefined, { message: 'Provide at least one of: name, price' });
export type UpdateProductInput = z.infer<typeof updateProductSchema>;

export const listProductsSchema = paginationSchema.extend({
  q: z.string().trim().max(100).optional(),
  outOfStock: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});
export type ListProductsInput = z.infer<typeof listProductsSchema>;

export const adjustStockSchema = z
  .object({
    delta: z
      .number()
      .int()
      .min(-1_000_000_000)
      .max(1_000_000_000)
      .refine((n) => n !== 0, 'must not be zero'),
    note: z.string().trim().max(200).optional(),
  })
  .strict();
export type AdjustStockInput = z.infer<typeof adjustStockSchema>;
