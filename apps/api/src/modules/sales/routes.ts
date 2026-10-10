import { Router } from 'express';
import { badRequest } from '../../common/errors';
import { getAuth } from '../../common/types';
import { authenticate } from '../../middleware/authenticate';
import { createSaleSchema, idempotencyKeySchema } from './schemas';
import * as service from './service';

export const salesRouter = Router();
salesRouter.use(authenticate);

// Both admins and operators register sales.
salesRouter.post('/', async (req, res) => {
  const input = createSaleSchema.parse(req.body);

  const rawKey = req.get('Idempotency-Key');
  let key: string | undefined;
  if (rawKey !== undefined) {
    const parsed = idempotencyKeySchema.safeParse(rawKey);
    if (!parsed.success) {
      throw badRequest('INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be 1-255 visible ASCII characters');
    }
    key = parsed.data;
  }

  const result = await service.createSale(getAuth(req), input, key);
  if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
  res.status(result.status).json(result.body);
});
