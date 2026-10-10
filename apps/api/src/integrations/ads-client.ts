export interface AdsItem {
  sku: string;
  stock: number;
  price: string;
  /** monotonically increasing per product; the ads service ignores anything not newer than what it has */
  version: number;
}

/** Sends one batch of product updates for ONE tenant. Throws on any failure (error status, timeout, network). */
export interface AdsClient {
  sendBatch(tenantId: string, items: AdsItem[]): Promise<void>;
}

export class AdsError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'AdsError';
  }
}

export class HttpAdsClient implements AdsClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
  ) {}

  async sendBatch(tenantId: string, items: AdsItem[]): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/products/batch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-tenant-id': tenantId },
        body: JSON.stringify({ items }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const e = err as Error & { cause?: { code?: string } };
      throw new AdsError(e.name === 'TimeoutError' ? `timeout after ${this.timeoutMs}ms` : `network error: ${e.cause?.code ?? e.message}`);
    }
    // Drain the body so the connection can be reused.
    await res.arrayBuffer().catch(() => undefined);
    if (!res.ok) throw new AdsError(`ads service responded with HTTP ${res.status}`, res.status);
  }
}
