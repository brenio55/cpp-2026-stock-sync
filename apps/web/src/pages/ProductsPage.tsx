import { useState } from 'react';
import { useProducts, type ProductFilters } from '../api/hooks';
import { EmptyState, ErrorState, Loading, Pagination } from '../components/StateViews';
import { useDebounced, usePageTitle } from '../lib';

const PAGE_SIZE = 10;

export function ProductsPage() {
  usePageTitle('Products');
  const [search, setSearch] = useState('');
  const [stock, setStock] = useState<ProductFilters['stock']>('all');
  const [page, setPage] = useState(1);
  const q = useDebounced(search.trim());

  const products = useProducts({ page, limit: PAGE_SIZE, q, stock });
  const filtered = q !== '' || stock !== 'all';

  return (
    <>
      <h1>Products</h1>

      <form className="filters" role="search" onSubmit={(e) => e.preventDefault()}>
        <div className="field">
          <label htmlFor="search">Search by name or SKU</label>
          <input
            id="search"
            type="search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <div className="field">
          <label htmlFor="stock">Stock</label>
          <select
            id="stock"
            value={stock}
            onChange={(e) => {
              setStock(e.target.value as ProductFilters['stock']);
              setPage(1);
            }}
          >
            <option value="all">All products</option>
            <option value="in">In stock</option>
            <option value="out">Out of stock</option>
          </select>
        </div>
      </form>

      {products.isPending ? (
        <Loading label="Loading products…" />
      ) : products.isError ? (
        <ErrorState error={products.error} onRetry={() => void products.refetch()} />
      ) : products.data.data.length === 0 ? (
        filtered ? (
          <EmptyState title="No products match your filters">Try a different search or show all products.</EmptyState>
        ) : (
          <EmptyState title="No products yet">An administrator can add products through the API.</EmptyState>
        )
      ) : (
        <>
          <div className="table-wrap" aria-busy={products.isFetching}>
            <table>
              <caption className="sr-only">Products with price and stock</caption>
              <thead>
                <tr>
                  <th scope="col">SKU</th>
                  <th scope="col">Name</th>
                  <th scope="col" className="num">
                    Price
                  </th>
                  <th scope="col" className="num">
                    Stock
                  </th>
                </tr>
              </thead>
              <tbody>
                {products.data.data.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <code>{p.sku}</code>
                    </td>
                    <td>{p.name}</td>
                    <td className="num">{p.price}</td>
                    <td className="num">
                      {p.stock === 0 ? <span className="pill out">Out of stock</span> : p.stock}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={products.data.meta.page}
            totalPages={products.data.meta.totalPages}
            total={products.data.meta.total}
            noun="products"
            onPage={setPage}
          />
        </>
      )}
    </>
  );
}
