import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });

const DEFAULT_URL = 'postgres://stocksync:stocksync@localhost:5433/stocksync';

/** Tests run against their own database so they can truncate freely and never touch development data. */
export function testDatabaseUrl(): string {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  const url = new URL(process.env.DATABASE_URL ?? DEFAULT_URL);
  url.pathname = '/stocksync_test';
  return url.toString();
}
