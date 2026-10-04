# Shared helpers for backup.sh, restore.sh and upgrade.sh. Sourced, not run.
# Messages go to stderr so scripts can print results (like a backup path) on stdout.

CALLER_DIR=$(pwd)
DEPLOY_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_DIR=$(cd "$DEPLOY_DIR/.." && pwd)
cd "$DEPLOY_DIR"

info() { printf '==> %s\n' "$*" >&2; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

# Compose files for this install, relative to deploy/. Set MOSS_COMPOSE_FILES in the environment or
# in deploy/.env if you use extra files, e.g. "docker-compose.yml lab/compose.lab.yml".
compose_files() {
  files=${MOSS_COMPOSE_FILES:-}
  if [ -z "$files" ] && [ -f .env ]; then
    files=$(sed -n 's/^MOSS_COMPOSE_FILES=//p' .env | tail -n 1 | tr -d '"'"'")
  fi
  printf '%s' "${files:-docker-compose.yml}"
}

dc() {
  set -- $(for f in $(compose_files); do printf -- '-f %s ' "$f"; done) --env-file .env "$@"
  docker compose "$@"
}

require_docker() {
  command -v docker >/dev/null 2>&1 || die "docker is not installed"
  docker info >/dev/null 2>&1 || die "cannot talk to Docker. Is it running, and are you allowed to use it (try sudo)?"
  docker compose version >/dev/null 2>&1 || die "the docker compose plugin is not installed"
}

require_clean_tree() {
  cd "$REPO_DIR"
  if ! git diff --quiet || ! git diff --cached --quiet; then
    cd "$DEPLOY_DIR"
    die "the MOSS checkout has local changes to tracked files. Commit or stash them first (git status)."
  fi
  cd "$DEPLOY_DIR"
}

git_repo() { git -C "$REPO_DIR" "$@"; }

postgres_running() { [ -n "$(dc ps --status running -q postgres 2>/dev/null)" ]; }

# Runs SQL against the MOSS database inside the postgres container; prints tuples only.
psql_moss() {
  dc exec -T postgres sh -c 'psql -X -q -t -A -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"' sh "$1"
}

# Waits until the long-running services are healthy (or running, if they have no healthcheck).
wait_healthy() {
  timeout=${1:-240}
  start=$(date +%s)
  for svc in gate toolbox web worker; do
    while :; do
      id=$(dc ps -q "$svc" 2>/dev/null)
      status=""
      [ -n "$id" ] && status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null)
      case "$status" in
        healthy) break ;;
        running)
          # No healthcheck (worker): make sure it stays up rather than crash-looping.
          sleep 5
          [ "$(docker inspect -f '{{.State.Status}} {{.RestartCount}}' "$id")" = "running 0" ] && break
          ;;
        unhealthy | exited | dead)
          warn "$svc is $status"
          return 1
          ;;
      esac
      if [ $(($(date +%s) - start)) -ge "$timeout" ]; then
        warn "$svc did not become healthy within ${timeout}s (status: ${status:-missing})"
        return 1
      fi
      sleep 3
    done
    info "$svc is up"
  done
}
