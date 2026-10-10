import { createMockApp, defaultOptions } from './app';

const num = (name: string, fallback: number) => {
  const raw = process.env[name];
  const n = raw === undefined ? fallback : Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

const app = createMockApp({
  rateLimitPerSecond: num('MOCK_RATE_LIMIT', defaultOptions.rateLimitPerSecond),
  failureRate: num('MOCK_FAILURE_RATE', defaultOptions.failureRate),
  duplicateRate: num('MOCK_DUPLICATE_RATE', defaultOptions.duplicateRate),
  hangMs: num('MOCK_HANG_MS', defaultOptions.hangMs),
});

const port = num('PORT', 4000);
const server = app.listen(port, () => console.log(`mock-ads listening on :${port}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
