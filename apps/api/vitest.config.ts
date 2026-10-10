import { defineConfig } from 'vitest/config';
import { testDatabaseUrl } from './tests/helpers/test-db-url';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['./tests/global-setup.ts'],
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: testDatabaseUrl(),
      RABBITMQ_URL: 'amqp://localhost',
      JWT_SECRET: 'test-secret-test-secret-test-secret-0123456789',
      LOG_LEVEL: 'silent',
    },
    // All files share one database and truncate it between tests, so files run one after another.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
