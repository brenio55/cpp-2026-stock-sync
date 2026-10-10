export type FailureAction = { type: 'retry'; delayMs: number } | { type: 'dead' };

/**
 * Decides what happens after a failed delivery.
 * @param failedAttempts how many attempts have failed so far, including the one that just failed (>= 1)
 * @param maxAttempts    total attempts allowed before the update is dead-lettered
 * @param delaysMs       backoff schedule; attempt N waits delaysMs[N-1], the last delay repeats
 */
export function nextAction(failedAttempts: number, maxAttempts: number, delaysMs: number[]): FailureAction {
  if (failedAttempts >= maxAttempts) return { type: 'dead' };
  const delayMs = delaysMs[Math.min(failedAttempts - 1, delaysMs.length - 1)]!;
  return { type: 'retry', delayMs };
}
