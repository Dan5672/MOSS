# MOSS web: UI and server actions. Build context: repo root.
FROM node:24-bookworm-slim AS build
WORKDIR /src
RUN corepack enable
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm install --frozen-lockfile \
 && pnpm --filter "@moss/web^..." run build \
 && pnpm --filter @moss/web run build

FROM node:24-bookworm-slim
WORKDIR /app
# The release this image was built from (set by deploy/upgrade.sh), shown to Home Assistant's update entity.
ARG MOSS_RELEASE=dev
ENV MOSS_RELEASE=$MOSS_RELEASE
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0 MOSS_LIBRARY_DIR=/app/library
# Standalone output keeps the monorepo layout: the server lives at apps/web/server.js.
COPY --from=build /src/apps/web/.next/standalone ./
COPY --from=build /src/apps/web/.next/static ./apps/web/.next/static
COPY library ./library
# The Home Assistant integration, offered as a download for installs without HACS.
COPY custom_components/moss ./custom_components/moss
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
