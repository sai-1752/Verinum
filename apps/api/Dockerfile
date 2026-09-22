# Build from the repository root:  docker build -f apps/api/Dockerfile -t verinum-api .
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/web/package.json ./apps/web/package.json
RUN npm ci --ignore-scripts
RUN npm run build -w @verinum/api

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json ./packages/core/package.json
COPY packages/ingest/package.json ./packages/ingest/package.json
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
RUN npm ci --omit=dev --ignore-scripts --workspace @verinum/api

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY apps/api/config ./apps/api/config
COPY apps/api/migrations ./apps/api/migrations
COPY apps/api/assets ./apps/api/assets
COPY apps/api/package.json ./apps/api/package.json
WORKDIR /app/apps/api
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.mjs"]
