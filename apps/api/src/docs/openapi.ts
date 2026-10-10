/** Hand-written OpenAPI 3 description, served by Swagger UI at /docs. */

const bearer = [{ bearerAuth: [] }];
const errorResponse = { $ref: '#/components/responses/Error' };
const uuid = { type: 'string', format: 'uuid' };
const idParam = { name: 'id', in: 'path', required: true, schema: uuid };
const pageParams = [
  { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
  { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
];
const json = (schema: unknown) => ({ 'application/json': { schema } });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

export const openapi = {
  openapi: '3.0.3',
  info: {
    title: 'StockSync API',
    version: '1.0.0',
    description:
      'Multi-tenant inventory API. The tenant is always taken from the JWT. Prices are decimal strings. ' +
      'Seeded users (password `password123`): admin@acme.test, operator@acme.test, admin@globex.test, operator@globex.test.',
  },
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    responses: {
      Error: { description: 'Error', content: json(ref('Error')) },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          statusCode: { type: 'integer' },
          code: { type: 'string', example: 'INSUFFICIENT_STOCK' },
          message: { type: 'string' },
          details: {},
          correlationId: { type: 'string' },
        },
      },
      Product: {
        type: 'object',
        properties: {
          id: uuid,
          sku: { type: 'string', example: 'SHIRT-POLO-BLUE-M' },
          name: { type: 'string' },
          price: { type: 'string', example: '59.90' },
          stock: { type: 'integer' },
          version: { type: 'integer' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      PageMeta: {
        type: 'object',
        properties: {
          page: { type: 'integer' },
          limit: { type: 'integer' },
          total: { type: 'integer' },
          totalPages: { type: 'integer' },
        },
      },
      SaleRequest: {
        type: 'object',
        required: ['items'],
        properties: {
          items: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              required: ['productId', 'quantity'],
              properties: { productId: uuid, quantity: { type: 'integer', minimum: 1 } },
            },
          },
        },
      },
    },
  },
  paths: {
    '/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Log in and receive a JWT',
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            required: ['email', 'password'],
            properties: { email: { type: 'string' }, password: { type: 'string' } },
          }),
        },
        responses: { 200: { description: 'Token and user' }, 400: errorResponse, 401: errorResponse },
      },
    },
    '/auth/me': {
      get: { tags: ['Auth'], summary: 'Current user', security: bearer, responses: { 200: { description: 'User' }, 401: errorResponse } },
    },
    '/products': {
      get: {
        tags: ['Products'],
        summary: 'List products (paginated)',
        security: bearer,
        parameters: [
          ...pageParams,
          { name: 'q', in: 'query', description: 'Matches name or SKU', schema: { type: 'string' } },
          { name: 'outOfStock', in: 'query', schema: { type: 'boolean' } },
        ],
        responses: { 200: { description: '{ data: Product[], meta }' }, 401: errorResponse },
      },
      post: {
        tags: ['Products'],
        summary: 'Create a product (admin)',
        security: bearer,
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            required: ['sku', 'name', 'price'],
            properties: {
              sku: { type: 'string' },
              name: { type: 'string' },
              price: { type: 'string', example: '19.90' },
              stock: { type: 'integer', minimum: 0, default: 0 },
            },
          }),
        },
        responses: { 201: { description: 'Created', content: json(ref('Product')) }, 400: errorResponse, 403: errorResponse, 409: errorResponse },
      },
    },
    '/products/{id}': {
      get: { tags: ['Products'], summary: 'Get a product', security: bearer, parameters: [idParam], responses: { 200: { description: 'Product' }, 404: errorResponse } },
      patch: {
        tags: ['Products'],
        summary: 'Update name and/or price (admin)',
        security: bearer,
        parameters: [idParam],
        responses: { 200: { description: 'Product' }, 403: errorResponse, 404: errorResponse },
      },
      delete: { tags: ['Products'], summary: 'Soft-delete a product (admin)', security: bearer, parameters: [idParam], responses: { 204: { description: 'Deleted' }, 403: errorResponse, 404: errorResponse } },
    },
    '/products/{id}/adjust-stock': {
      post: {
        tags: ['Products'],
        summary: 'Adjust stock by a signed delta (admin)',
        security: bearer,
        parameters: [idParam],
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            required: ['delta'],
            properties: { delta: { type: 'integer' }, note: { type: 'string' } },
          }),
        },
        responses: { 200: { description: 'Product' }, 409: errorResponse },
      },
    },
    '/sales': {
      post: {
        tags: ['Sales'],
        summary: 'Register a sale (all-or-nothing, never oversells)',
        description: 'Send an `Idempotency-Key` header; a retry with the same key and body returns the original response.',
        security: bearer,
        parameters: [{ name: 'Idempotency-Key', in: 'header', schema: { type: 'string' } }],
        requestBody: { required: true, content: json(ref('SaleRequest')) },
        responses: {
          201: { description: 'Sale registered (or replayed, header Idempotent-Replayed: true)' },
          404: errorResponse,
          409: { description: 'INSUFFICIENT_STOCK', content: json(ref('Error')) },
          422: { description: 'IDEMPOTENCY_KEY_REUSED with a different body', content: json(ref('Error')) },
        },
      },
    },
    '/stock-movements': {
      get: {
        tags: ['Stock'],
        summary: 'Stock movement history (who, when, why, quantity)',
        security: bearer,
        parameters: [...pageParams, { name: 'productId', in: 'query', schema: uuid }],
        responses: { 200: { description: '{ data, meta }' } },
      },
    },
    '/sync/status': {
      get: { tags: ['Sync'], summary: 'Sync status for the caller tenant', security: bearer, responses: { 200: { description: 'Counts, last success, recent failures' } } },
    },
    '/sync/failed/{id}/retry': {
      post: { tags: ['Sync'], summary: 'Re-queue a dead-lettered update (admin)', security: bearer, parameters: [idParam], responses: { 202: { description: 'Re-queued' }, 404: errorResponse } },
    },
    '/health': {
      get: { tags: ['Ops'], summary: 'Liveness, queue depth and last sync', responses: { 200: { description: 'ok / degraded' }, 503: { description: 'database down' } } },
    },
  },
};
