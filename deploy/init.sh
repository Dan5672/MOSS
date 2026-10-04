#!/usr/bin/env sh
# First-boot setup: creates .env and the secrets-broker master key if missing.
set -eu
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  pw=$(openssl rand -hex 24)
  sed "s/change-me/$pw/g" ../.env.example > .env
  echo "Created deploy/.env with a random database password."
fi

mkdir -p secrets
if [ ! -f secrets/master.key ]; then
  umask 077
  openssl rand -hex 32 > secrets/master.key
  echo "Generated deploy/secrets/master.key."
  echo "BACK THIS FILE UP. Without it, stored secrets cannot be recovered or restored."
fi
