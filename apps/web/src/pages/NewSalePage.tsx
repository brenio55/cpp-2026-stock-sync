import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../api/client';
import { useCreateSale, useProducts } from '../api/hooks';
import type { Product, Sale, SaleItemInput, StockShortage } from '../api/types';
import { ErrorState, Loading } from '../components/StateViews';
import { formatCents, newIdempotencyKey, toCents, usePageTitle } from '../lib';

interface Row {
  id: number;
  productId: string;
  quantity: string;
}

let nextRowId = 1;
const blankRow = (): Row => ({ id: nextRowId++, productId: '', quantity: '1' });

/** The request being (re)tried. Keeping its key while the payload is unchanged is what makes a retry safe. */
interface Attempt {
  payload: string;
  key: string;
}

function isShortage(details: unknown): details is StockShortage {
  return typeof details === 'object' && details !== null && 'sku' in details && 'available' in details;
}

export function NewSalePage() {
  usePageTitle('New sale');
  // All of a tenant's products fit in one page for this small UI; a larger catalogue would need a search-as-you-type picker.
  const products = useProducts({ page: 1, limit: 100, q: '', stock: 'all' });
  const createSale = useCreateSale();

  const [rows, setRows] = useState<Row[]>(() => [blankRow()]);
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({});
  const [receipt, setReceipt] = useState<Sale | null>(null);
  const attempt = useRef<Attempt | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  const byId = useMemo(() => new Map((products.data?.data ?? []).map((p) => [p.id, p])), [products.data]);

  const estimatedCents = rows.reduce((sum, r) => {
    const p = byId.get(r.productId);
    const qty = Number(r.quantity);
    return p && Number.isInteger(qty) && qty > 0 ? sum + toCents(p.price) * qty : sum;
  }, 0);

  const update = (id: number, patch: Partial<Row>) => {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    setRowErrors((e) => ({ ...e, [id]: '' }));
    createSale.reset();
    setReceipt(null);
  };

  function validate(): SaleItemInput[] | null {
    const errors: Record<number, string> = {};
    const seen = new Set<string>();
    for (const r of rows) {
      const qty = Number(r.quantity);
      if (!r.productId) errors[r.id] = 'Choose a product.';
      else if (seen.has(r.productId)) errors[r.id] = 'This product is already in the sale. Increase its quantity instead.';
      else if (!Number.isInteger(qty) || qty < 1) errors[r.id] = 'Enter a whole quantity of 1 or more.';
      seen.add(r.productId);
    }
    setRowErrors(errors);
    const firstInvalid = rows.find((r) => errors[r.id]);
    if (firstInvalid) {
      document.getElementById(`product-${firstInvalid.id}`)?.focus();
      return null;
    }
    return rows.map((r) => ({ productId: r.productId, quantity: Number(r.quantity) }));
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setReceipt(null);
    const items = validate();
    if (!items) return;

    // Same payload as the previous (unfinished) attempt => same Idempotency-Key, so a retry after a dropped
    // connection can never register the sale twice. A changed payload is a new request with a new key.
    const payload = JSON.stringify([...items].sort((a, b) => a.productId.localeCompare(b.productId)));
    if (attempt.current?.payload !== payload) attempt.current = { payload, key: newIdempotencyKey() };

    createSale.mutate(
      { items, idempotencyKey: attempt.current.key },
      {
        onSuccess: (sale) => {
          attempt.current = null;
          setReceipt(sale);
          setRows([blankRow()]);
          setRowErrors({});
        },
        onError: (err) => {
          // A definitive answer from the server (4xx) ends this attempt. A network error or 5xx is "unknown
          // outcome": keep the key so pressing the button again is a safe retry.
          if (err instanceof ApiError && err.status >= 400 && err.status < 500) attempt.current = null;
        },
      },
    );
  }

  const error = createSale.error;
  // Move focus to the error once it is on screen, so keyboard and screen-reader users hear it.
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  const shortage = error instanceof ApiError && error.code === 'INSUFFICIENT_STOCK' && isShortage(error.details) ? error.details : null;
  const shortageRow = shortage ? rows.find((r) => r.productId === shortage.productId) : undefined;

  if (products.isPending) return <Loading label="Loading products…" />;
  if (products.isError) return <ErrorState error={products.error} onRetry={() => void products.refetch()} />;

  const all = products.data.data;
  const usedByOthers = (rowId: number) => new Set(rows.filter((r) => r.id !== rowId).map((r) => r.productId));

  return (
    <>
      <h1>Register a sale</h1>

      {receipt && (
        <div className="notice success" role="status">
          <p className="state-title">Sale registered</p>
          <p>
            {receipt.items.length} {receipt.items.length === 1 ? 'item' : 'items'} · total <strong>{receipt.total}</strong>
          </p>
          <ul>
            {receipt.items.map((i) => (
              <li key={i.productId}>
                {i.quantity} × <code>{i.sku}</code> at {i.unitPrice}
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && (
        <div className="notice error" role="alert" tabIndex={-1} ref={errorRef}>
          {shortage ? (
            <>
              <p className="state-title">Not enough stock</p>
              <p>
                <code>{shortage.sku}</code>: you asked for {shortage.requested}, but only {shortage.available} {shortage.available === 1 ? 'is' : 'are'} available.
                Nothing was sold. Lower the quantity or remove the item and try again.
              </p>
            </>
          ) : error instanceof ApiError && error.status === 0 ? (
            <>
              <p className="state-title">We could not confirm the sale</p>
              <p>
                {error.message} The sale may or may not have been registered. It is safe to press “Register sale” again:
                the same request will not be counted twice.
              </p>
            </>
          ) : (
            <>
              <p className="state-title">The sale was not registered</p>
              <p>{error instanceof ApiError ? error.message : 'Something went wrong. Please try again.'}</p>
              {error instanceof ApiError && error.correlationId && <p className="muted small">Reference: {error.correlationId}</p>}
            </>
          )}
        </div>
      )}

      <form onSubmit={onSubmit} noValidate>
        <ol className="sale-rows">
          {rows.map((row, index) => {
            const product: Product | undefined = byId.get(row.productId);
            const message = rowErrors[row.id] || (shortageRow?.id === row.id ? `Only ${shortage?.available} in stock.` : '');
            const taken = usedByOthers(row.id);
            return (
              <li key={row.id} className="sale-row">
                <div className="field grow">
                  <label htmlFor={`product-${row.id}`}>Product {rows.length > 1 && `(item ${index + 1})`}</label>
                  <select
                    id={`product-${row.id}`}
                    value={row.productId}
                    aria-invalid={message ? true : undefined}
                    aria-describedby={`hint-${row.id}`}
                    onChange={(e) => update(row.id, { productId: e.target.value })}
                  >
                    <option value="">Select a product…</option>
                    {all.map((p) => (
                      <option key={p.id} value={p.id} disabled={taken.has(p.id)}>
                        {p.sku} · {p.name}
                        {p.stock === 0 ? ' (out of stock)' : ` (${p.stock} in stock)`}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field qty">
                  <label htmlFor={`qty-${row.id}`}>Quantity</label>
                  <input
                    id={`qty-${row.id}`}
                    type="number"
                    min={1}
                    step={1}
                    inputMode="numeric"
                    value={row.quantity}
                    aria-invalid={message ? true : undefined}
                    aria-describedby={`hint-${row.id}`}
                    onChange={(e) => update(row.id, { quantity: e.target.value })}
                  />
                </div>
                {rows.length > 1 && (
                  <button type="button" className="secondary" onClick={() => setRows((rs) => rs.filter((r) => r.id !== row.id))}>
                    Remove<span className="sr-only"> item {index + 1}</span>
                  </button>
                )}
                <p id={`hint-${row.id}`} className={message ? 'row-hint invalid' : 'row-hint muted small'}>
                  {message || (product ? `Price ${product.price} · ${product.stock} in stock` : '')}
                </p>
              </li>
            );
          })}
        </ol>

        <div className="actions">
          <button type="button" className="secondary" onClick={() => setRows((rs) => [...rs, blankRow()])}>
            Add another item
          </button>
          <p className="total" aria-live="polite">
            Estimated total: <strong>{formatCents(estimatedCents)}</strong>
          </p>
          <button type="submit" disabled={createSale.isPending}>
            {createSale.isPending ? 'Registering…' : 'Register sale'}
          </button>
        </div>
      </form>
    </>
  );
}
