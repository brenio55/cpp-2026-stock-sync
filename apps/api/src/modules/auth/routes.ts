import { Router } from 'express';
import { getAuth } from '../../common/types';
import { authenticate } from '../../middleware/authenticate';
import { loginSchema } from './schemas';
import * as service from './service';

export const authRouter = Router();

authRouter.post('/login', async (req, res) => {
  const input = loginSchema.parse(req.body);
  res.json(await service.login(input));
});

authRouter.get('/me', authenticate, async (req, res) => {
  res.json(await service.me(getAuth(req)));
});
