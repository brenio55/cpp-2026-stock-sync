import { Client } from 'pg';
import { testDatabaseUrl } from './helpers/test-db-url';

/** Creates a clean test database with the real migrations applied, once per test run. */
export default async function setup(): Promise<void> {
  const target = new URL(testDatabaseUrl());
  const dbName = target.pathname.slice(1);
  if (!dbName.endsWith('_test')) {
    throw new Error(`Refusing to run tests against "${dbName}": the test database name must end with _test`);
  }

  const admin = new Client({ connectionString: Object.assign(new URL(target), { pathname: '/postgres' }).toString() });
  await admin.connect();
  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (exists.rowCount === 0) await admin.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }

  const db = new Client({ connectionString: target.toString() });
  await db.connect();
  try {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  } finally {
    await db.end();
  }

  // env.ts reads process.env at import time, so point it at the test database before loading the runner.
  process.env.DATABASE_URL = target.toString();
  process.env.JWT_SECRET ??= 'test-secret-test-secret-test-secret-0123456789';
  process.env.RABBITMQ_URL ??= 'amqp://localhost';
  const { migrate } = await import('../src/db/migrate');
  const { pool } = await import('../src/db/pool');
  await migrate();
  await pool.end();
}
