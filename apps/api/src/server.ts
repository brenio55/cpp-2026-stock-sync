import { createApp } from './app';
import { env } from './config/env';
import { logger } from './common/logger';
import { pool } from './db/pool';

const app = createApp();
const server = app.listen(env.PORT, () => logger.info({ port: env.PORT }, 'api listening'));

function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  server.close(() => {
    void pool.end().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
