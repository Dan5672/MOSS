# MOSS toolbox: runs network tools on behalf of the gate. Build context: repo root.
FROM node:24-bookworm-slim AS build
WORKDIR /src
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter "@moss/toolbox..." run build \
 && pnpm --filter @moss/toolbox deploy --prod --legacy /out

# Nuclei and its templates: pinned releases, checked against known SHA-256 sums. Downloaded in their own
# stage so curl and unzip don't end up in the toolbox. Only network-facing templates are kept (no code,
# javascript, headless, file, cloud or DAST templates).
FROM debian:bookworm-slim AS scanners
ARG NUCLEI_VERSION=3.11.1
ARG NUCLEI_SHA256=ea63d4ae232808cd7c6bc00d0142428e231fab59dae01042246097d195835ab6
ARG TEMPLATES_VERSION=10.5.0
ARG TEMPLATES_SHA256=80fbabceca095fac40afecc7f023748df22b9576b9ff10a4422bd2fbf81f9a41
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates unzip \
 && curl -fsSL -o /tmp/nuclei.zip "https://github.com/projectdiscovery/nuclei/releases/download/v${NUCLEI_VERSION}/nuclei_${NUCLEI_VERSION}_linux_amd64.zip" \
 && echo "${NUCLEI_SHA256}  /tmp/nuclei.zip" | sha256sum -c - \
 && unzip -q /tmp/nuclei.zip nuclei -d /usr/local/bin \
 && curl -fsSL -o /tmp/templates.tar.gz "https://github.com/projectdiscovery/nuclei-templates/archive/refs/tags/v${TEMPLATES_VERSION}.tar.gz" \
 && echo "${TEMPLATES_SHA256}  /tmp/templates.tar.gz" | sha256sum -c - \
 && mkdir -p /opt/nuclei-templates \
 && tar -xzf /tmp/templates.tar.gz -C /opt/nuclei-templates --strip-components=1 \
 && cd /opt/nuclei-templates && rm -rf code javascript headless file cloud dast workflows .github helpers profiles \
 && test -x /usr/local/bin/nuclei && test -d /opt/nuclei-templates/http

FROM node:24-bookworm-slim
COPY --from=scanners /usr/local/bin/nuclei /usr/local/bin/nuclei
COPY --from=scanners /opt/nuclei-templates /opt/nuclei-templates
RUN apt-get update \
 && apt-get install -y --no-install-recommends nmap arp-scan iputils-ping traceroute snmp libcap2-bin ca-certificates testssl.sh \
 # Grant raw-socket capabilities to the scanners only, so the service itself runs unprivileged.
 && setcap cap_net_raw,cap_net_admin+eip /usr/bin/nmap \
 && setcap cap_net_raw+eip /usr/sbin/arp-scan \
 && rm -rf /var/lib/apt/lists/* \
 # Fail the build if any tool binary is missing. (Keep libcap2-bin: iputils-ping depends on it.)
 # Existence checks only: nmap's NET_ADMIN file capability can't be exercised in the build sandbox.
 && test -x /usr/bin/nmap && test -x /usr/sbin/arp-scan && test -x /bin/ping \
 && command -v traceroute && command -v snmpget && command -v snmpbulkwalk \
 && test -f /usr/share/nmap/scripts/nbstat.nse && test -f /usr/share/nmap/scripts/upnp-info.nse \
 && test -f /usr/share/nmap/scripts/dns-service-discovery.nse \
 && test -f /usr/share/nmap/scripts/vulners.nse && command -v testssl && test -x /usr/local/bin/nuclei
WORKDIR /app
COPY --from=build /out /app
USER node
ENV NODE_ENV=production PORT=7070
EXPOSE 7070
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:7070/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
