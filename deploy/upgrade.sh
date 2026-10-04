#!/usr/bin/env sh
# Upgrades MOSS in place: back up, update the code, rebuild, migrate, and check it came back.
# Your data, secrets and settings are kept; nothing needs reconfiguring.
#
# Usage: sh deploy/upgrade.sh [version] [--yes] [--no-backup]
#   version      a release tag (v0.2.0), branch or commit. Default: the newest release tag,
#                or origin/main if there are no releases yet.
#   --yes        don't ask for confirmation (and don't offer an automatic rollback)
#   --no-backup  skip the backup (not recommended)
#
# How it stays safe:
#   - The new images are built before anything is stopped, so a failed build changes nothing.
#   - Database migrations run in one transaction: if one fails, the database is left as it was.
#   - A backup is taken first; if the new version doesn't come up healthy you are offered a
#     rollback (restore.sh --checkout), which restores the backup and the previous code.
set -eu
. "$(dirname "$0")/lib.sh"

target=""
yes=false
backup=true
for arg in "$@"; do
  case "$arg" in
    --yes) yes=true ;;
    --no-backup) backup=false ;;
    -*) die "unknown option $arg" ;;
    *) target=$arg ;;
  esac
done

require_docker
require_clean_tree
[ -f .env ] || die "deploy/.env not found. For a first install run deploy/init.sh instead."
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
old_version=$(git_repo describe --tags --always "$old")
new_version=$(git_repo describe --tags --always "$new")

if [ "$new" = "$old" ]; then
  info "Already at $new_version"
  exit 0
fi
if git_repo merge-base --is-ancestor "$new" "$old"; then
  die "$target ($new_version) is older than the running version ($old_version). Database migrations only go forward; to go back, restore a backup with: sh deploy/restore.sh <backup> --checkout"
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

if ! $yes; then
  printf 'Continue? [y/N] ' >&2
  read -r answer
  case "$answer" in y | Y | yes) ;; *) die "cancelled" ;; esac
fi

archive=""
if $backup; then
  archive=$(sh "$DEPLOY_DIR/backup.sh") || die "backup failed; nothing was changed"
fi

switch_back() {
  info "Switching the code back to $old_version"
  git_repo checkout -q "${old_branch:-$old}" 2>/dev/null || git_repo checkout -q --detach "$old"
}

old_branch=$(git_repo symbolic-ref --quiet --short HEAD || true)
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

info "Building $new_version (MOSS keeps running meanwhile)"
if ! dc build >&2; then
  switch_back
  die "the build failed; MOSS was not changed and is still running $old_version"
fi

rollback_help() {
  if [ -n "$archive" ]; then
    printf '\nTo roll back to %s and the data from before the upgrade:\n  sh deploy/restore.sh %s --checkout\n' "$old_version" "$archive" >&2
  else
    printf '\nTo go back, check out %s and rebuild: git checkout %s && docker compose ... up -d --build\n' "$old_version" "$old" >&2
  fi
}

offer_rollback() {
  rollback_help
  if ! $yes && [ -n "$archive" ] && [ -t 0 ]; then
    printf 'Roll back now? [y/N] ' >&2
    read -r answer
    case "$answer" in
      y | Y | yes) exec sh "$DEPLOY_DIR/restore.sh" "$archive" --checkout --yes ;;
    esac
  fi
  exit 1
}

info "Starting $new_version and migrating the database"
if ! dc up -d >&2; then
  warn "MOSS failed to start. Migration log:"
  dc logs --no-log-prefix --tail 30 migrate >&2 || true
  offer_rollback
fi
if ! wait_healthy 300; then
  warn "the new version is not healthy. Recent logs: docker compose logs --tail 50"
  offer_rollback
fi

info "MOSS is now running $new_version"
[ -n "$archive" ] && info "The pre-upgrade backup is $archive"
exit 0
