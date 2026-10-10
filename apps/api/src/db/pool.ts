import { Pool, types } from 'pg';
import { env } from '../config/env';

// bigint (int8) columns such as products.version are returned as strings by default.
// Versions stay far below 2^53, so parsing them to numbers is safe and keeps comparisons simple.
types.setTypeParser(types.builtins.INT8, (value) => Number(value));

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.DB_POOL_MAX,
});

// An idle client erroring (e.g. the server restarted) must not crash the process.
pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client', err.message);
});
