# MOSS worker: agent runtime and scheduler. Build context: repo root.
FROM node:24-bookworm-slim AS build
WORKDIR /src
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter "@moss/worker..." run build \
 && pnpm --filter @moss/worker deploy --prod --legacy /out

FROM node:24-bookworm-slim
WORKDIR /app
COPY --from=build /out /app
COPY library /app/library
USER node
ENV NODE_ENV=production MOSS_LIBRARY_DIR=/app/library
CMD ["node", "dist/main.js"]
