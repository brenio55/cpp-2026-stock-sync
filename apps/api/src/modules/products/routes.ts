import { Router } from 'express';
import { getAuth } from '../../common/types';
import { authenticate } from '../../middleware/authenticate';
import { requireRole } from '../../middleware/authorize';
import {
  adjustStockSchema,
  createProductSchema,
  idParamSchema,
  listProductsSchema,
  updateProductSchema,
} from './schemas';
import * as service from './service';

export const productsRouter = Router();
productsRouter.use(authenticate);

// Both roles can read; only admins can change products.
productsRouter.get('/', async (req, res) => {
  res.json(await service.listProducts(getAuth(req), listProductsSchema.parse(req.query)));
});

productsRouter.get('/:id', async (req, res) => {
  res.json(await service.getProduct(getAuth(req), idParamSchema.parse(req.params.id)));
});

productsRouter.post('/', requireRole('admin'), async (req, res) => {
  const product = await service.createProduct(getAuth(req), createProductSchema.parse(req.body));
  res.status(201).json(product);
});

productsRouter.patch('/:id', requireRole('admin'), async (req, res) => {
  const id = idParamSchema.parse(req.params.id);
  res.json(await service.updateProduct(getAuth(req), id, updateProductSchema.parse(req.body)));
});

productsRouter.delete('/:id', requireRole('admin'), async (req, res) => {
  await service.deleteProduct(getAuth(req), idParamSchema.parse(req.params.id));
  res.status(204).end();
});

productsRouter.post('/:id/adjust-stock', requireRole('admin'), async (req, res) => {
  const id = idParamSchema.parse(req.params.id);
  res.json(await service.adjustStock(getAuth(req), id, adjustStockSchema.parse(req.body)));
});
