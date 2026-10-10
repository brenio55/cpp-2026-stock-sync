/** Error returned by the API (or a failure to reach it, status 0). Mirrors the API's public error shape. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
    public readonly correlationId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let token: string | null = null;
let onUnauthorized: (() => void) | null = null;

export const setAuthToken = (t: string | null) => {
  token = t;
};
export const setUnauthorizedHandler = (fn: (() => void) | null) => {
  onUnauthorized = fn;
};

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
}

export async function request<T>(path: string, { method = 'GET', body, headers = {} }: RequestOptions = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: {
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
        ...(token && { Authorization: `Bearer ${token}` }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server. Check your connection and try again.');
  }

  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);

  if (!res.ok) {
    // An expired or invalid session: drop it so the user is sent back to the login page.
    if (res.status === 401 && token) onUnauthorized?.();
    throw new ApiError(
      res.status,
      data?.code ?? 'UNKNOWN_ERROR',
      data?.message ?? 'Something went wrong. Please try again.',
      data?.details,
      data?.correlationId,
    );
  }
  return data as T;
}
