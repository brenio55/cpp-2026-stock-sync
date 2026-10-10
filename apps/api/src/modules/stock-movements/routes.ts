import { Router } from 'express';
import { z } from 'zod';
import { getAuth } from '../../common/types';
import { pageMeta, paginationSchema } from '../../common/pagination';
import { pool } from '../../db/pool';
import { authenticate } from '../../middleware/authenticate';
import { listMovements } from './repository';

export const stockMovementsRouter = Router();
stockMovementsRouter.use(authenticate);

const querySchema = paginationSchema.extend({ productId: z.string().uuid().optional() });

// Read-only history, scoped to the caller's tenant. Both roles may read it.
stockMovementsRouter.get('/', async (req, res) => {
  const { tenantId } = getAuth(req);
  const q = querySchema.parse(req.query);
  const { items, total } = await listMovements(pool, tenantId, q);
  res.json({ data: items, meta: pageMeta(q.page, q.limit, total) });
});
