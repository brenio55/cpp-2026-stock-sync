import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { request } from './client';
import type { Paged, Product, Sale, SaleItemInput, StockMovement, SyncStatus } from './types';

export interface ProductFilters {
  page: number;
  limit: number;
  q: string;
  stock: 'all' | 'in' | 'out';
}

const qs = (params: Record<string, string | number | boolean | undefined>) => {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') search.set(k, String(v));
  const s = search.toString();
  return s ? `?${s}` : '';
};

export function useProducts(filters: ProductFilters) {
  return useQuery({
    queryKey: ['products', filters],
    queryFn: () =>
      request<Paged<Product>>(
        `/products${qs({
          page: filters.page,
          limit: filters.limit,
          q: filters.q,
          outOfStock: filters.stock === 'all' ? undefined : filters.stock === 'out',
        })}`,
      ),
    placeholderData: keepPreviousData, // keep the old rows on screen while the next page loads
  });
}

export function useCreateSale() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ items, idempotencyKey }: { items: SaleItemInput[]; idempotencyKey: string }) =>
      request<Sale>('/sales', { method: 'POST', body: { items }, headers: { 'Idempotency-Key': idempotencyKey } }),
    // Whatever the outcome, stock may have changed (also on a conflict): refresh the lists.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      void queryClient.invalidateQueries({ queryKey: ['movements'] });
    },
  });
}

export function useMovements(page: number) {
  return useQuery({
    queryKey: ['movements', page],
    queryFn: () => request<Paged<StockMovement>>(`/stock-movements${qs({ page, limit: 20 })}`),
    placeholderData: keepPreviousData,
  });
}

export const SYNC_POLL_MS = 3000;

export function useSyncStatus() {
  return useQuery({
    queryKey: ['sync-status'],
    queryFn: () => request<SyncStatus>('/sync/status'),
    refetchInterval: SYNC_POLL_MS,
  });
}

export function useRetryFailed() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => request<{ status: string }>(`/sync/failed/${id}/retry`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sync-status'] }),
  });
}
