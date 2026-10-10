import { Router } from 'express';
import { z } from 'zod';
import { getAuth } from '../../common/types';
import { authenticate } from '../../middleware/authenticate';
import { requireRole } from '../../middleware/authorize';
import * as service from './service';

export const syncRouter = Router();
syncRouter.use(authenticate);

// Per-tenant report: pending / sent / failed counts and the last successful sync.
syncRouter.get('/status', async (req, res) => {
  res.json(await service.getStatus(getAuth(req)));
});

const idSchema = z.coerce.number().int().positive();

syncRouter.post('/failed/:id/retry', requireRole('admin'), async (req, res) => {
  const id = idSchema.parse(req.params.id);
  res.status(202).json(await service.retryFailed(getAuth(req), id));
});
