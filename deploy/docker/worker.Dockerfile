# MOSS worker: agent runtime and scheduler. Build context: repo root.
FROM node:24-bookworm-slim AS build
WORKDIR /src
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter "@moss/worker..." run build \
 && pnpm --filter @moss/worker deploy --prod --legacy /out

FROM node:24-bookworm-slim
# Claude Code CLI, for agents on a Claude subscription. Runs locked down (no built-in tools); see
# packages/agent/src/claude-code.ts. Pinned so upgrades are deliberate.
ARG CLAUDE_CODE_VERSION=2.1.289
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" && npm cache clean --force && claude --version
WORKDIR /app
COPY --from=build /out /app
COPY library /app/library
USER node
ENV NODE_ENV=production MOSS_LIBRARY_DIR=/app/library
CMD ["node", "dist/main.js"]
