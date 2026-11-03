# Builds the web app and serves it with Caddy (automatic HTTPS), proxying /api to the API.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace apps/web --include-workspace-root=false
COPY apps/web apps/web
RUN npm run build -w apps/web

FROM caddy:2-alpine
COPY infrastructure/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/web/dist /srv
