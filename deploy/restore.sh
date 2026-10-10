#!/usr/bin/env sh
# Restores a backup made by backup.sh. Replaces the MOSS database with the one in the backup.
#
# Usage: sh deploy/restore.sh <backup.tar.gz> [--checkout] [--replace-secrets] [--yes]
#   --checkout         also switch the code back to the commit the backup was taken from and
#                      rebuild (this is how you roll back a failed upgrade)
#   --replace-secrets  overwrite deploy/secrets with the backup's copy (needed when the backup's
#                      master key differs from this install's). deploy/.env is never overwritten:
#                      its database password must match the one this install's database was created with.
#   --yes              don't ask for confirmation
#
# Restoring onto a new machine: clone MOSS, then run this before init.sh. With no secrets or
# .env present, the backup's copies are used.
set -eu
. "$(dirname "$0")/lib.sh"

archive=""
checkout=false
replace_secrets=false
yes=false
for arg in "$@"; do
  case "$arg" in
    --checkout) checkout=true ;;
    --replace-secrets) replace_secrets=true ;;
    --yes) yes=true ;;
    -*) die "unknown option $arg" ;;
    *) archive=$arg ;;
  esac
done
[ -n "$archive" ] || die "usage: sh deploy/restore.sh <backup.tar.gz> [--checkout] [--replace-secrets] [--yes]"
case "$archive" in /*) ;; *) archive="$CALLER_DIR/$archive" ;; esac
[ -f "$archive" ] || die "no such file: $archive"
require_docker
$checkout && require_clean_tree

umask 077
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT INT TERM
tar -xzf "$archive" -C "$work" || die "cannot read $archive"
[ -f "$work/db.dump" ] && [ -f "$work/manifest" ] && [ -f "$work/secrets/master.key" ] || die "$archive is not a MOSS backup"
manifest() { sed -n "s/^$1=//p" "$work/manifest"; }

info "Backup from $(manifest created): MOSS $(manifest version), $(manifest migrations) database migrations"

# Secrets: the database's stored secrets are encrypted with the backup's master key.
mkdir -p secrets
if [ ! -f secrets/master.key ]; then
  cp -R "$work/secrets/." secrets/
  info "Installed the backup's secrets (none were present)"
elif ! cmp -s secrets/master.key "$work/secrets/master.key"; then
  if $replace_secrets; then
    saved="secrets.before-restore-$(date -u +%Y%m%dT%H%M%SZ)"
    cp -R secrets "$saved"
    cp -R "$work/secrets/." secrets/
    info "Replaced secrets (previous copies saved in deploy/$saved)"
  else
    die "this install's master key differs from the backup's, so secrets in the restored database could not be decrypted. Re-run with --replace-secrets to use the backup's keys."
  fi
fi
if [ ! -f .env ]; then
  cp "$work/env" .env
  info "Installed the backup's .env (none was present)"
fi

if ! $yes; then
  printf 'This REPLACES the current MOSS database with the backup above. Anything since then is lost.\nType "restore" to continue: ' >&2
  read -r answer
  [ "$answer" = "restore" ] || die "cancelled"
fi

if $checkout; then
  commit=$(manifest commit)
  [ "$commit" != unknown ] || die "the backup does not record a commit; check out the right version yourself and re-run without --checkout"
  info "Checking out $commit"
  git_repo checkout -q --detach "$commit"
fi

info "Stopping MOSS services (the database stays up)"
dc stop web worker gate toolbox >/dev/null 2>&1 || true
dc up -d postgres >/dev/null
for _ in $(seq 1 60); do
  dc exec -T postgres sh -c 'pg_isready -q -U "$POSTGRES_USER"' && break
  sleep 2
done

info "Replacing the database"
dc exec -T postgres sh -c '
  psql -X -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres \
    -c "DROP DATABASE IF EXISTS \"$POSTGRES_DB\" WITH (FORCE)" \
    -c "CREATE DATABASE \"$POSTGRES_DB\" OWNER \"$POSTGRES_USER\""' || die "could not recreate the database"
dc exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --exit-on-error' <"$work/db.dump" ||
  die "pg_restore failed. The database may be incomplete; fix the problem and restore again."

info "Starting MOSS"
if $checkout; then dc up -d --build >&2; else dc up -d >&2; fi
wait_healthy || die "MOSS did not come back healthy. Check: docker compose logs"
if [ -f "$work/https-pki.tar" ] && dc ps --services 2>/dev/null | grep -qx https; then
  info "Restoring the HTTPS certificate authority"
  dc exec -T https sh -c 'rm -rf /data/caddy/pki && tar -C /data -xf -' <"$work/https-pki.tar" && dc restart https >/dev/null 2>&1 ||
    warn "could not restore the HTTPS certificate authority; devices will need to trust the new one"
fi
info "Restore complete"
