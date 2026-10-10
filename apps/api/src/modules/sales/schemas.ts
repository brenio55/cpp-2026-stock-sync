import { z } from 'zod';

export const createSaleSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            productId: z.string().uuid(),
            quantity: z.number().int().min(1).max(100_000),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.items.forEach((item, index) => {
      if (seen.has(item.productId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['items', index, 'productId'],
          message: 'duplicate product in the same sale; merge the quantities into one item',
        });
      }
      seen.add(item.productId);
    });
  });
export type CreateSaleInput = z.infer<typeof createSaleSchema>;

// Visible ASCII, no spaces, up to 255 chars (a UUID is the typical value).
export const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[\x21-\x7E]+$/, 'must contain only visible ASCII characters');
