#!/usr/bin/env bash
# Push code from this checkout to the API VM and restart the service.
#
# Idempotent and re-runnable: rsync syncs only changed files, install
# only runs if the lockfile changed, build always re-runs (cheap).
#
# Reads the deploy host from deploy/scaleway/state.env (API_PUBLIC_IP)
# and provision.env (DOMAIN, BASIC_AUTH_*, ACME_EMAIL).

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$HERE/.." && pwd)"
REPO_ROOT="$(cd "$DEPLOY_DIR/../.." && pwd)"
STATE_FILE="$DEPLOY_DIR/state.env"
ENV_FILE="$DEPLOY_DIR/provision.env"

log() { printf '[deploy] %s\n' "$*" >&2; }
fail() { log "ERROR: $*"; exit 1; }

[ -f "$ENV_FILE" ]   || fail "missing $ENV_FILE"
[ -f "$STATE_FILE" ] || fail "missing $STATE_FILE — run provision.sh first"

# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; . "$STATE_FILE"; set +a

: "${API_PUBLIC_IP:?API_PUBLIC_IP not in state.env}"
SSH_HOST="${DEPLOY_USER:-deploy}@${API_PUBLIC_IP}"
REMOTE_ROOT=/opt/visual-compare

# ---- Render Caddyfile from template ----
caddyfile_tmp="$(mktemp -t Caddyfile.XXXXXX)"
trap 'rm -f "$caddyfile_tmp"' EXIT

DOMAIN="$DOMAIN" \
ACME_EMAIL="$ACME_EMAIL" \
BASIC_AUTH_USER="$BASIC_AUTH_USER" \
BASIC_AUTH_HASH="$BASIC_AUTH_HASH" \
envsubst < "$DEPLOY_DIR/Caddyfile.template" > "$caddyfile_tmp"

# ---- Sync code ----
# `/opt/visual-compare` is owned by the service user (`visual-compare`), which
# the `deploy` user can't write to directly. `--rsync-path="sudo rsync"` runs
# the remote rsync as root via passwordless sudo. Excludes:
#  - `.git` (no trailing slash → matches the worktree-mode .git FILE too)
#  - everything that would be re-created on the VM (node_modules, dist, data)
#  - dev-only artefacts (.claude, .kamal, deploy/)
log "rsyncing source to ${SSH_HOST}:${REMOTE_ROOT}…"
rsync -az --delete \
  --rsync-path="sudo rsync" \
  --exclude .git \
  --exclude .gitignore \
  --exclude .claude/ \
  --exclude .kamal/ \
  --exclude deploy/ \
  --exclude node_modules/ \
  --exclude 'packages/*/node_modules/' \
  --exclude 'packages/*/dist/' \
  --exclude data/ \
  --exclude .shared/ \
  --exclude '*.sqlite' \
  --exclude '*.sqlite-journal' \
  --exclude '.DS_Store' \
  -e ssh \
  "$REPO_ROOT/" "$SSH_HOST:$REMOTE_ROOT/"

# ---- Sync the rendered Caddyfile separately so we don't ship the template ----
rsync -az "$caddyfile_tmp" "$SSH_HOST:/tmp/Caddyfile.new"

# ---- Remote build + restart ----
log "running install + build on the API VM…"
ssh "$SSH_HOST" bash -s <<'REMOTE'
set -euo pipefail
cd /opt/visual-compare

# Re-take ownership in case rsync as `deploy` left files unreadable by the
# service user. Both packages are needed for build (web build -> static
# bundle served by Caddy from /opt/visual-compare/packages/web/dist).
sudo chown -R visual-compare:visual-compare /opt/visual-compare

# Install Playwright Chromium (needed by the capture worker). Cheap if
# already cached — Playwright skips re-downloads.
export PLAYWRIGHT_BROWSERS_PATH=/opt/visual-compare/.cache/ms-playwright
sudo -u visual-compare -H PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_BROWSERS_PATH" \
  pnpm install --frozen-lockfile
sudo -u visual-compare -H PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_BROWSERS_PATH" \
  pnpm --filter @visual-compare/api exec playwright install chromium
sudo -u visual-compare -H pnpm -r build

# Move the web build to the path Caddy serves. The Caddyfile points at
# /opt/visual-compare/web; using a symlink avoids a copy on every deploy.
sudo -u visual-compare ln -sfn /opt/visual-compare/packages/web/dist /opt/visual-compare/web

# Caddyfile: validate then swap.
sudo install -m 0644 /tmp/Caddyfile.new /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy

# Restart the API service.
sudo systemctl restart visual-compare-api
sleep 2
sudo systemctl --no-pager --full status visual-compare-api | head -20
REMOTE

log "deploy complete. Visit: https://$DOMAIN"
log "Healthcheck: curl -s https://$DOMAIN/healthz"
