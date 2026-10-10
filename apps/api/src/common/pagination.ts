import { z } from 'zod';

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export interface PageMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export function pageMeta(page: number, limit: number, total: number): PageMeta {
  return { page, limit, total, totalPages: Math.ceil(total / limit) };
}
