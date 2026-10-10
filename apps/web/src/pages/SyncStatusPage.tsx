import { SYNC_POLL_MS, useRetryFailed, useSyncStatus } from '../api/hooks';
import { useAuth } from '../auth/AuthContext';
import { ErrorState, Loading } from '../components/StateViews';
import { formatDateTime, timeAgo, usePageTitle } from '../lib';

const COUNTERS = [
  ['pending', 'Pending', 'Waiting to be sent or being retried'],
  ['sent', 'Sent', 'Delivered to the ads service'],
  ['failed', 'Failed', 'Gave up after the maximum attempts'],
  ['superseded', 'Superseded', 'Replaced by a newer update, never needed'],
] as const;

export function SyncStatusPage() {
  usePageTitle('Sync status');
  const { user } = useAuth();
  const status = useSyncStatus();
  const retry = useRetryFailed();

  return (
    <>
      <h1>Sync status</h1>
      <p className="muted">
        Product changes are sent to the advertising service in the background. This page refreshes every {SYNC_POLL_MS / 1000} seconds.
      </p>

      {status.isPending ? (
        <Loading label="Loading sync status…" />
      ) : status.isError && !status.data ? (
        <ErrorState error={status.error} onRetry={() => void status.refetch()} />
      ) : (
        <>
          {status.isError && (
            <p className="notice error" role="alert">
              Could not refresh. Showing the last known values.
            </p>
          )}

          <dl className="counters">
            {COUNTERS.map(([key, label, help]) => (
              <div key={key} className={`counter ${key}${key === 'failed' && status.data.counts.failed > 0 ? ' alert' : ''}`}>
                <dt>{label}</dt>
                <dd>{status.data.counts[key]}</dd>
                <dd className="muted small">{help}</dd>
              </div>
            ))}
          </dl>

          <p>
            Last successful sync:{' '}
            {status.data.lastSuccessAt ? (
              <strong title={formatDateTime(status.data.lastSuccessAt)}>{timeAgo(status.data.lastSuccessAt)}</strong>
            ) : (
              <strong>never</strong>
            )}
            {status.data.lastSuccessAt && <span className="muted"> ({formatDateTime(status.data.lastSuccessAt)})</span>}
          </p>

          <h2>Failed updates</h2>
          {status.data.recentFailures.length === 0 ? (
            <p className="muted">No failed updates. Everything that could be delivered was delivered.</p>
          ) : (
            <>
              {retry.isError && (
                <p className="notice error" role="alert">
                  {retry.error.message}
                </p>
              )}
              <div className="table-wrap">
                <table>
                  <caption className="sr-only">Updates that exhausted their retries</caption>
                  <thead>
                    <tr>
                      <th scope="col">SKU</th>
                      <th scope="col" className="num">
                        Version
                      </th>
                      <th scope="col" className="num">
                        Attempts
                      </th>
                      <th scope="col">Last error</th>
                      <th scope="col">When</th>
                      {user?.role === 'admin' && <th scope="col">Action</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {status.data.recentFailures.map((f) => (
                      <tr key={f.id}>
                        <td>
                          <code>{f.sku}</code>
                        </td>
                        <td className="num">{f.version}</td>
                        <td className="num">{f.attempts}</td>
                        <td>{f.lastError ?? '—'}</td>
                        <td>{timeAgo(f.updatedAt)}</td>
                        {user?.role === 'admin' && (
                          <td>
                            <button type="button" disabled={retry.isPending} onClick={() => retry.mutate(f.id)}>
                              Retry<span className="sr-only"> {f.sku}</span>
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}
