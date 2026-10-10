import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

// Load the repo-root .env when present. In Docker the variables come from the environment instead.
dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().url(),
  DB_POOL_MAX: z.coerce.number().int().positive().default(20),
  RABBITMQ_URL: z.string().min(1),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('1h'),

  ADS_API_URL: z.string().url().default('http://localhost:4000'),
  ADS_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
  SYNC_BATCH_SIZE: z.coerce.number().int().positive().default(50),
  SYNC_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  SYNC_RATE_LIMIT_RPS: z.coerce.number().positive().default(5),
  // Backoff schedule: the Nth failed attempt waits delays[min(N-1, last)] ms in a TTL retry queue.
  SYNC_RETRY_DELAYS_MS: z
    .string()
    .default('5000,30000,120000')
    .transform((s) => s.split(',').map((n) => Number(n.trim())))
    .refine((a) => a.length > 0 && a.every((n) => Number.isInteger(n) && n > 0), 'must be a list of positive integers'),
  SYNC_BATCH_WINDOW_MS: z.coerce.number().int().positive().default(200),
  RELAY_POLL_MS: z.coerce.number().int().positive().default(500),
  RELAY_BATCH_SIZE: z.coerce.number().int().positive().default(100),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Fail fast at boot with a readable message; secrets are never printed, only the variable names.
  const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  console.error(`Invalid environment configuration:\n${problems}`);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
