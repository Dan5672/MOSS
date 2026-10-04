#!/usr/bin/env sh
# Backs up everything needed to rebuild this MOSS install on this or another machine:
#   - the database (pg_dump, custom format, checked after writing)
#   - deploy/secrets/ (master key, app key, service tokens) and deploy/.env
#   - a manifest: when, which MOSS commit, which database migration
# The archive contains the master key, so treat it like a password: it is written with
# owner-only permissions. Keep a copy somewhere other than this machine.
#
# Usage: sh deploy/backup.sh            prints the archive path on stdout
# Env:   MOSS_BACKUP_DIR   where to write (default deploy/backups)
#        MOSS_BACKUP_KEEP  how many archives to keep (default 10; 0 keeps all)
set -eu
. "$(dirname "$0")/lib.sh"
require_docker

[ -f .env ] || die "deploy/.env not found. Nothing to back up (has MOSS been set up with init.sh?)"
[ -f secrets/master.key ] || die "deploy/secrets/master.key not found"
postgres_running || die "postgres is not running. Start the stack first: docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d"

umask 077
dest=${MOSS_BACKUP_DIR:-$DEPLOY_DIR/backups}
mkdir -p "$dest"
dest=$(cd "$dest" && pwd)
stamp=$(date -u +%Y%m%dT%H%M%SZ)
archive="$dest/moss-backup-$stamp.tar.gz"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT INT TERM

info "Dumping the database"
dc exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner' >"$work/db.dump" ||
  die "pg_dump failed"
dc exec -T postgres pg_restore --list <"$work/db.dump" >/dev/null || die "the database dump is unreadable; not keeping it"

info "Copying secrets and settings"
cp -R secrets "$work/secrets"
cp .env "$work/env"

migrations=$(psql_moss 'select count(*) from drizzle.__drizzle_migrations' 2>/dev/null || echo unknown)
commit=$(git_repo rev-parse HEAD 2>/dev/null || echo unknown)
version=$(git_repo describe --tags --always --dirty 2>/dev/null || echo unknown)
cat >"$work/manifest" <<EOF
created=$stamp
commit=$commit
version=$version
migrations=$migrations
compose_files=$(compose_files)
EOF

tar -czf "$archive.partial" -C "$work" .
mv "$archive.partial" "$archive"
chmod 600 "$archive"
info "Backup written: $archive ($(du -h "$archive" | cut -f1))"

keep=${MOSS_BACKUP_KEEP:-10}
if [ "$keep" -gt 0 ]; then
  # Timestamped names sort chronologically; remove all but the newest $keep.
  old=$(ls -1 "$dest"/moss-backup-*.tar.gz 2>/dev/null | sort -r | tail -n +$((keep + 1)))
  for f in $old; do
    rm -f "$f"
    info "Removed old backup $(basename "$f")"
  done
fi

echo "$archive"
