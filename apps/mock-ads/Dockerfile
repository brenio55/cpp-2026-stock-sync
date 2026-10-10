FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/mock-ads/package.json apps/mock-ads/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY apps/mock-ads apps/mock-ads
RUN npm run build -w @stocksync/mock-ads

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/mock-ads/package.json apps/mock-ads/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev -w @stocksync/mock-ads
COPY --from=build /app/apps/mock-ads/dist apps/mock-ads/dist
USER node
EXPOSE 4000
CMD ["node", "apps/mock-ads/dist/server.js"]
