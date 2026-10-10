#!/usr/bin/env sh
# First-boot setup: creates .env, the secrets-broker master key and service tokens if missing.
set -eu
cd "$(dirname "$0")"

# This machine's IPv4 addresses on its networks (for the HTTPS certificate). Docker's own bridges
# (172.17-31.x) are left out.
lan_addresses() {
  { hostname -I 2>/dev/null || ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 || ipconfig getifaddr en0 2>/dev/null || true; } |
    tr ' ' '\n' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | grep -Ev '^172\.(1[7-9]|2[0-9]|3[01])\.' | head -n 4 || true
}

if [ ! -f .env ]; then
  pw=$(openssl rand -hex 24)
  sed "s/change-me/$pw/g" ../.env.example > .env
  echo "Created deploy/.env with a random database password."
  # New installs get HTTPS for every device on the network, with MOSS's own certificate authority.
  name=$(hostname 2>/dev/null | cut -d. -f1)
  hosts="localhost"
  [ -n "$name" ] && hosts="$hosts, $name, $name.local"
  first=""
  for ip in $(lan_addresses); do
    hosts="$hosts, $ip"
    [ -z "$first" ] && first=$ip
  done
  {
    echo ""
    echo "# HTTPS (added by init.sh). Open https://<one of MOSS_HTTPS_HOSTS>; trust /moss-ca.crt once per device."
    echo "COMPOSE_PROFILES=https"
    echo "MOSS_SECURE_COOKIES=true"
    echo "MOSS_TLS=internal"
    echo "MOSS_HTTPS_HOSTS=$hosts"
    echo "MOSS_HTTPS_DEFAULT_NAME=${first:-localhost}"
  } >> .env
  echo "HTTPS is on. MOSS will answer at: $hosts"
fi
mkdir -p certs backups

mkdir -p secrets
umask 077
if [ ! -f secrets/master.key ]; then
  openssl rand -hex 32 > secrets/master.key
  echo "Generated deploy/secrets/master.key."
  echo "BACK THIS FILE UP. Without it, stored secrets cannot be recovered or restored."
fi
for token in gate toolbox web backup; do
  if [ ! -f "secrets/$token.token" ]; then
    openssl rand -hex 32 > "secrets/$token.token"
    echo "Generated deploy/secrets/$token.token."
  fi
done
if [ ! -f secrets/app.key ]; then
  openssl rand -hex 32 > secrets/app.key
  echo "Generated deploy/secrets/app.key (encrypts users' two-factor secrets)."
fi
