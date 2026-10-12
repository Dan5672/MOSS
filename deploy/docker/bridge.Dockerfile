# MOSS chat bridge: the Telegram and Discord bots. Build context: repo root.
FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
WORKDIR /src
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter "@moss/bridge..." run build \
 && pnpm --filter @moss/bridge deploy --prod --legacy /out

FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
WORKDIR /app
COPY --from=build /out /app
USER node
ENV MOSS_IMAGE=1 NODE_ENV=production
CMD ["node", "dist/main.js"]
