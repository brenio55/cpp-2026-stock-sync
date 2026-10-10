import { useState } from 'react';
import { useMovements } from '../api/hooks';
import { EmptyState, ErrorState, Loading, Pagination } from '../components/StateViews';
import { formatDateTime, usePageTitle } from '../lib';

const REASONS = { SALE: 'Sale', ADJUSTMENT: 'Adjustment', CREATE: 'Product created' } as const;

export function MovementsPage() {
  usePageTitle('Stock history');
  const [page, setPage] = useState(1);
  const movements = useMovements(page);

  return (
    <>
      <h1>Stock history</h1>
      <p className="muted">Every change to stock: who made it, when, why, and by how much.</p>

      {movements.isPending ? (
        <Loading label="Loading history…" />
      ) : movements.isError ? (
        <ErrorState error={movements.error} onRetry={() => void movements.refetch()} />
      ) : movements.data.data.length === 0 ? (
        <EmptyState title="No stock movements yet">Movements appear when products are created, adjusted or sold.</EmptyState>
      ) : (
        <>
          <div className="table-wrap" aria-busy={movements.isFetching}>
            <table>
              <caption className="sr-only">Stock movements, newest first</caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">SKU</th>
                  <th scope="col" className="num">
                    Change
                  </th>
                  <th scope="col" className="num">
                    Stock after
                  </th>
                  <th scope="col">Reason</th>
                  <th scope="col">By</th>
                  <th scope="col">Note</th>
                </tr>
              </thead>
              <tbody>
                {movements.data.data.map((m) => (
                  <tr key={m.id}>
                    <td>{formatDateTime(m.createdAt)}</td>
                    <td>
                      <code>{m.sku}</code>
                    </td>
                    <td className={`num ${m.delta < 0 ? 'neg' : 'pos'}`}>{m.delta > 0 ? `+${m.delta}` : m.delta}</td>
                    <td className="num">{m.stockAfter}</td>
                    <td>{REASONS[m.reason]}</td>
                    <td>{m.userEmail}</td>
                    <td>{m.note ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={movements.data.meta.page}
            totalPages={movements.data.meta.totalPages}
            total={movements.data.meta.total}
            noun="movements"
            onPage={setPage}
          />
        </>
      )}
    </>
  );
}
