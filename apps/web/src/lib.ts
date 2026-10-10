import { useEffect, useState } from 'react';

export function usePageTitle(title: string) {
  useEffect(() => {
    document.title = `${title} · StockSync`;
  }, [title]);
}

/** Returns `value` after it has stopped changing for `delayMs` (used so typing in a search box does not fire a request per key). */
export function useDebounced<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

/** crypto.randomUUID only exists in secure contexts (https / localhost), so keep a fallback for plain-http hosts. */
export function newIdempotencyKey(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Money is a decimal string from the API; sum in integer cents so the on-screen total never shows float noise. */
export function toCents(amount: string): number {
  const [whole = '0', frac = ''] = amount.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0').slice(0, 2));
}

export function formatCents(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function timeAgo(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}
