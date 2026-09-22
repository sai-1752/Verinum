# Build from the repository root:  docker build -f apps/web/Dockerfile -t verinum-web .
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web
COPY apps/api/package.json ./apps/api/package.json
RUN npm ci --ignore-scripts
RUN npm run build -w @verinum/web

FROM nginx:1.27-alpine
# nginx renders /etc/nginx/templates/*.template with the environment at start-up.
ENV API_UPSTREAM=http://api:4000 MAX_UPLOAD=300m
COPY deploy/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
