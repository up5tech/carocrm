# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm -r build
RUN pnpm --filter @carocrm/web build

FROM node:24-bookworm-slim AS api-runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable && groupadd --system carocrm && useradd --system --gid carocrm --home-dir /app carocrm
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps ./apps
COPY packages ./packages
COPY modules ./modules
COPY database/migrations ./database/migrations
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/packages ./packages
COPY --from=build /app/modules ./modules
RUN pnpm install --prod --filter @carocrm/api... --frozen-lockfile \
    && pnpm store prune \
    && mkdir -p /var/lib/carocrm/files \
    && chown -R carocrm:carocrm /app /var/lib/carocrm
USER carocrm
EXPOSE 3030
CMD ["node", "apps/api/dist/main.js"]

FROM api-runtime AS migration-runtime
CMD ["node", "apps/api/dist/migrate.js"]

FROM node:24-bookworm-slim AS worker-runtime
WORKDIR /app
ENV NODE_ENV=production
RUN groupadd --system carocrm && useradd --system --gid carocrm --home-dir /app carocrm
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps ./apps
COPY packages ./packages
COPY modules ./modules
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
COPY --from=build /app/packages ./packages
COPY --from=build /app/modules ./modules
RUN corepack enable && pnpm install --prod --filter @carocrm/worker... --frozen-lockfile \
    && pnpm store prune \
    && mkdir -p /var/lib/carocrm/files \
    && chown -R carocrm:carocrm /app /var/lib/carocrm
USER carocrm
CMD ["node", "apps/worker/dist/main.js"]

FROM nginx:1.27-alpine AS web-runtime
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
