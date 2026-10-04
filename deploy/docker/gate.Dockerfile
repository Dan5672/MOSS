# MOSS gate: policy gate + secrets broker; the only path from agents to tools. Build context: repo root.
FROM node:24-bookworm-slim AS build
WORKDIR /src
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter "@moss/gate..." run build \
 && pnpm --filter @moss/gate deploy --prod --legacy /out

FROM node:24-bookworm-slim
WORKDIR /app
COPY --from=build /out /app
USER node
ENV NODE_ENV=production PORT=7080
EXPOSE 7080
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:7080/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
