#!/usr/bin/env sh
# Upgrades MOSS in place: back up, update the code, rebuild, migrate, and check it came back.
# Your data, secrets and settings are kept; nothing needs reconfiguring.
#
# Usage: sh deploy/upgrade.sh [version] [--yes] [--no-backup]
#        sh deploy/upgrade.sh --rollback [--yes]
#   version      a release tag (v0.2.0), branch or commit. Default: the newest release tag,
#                or origin/main if there are no releases yet.
#   --rollback   go back to the version before the last upgrade. Uses the previous images (no
#                rebuild). The database is restored from the pre-upgrade backup only if the
#                upgrade changed it, in which case anything recorded since the upgrade is lost.
#   --yes        don't ask for confirmation
#   --no-backup  skip the backup (not recommended)
#
# How it stays safe:
#   - The new images are built while the old version keeps running, so a failed build changes nothing.
#   - Database migrations run in one transaction: if one fails, the database is left as it was.
#   - The previous images are kept (tagged :rollback) and a backup is taken first, so a rollback
#     is quick: no rebuild, and no data loss unless the new version had already changed the database.
set -eu
. "$(dirname "$0")/lib.sh"

STATE=.last-upgrade
target=""
yes=false
backup=true
rollback=false
for arg in "$@"; do
  case "$arg" in
    --yes) yes=true ;;
    --no-backup) backup=false ;;
    --rollback) rollback=true ;;
    -*) die "unknown option $arg" ;;
    *) target=$arg ;;
  esac
done

require_docker
require_clean_tree
[ -f .env ] || die "deploy/.env not found. For a first install run deploy/init.sh instead."

confirm() {
  $yes && return 0
  printf '%s [y/N] ' "$1" >&2
  read -r answer
  case "$answer" in y | Y | yes) return 0 ;; *) die "cancelled" ;; esac
}

migration_count() { psql_moss 'select count(*) from drizzle.__drizzle_migrations' 2>/dev/null || echo unknown; }
images() { dc config --images 2>/dev/null | sort -u; }

# Keep the running version's images under :rollback so going back needs no rebuild.
save_images() {
  for img in $(images); do
    docker image inspect "$img" >/dev/null 2>&1 && docker tag "$img" "${img%:*}:rollback"
  done
  return 0
}

# Points the normal tags back at the :rollback images. Returns non-zero if any is missing.
restore_images() {
  for img in $(images); do
    docker image inspect "${img%:*}:rollback" >/dev/null 2>&1 || return 1
  done
  for img in $(images); do docker tag "${img%:*}:rollback" "$img"; done
}

state() { sed -n "s/^$1=//p" "$STATE"; }

do_rollback() {
  [ -f "$STATE" ] || die "no upgrade to roll back (deploy/$STATE not found)"
  from_commit=$(state from_commit)
  from_branch=$(state from_branch)
  from_version=$(state from_version)
  to_commit=$(state to_commit)
  archive=$(state backup)
  before=$(state migrations_before)
  [ "$(git_repo rev-parse HEAD)" = "$to_commit" ] ||
    die "the code is no longer at the upgraded version ($(state to_version)); roll back by hand with: sh deploy/restore.sh <backup> --checkout"

  restore_db=false
  postgres_running || dc up -d postgres >&2
  now=$(migration_count)
  if [ "$now" != "$before" ]; then
    restore_db=true
    [ -n "$archive" ] && [ -f "$archive" ] || die "the upgrade changed the database ($before -> $now migrations) and there is no backup to restore. Upgrade forward to a fixed version instead."
  fi

  info "Rolling back to $from_version"
  if $restore_db; then
    warn "the database was changed by the upgrade; it will be restored from $archive. Anything recorded since the upgrade is lost."
  else
    info "The database was not changed by the upgrade, so no data is lost"
  fi
  confirm "Roll back now?"

  git_repo checkout -q "${from_branch:-$from_commit}" 2>/dev/null || git_repo checkout -q --detach "$from_commit"
  [ "$(git_repo rev-parse HEAD)" = "$from_commit" ] || git_repo checkout -q --detach "$from_commit"
  if restore_images; then
    info "Using the previous images (no rebuild)"
  else
    info "Previous images not found; rebuilding $from_version"
    dc build >&2 || die "rebuilding $from_version failed"
  fi

  if $restore_db; then
    sh "$DEPLOY_DIR/restore.sh" "$archive" --yes || exit 1
  else
    dc up -d >&2 || die "MOSS failed to start; see: docker compose logs"
    wait_healthy || die "MOSS did not come back healthy; see: docker compose logs"
  fi
  rm -f "$STATE"
  info "Rolled back to $from_version"
}

if $rollback; then
  do_rollback
  exit 0
fi

postgres_running || die "MOSS is not running. Start it first so it can be backed up: docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d"

if git_repo remote get-url origin >/dev/null 2>&1; then
  info "Fetching updates"
  git_repo fetch --quiet --tags --prune origin || die "git fetch failed (no network?)"
fi

if [ -z "$target" ]; then
  target=$(git_repo tag --list 'v*' --sort=-v:refname | head -n 1)
  if [ -z "$target" ]; then
    target=origin/main
    warn "no release tags yet; upgrading to the latest development version (origin/main)"
  fi
fi

# A branch name follows that branch on origin (fast-forward only); anything else is checked out as is.
remote_branch=""
if git_repo show-ref --verify --quiet "refs/remotes/origin/$target"; then
  remote_branch=$target
  ref="origin/$target"
else
  ref=$target
fi
new=$(git_repo rev-parse --verify --quiet "$ref^{commit}") || die "unknown version: $target"
old=$(git_repo rev-parse HEAD)
old_branch=$(git_repo symbolic-ref --quiet --short HEAD || true)
old_version=$(git_repo describe --tags --always "$old")
new_version=$(git_repo describe --tags --always "$new")

if [ "$new" = "$old" ]; then
  info "Already at $new_version"
  exit 0
fi
if git_repo merge-base --is-ancestor "$new" "$old"; then
  die "$target ($new_version) is older than the running version ($old_version). Database migrations only go forward; to go back use: sh deploy/upgrade.sh --rollback (after an upgrade) or sh deploy/restore.sh <backup> --checkout"
fi
if ! git_repo merge-base --is-ancestor "$old" "$new"; then
  warn "$new_version is not a descendant of $old_version (different branch?). Continuing will switch to it."
fi

commits=$(git_repo rev-list --count "$old..$new")
info "Upgrade $old_version -> $new_version ($commits commits)"
git_repo log --oneline --no-decorate -n 15 "$old..$new" | sed 's/^/      /' >&2
[ "$commits" -gt 15 ] && printf '      ...\n' >&2
migrations=$(git_repo diff --name-only --diff-filter=A "$old" "$new" -- packages/db/migrations | grep '\.sql$' || true)
if [ -n "$migrations" ]; then
  info "Database changes:"
  printf '%s\n' "$migrations" | sed 's|.*/|      |' >&2
fi
edited=$(git_repo diff --name-only --diff-filter=MD "$old" "$new" -- packages/db/migrations | grep '\.sql$' || true)
[ -n "$edited" ] && warn "this version edits or removes existing migrations: $edited. Make sure you have a backup."
confirm "Continue?"

archive=""
if $backup; then
  archive=$(sh "$DEPLOY_DIR/backup.sh") || die "backup failed; nothing was changed"
fi

switch_back() {
  info "Switching the code back to $old_version"
  git_repo checkout -q "${old_branch:-$old}" 2>/dev/null || git_repo checkout -q --detach "$old"
}

info "Updating the code"
if [ -n "$remote_branch" ]; then
  if git_repo show-ref --verify --quiet "refs/heads/$remote_branch"; then
    git_repo checkout -q "$remote_branch"
    git_repo merge --quiet --ff-only "origin/$remote_branch" || {
      switch_back
      die "your local $remote_branch has diverged from origin; not upgrading"
    }
  else
    git_repo checkout -q -b "$remote_branch" "origin/$remote_branch"
  fi
else
  git_repo checkout -q --detach "$new"
fi

# New releases can add secrets or tokens; init.sh only creates what is missing.
sh "$DEPLOY_DIR/init.sh" >&2

save_images
info "Building $new_version (MOSS keeps running meanwhile)"
if ! dc build >&2; then
  switch_back
  restore_images || true
  die "the build failed; MOSS was not changed and is still running $old_version"
fi

cat >"$STATE" <<EOF
from_commit=$old
from_branch=$old_branch
from_version=$old_version
to_commit=$(git_repo rev-parse HEAD)
to_version=$new_version
backup=$archive
migrations_before=$(migration_count)
upgraded=$(date -u +%Y%m%dT%H%M%SZ)
EOF

failed() {
  warn "$1"
  if ! $yes && [ -t 0 ]; then
    printf 'Roll back to %s now? [y/N] ' "$old_version" >&2
    read -r answer
    case "$answer" in y | Y | yes) yes=true; do_rollback; exit 1 ;; esac
  fi
  printf '\nMOSS is not running properly. To go back to %s:\n  sh deploy/upgrade.sh --rollback\n' "$old_version" >&2
  exit 1
}

info "Starting $new_version and migrating the database"
if ! dc up -d >&2; then
  dc logs --no-log-prefix --tail 30 migrate >&2 || true
  failed "the new version failed to start (see the migration log above)."
fi
wait_healthy 300 || failed "the new version is not healthy. Recent logs: docker compose logs --tail 50"

info "MOSS is now running $new_version"
[ -n "$archive" ] && info "Pre-upgrade backup: $archive"
info "If something is wrong with this version, go back with: sh deploy/upgrade.sh --rollback"
