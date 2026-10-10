# Build context is the repository root (npm workspaces share one lockfile).
# One image serves the API, the worker and the one-shot migrate job; compose picks the command.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/mock-ads/package.json apps/mock-ads/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY apps/api apps/api
RUN npm run build -w @stocksync/api

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/mock-ads/package.json apps/mock-ads/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev -w @stocksync/api
COPY --from=build /app/apps/api/dist apps/api/dist
COPY apps/api/migrations apps/api/migrations
USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/server.js"]
