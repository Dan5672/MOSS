# MOSS's HTTPS service: Caddy with one extra module, caddy-dns/cloudflare, so MOSS can get a trusted certificate
# from Let's Encrypt through a Cloudflare DNS challenge (Settings → HTTPS), without opening any port to the internet.
# The binary comes from Caddy's official build service and must list the module, or the build fails.
FROM caddy:2-alpine
ARG TARGETARCH
RUN apk add --no-cache --virtual .fetch curl \
 && apk add --no-cache libcap \
 && curl -fsSL --retry 3 --max-time 300 -o /tmp/caddy "https://caddyserver.com/api/download?os=linux&arch=${TARGETARCH:-amd64}&p=github.com/caddy-dns/cloudflare" \
 && chmod 0755 /tmp/caddy \
 && /tmp/caddy list-modules | grep -qx "dns.providers.cloudflare" \
 && mv /tmp/caddy /usr/bin/caddy \
 && setcap cap_net_bind_service=+ep /usr/bin/caddy \
 && apk del .fetch \
 && caddy version
