# MOSS's HTTPS service: Caddy with one extra module, caddy-dns/cloudflare, so MOSS can get a trusted certificate
# from Let's Encrypt through a Cloudflare DNS challenge (Settings → HTTPS), without opening any port to the internet.
# Built from source at pinned versions; Go checks every module against go.sum and the public checksum database.
FROM caddy:2.11.7-builder-alpine@sha256:aa705b1e8e4bce41a7a30de934c1e00f6821667c1d1206424465065c92cb7674 AS build
RUN xcaddy build v2.11.7 --with github.com/caddy-dns/cloudflare@v0.2.4 --output /usr/bin/caddy \
 && /usr/bin/caddy list-modules | grep -qx "dns.providers.cloudflare"

FROM caddy:2.11.7-alpine@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f
COPY --from=build /usr/bin/caddy /usr/bin/caddy
RUN apk add --no-cache libcap \
 && setcap cap_net_bind_service=+ep /usr/bin/caddy \
 && caddy version
