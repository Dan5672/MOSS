# MOSS chat bridge: the Telegram and Discord bots. Build context: repo root.
FROM node:24-bookworm-slim AS build
WORKDIR /src
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter "@moss/bridge..." run build \
 && pnpm --filter @moss/bridge deploy --prod --legacy /out

FROM node:24-bookworm-slim
WORKDIR /app
COPY --from=build /out /app
USER node
ENV NODE_ENV=production
CMD ["node", "dist/main.js"]
