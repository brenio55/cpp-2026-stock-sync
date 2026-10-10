import { randomUUID } from 'node:crypto';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import { logger } from './common/logger';
import { openapi } from './docs/openapi';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { authRouter } from './modules/auth/routes';
import { healthRouter } from './modules/health/routes';
import { productsRouter } from './modules/products/routes';
import { salesRouter } from './modules/sales/routes';
import { stockMovementsRouter } from './modules/stock-movements/routes';
import { syncRouter } from './modules/sync/routes';

// Accept a caller-supplied correlation id only if it looks sane; otherwise generate one.
const SAFE_REQUEST_ID = /^[\w.-]{8,64}$/;

export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');

  // Swagger UI needs inline scripts/styles, so it is mounted before helmet's strict CSP.
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapi));

  app.use(helmet());
  app.use(
    pinoHttp({
      logger,
      // The id travels in the x-request-id header and appears in every log line and every error body.
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id = typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
    }),
  );
  app.use(express.json({ limit: '100kb' }));

  app.use('/health', healthRouter);
  app.use('/auth', authRouter);
  app.use('/products', productsRouter);
  app.use('/sales', salesRouter);
  app.use('/stock-movements', stockMovementsRouter);
  app.use('/sync', syncRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
