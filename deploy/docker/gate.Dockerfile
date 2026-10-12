# MOSS gate: policy gate + secrets broker; the only path from agents to tools. Build context: repo root.
FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
WORKDIR /src
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter "@moss/gate..." run build \
 && pnpm --filter @moss/gate deploy --prod --legacy /out

FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
WORKDIR /app
COPY --from=build /out /app
# The agent library: built-in skills and Moss's template, which the gate keeps in step (src/library-sync.ts).
COPY library ./library
USER node
ENV MOSS_IMAGE=1 NODE_ENV=production PORT=7080
EXPOSE 7080
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:7080/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
