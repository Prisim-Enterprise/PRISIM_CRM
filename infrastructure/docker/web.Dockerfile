# Builds the web app and serves it with Caddy (automatic HTTPS), proxying /api to the API.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci --workspace frontend --include-workspace-root=false
COPY frontend frontend
# Public by design; Vite builds it into the web app.
ARG VITE_CLERK_PUBLISHABLE_KEY
ENV VITE_CLERK_PUBLISHABLE_KEY=$VITE_CLERK_PUBLISHABLE_KEY
RUN npm run build -w frontend

FROM caddy:2-alpine
COPY infrastructure/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/frontend/dist /srv
