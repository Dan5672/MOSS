# MOSS toolbox: runs network tools on behalf of the gate. Build context: repo root.
FROM node:24-bookworm-slim AS build
WORKDIR /src
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter "@moss/toolbox..." run build \
 && pnpm --filter @moss/toolbox deploy --prod --legacy /out

FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends nmap arp-scan iputils-ping libcap2-bin ca-certificates \
 # Grant raw-socket capabilities to the scanners only, so the service itself runs unprivileged.
 && setcap cap_net_raw,cap_net_admin+eip /usr/bin/nmap \
 && setcap cap_net_raw+eip /usr/sbin/arp-scan \
 && apt-get purge -y libcap2-bin && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out /app
USER node
ENV NODE_ENV=production PORT=7070
EXPOSE 7070
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:7070/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
