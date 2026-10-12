#!/usr/bin/env sh
# Installs and starts MOSS: creates the settings and keys (init.sh), builds and starts it, waits until it's
# healthy, then prints the link to create your account, with the setup code already in it.
#
# Usage: sh deploy/install.sh
# Running it again is safe: it keeps your settings and keys, and starts MOSS if it isn't running.
set -eu
. "$(dirname "$0")/lib.sh"

require_docker
sh "$DEPLOY_DIR/init.sh"

info "Building and starting MOSS. The first build takes a while: 10 to 20 minutes on a typical mini PC."
dc up -d --build >&2 || die "MOSS failed to start; see: docker compose -f deploy/docker-compose.yml --env-file deploy/.env logs"
wait_healthy 300 || die "MOSS did not come up healthy; see: docker compose -f deploy/docker-compose.yml --env-file deploy/.env logs"

env_value() { sed -n "s/^$1=//p" .env | tail -n 1 | tr -d '"'"'"; }
case ",$(env_value COMPOSE_PROFILES)," in
  *,https,*)
    port=$(env_value MOSS_HTTPS_PORT)
    url="https://$(env_value MOSS_HTTPS_DEFAULT_NAME)"
    [ -n "$port" ] && [ "$port" != 443 ] && url="$url:$port"
    tls_note="Your browser will warn about the certificate the first time. That is expected: Settings → HTTPS shows how to trust it."
    ;;
  *) url="http://localhost:3000" tls_note="" ;;
esac

echo
if [ "$(psql_moss 'select count(*) from orgs' 2>/dev/null || echo 0)" = 0 ]; then
  echo "MOSS is ready. Open this link to create your account (the setup code is already in it):"
  echo
  echo "  $url/setup?code=$(cat secrets/setup.code)"
  echo
  if [ -n "$tls_note" ]; then echo "$tls_note"; fi
else
  echo "MOSS is running at $url"
fi
