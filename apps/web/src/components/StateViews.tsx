import type { ReactNode } from 'react';
import { ApiError } from '../api/client';

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <p className="state" role="status" aria-busy="true">
      <span className="spinner" aria-hidden="true" /> {label}
    </p>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="state empty">
      <p className="state-title">{title}</p>
      {children && <p>{children}</p>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof ApiError ? error.message : 'Something went wrong. Please try again.';
  const reference = error instanceof ApiError ? error.correlationId : undefined;
  return (
    <div className="state error" role="alert">
      <p className="state-title">Could not load the data</p>
      <p>{message}</p>
      {reference && <p className="muted small">Reference: {reference}</p>}
      {onRetry && (
        <button type="button" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Pagination({
  page,
  totalPages,
  total,
  noun,
  onPage,
}: {
  page: number;
  totalPages: number;
  total: number;
  noun: string;
  onPage: (page: number) => void;
}) {
  return (
    <nav className="pagination" aria-label={`${noun} pagination`}>
      <button type="button" onClick={() => onPage(page - 1)} disabled={page <= 1}>
        Previous
      </button>
      <span aria-live="polite">
        Page {page} of {Math.max(totalPages, 1)} · {total} {noun}
      </span>
      <button type="button" onClick={() => onPage(page + 1)} disabled={page >= totalPages}>
        Next
      </button>
    </nav>
  );
}
