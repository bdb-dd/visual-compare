#!/usr/bin/env bash
# Container entrypoint: load /config/.env if present, ensure /data is
# writable, then exec the supervisor (passed as CMD).
set -euo pipefail

CONFIG_ENV="${CONFIG_ENV_PATH:-/config/.env}"
if [ -f "$CONFIG_ENV" ]; then
  # Export every assignment in the file so child processes started by
  # supervisord inherit them. `set -a` auto-exports until `set +a`.
  set -a
  # shellcheck disable=SC1090
  . "$CONFIG_ENV"
  set +a
  echo "[entrypoint] loaded env from $CONFIG_ENV"
else
  echo "[entrypoint] no env file at $CONFIG_ENV (skipping)"
fi

# Defaults — also set in the Dockerfile, repeated here so they survive
# even if a user clobbers the image ENV at runtime.
: "${DB_PATH:=/data/visual-compare.sqlite}"
: "${IMAGES_DIR:=/data/images}"
: "${LM_LAST_USE_PATH:=/data/lm-last-use}"
: "${PORT:=3001}"
: "${LISTEN_HOST:=127.0.0.1}"
: "${LM_BACKEND:=none}"
export DB_PATH IMAGES_DIR LM_LAST_USE_PATH PORT LISTEN_HOST LM_BACKEND

# `mkdir -p` is idempotent; runs every start so a fresh /data mount works.
mkdir -p "$(dirname "$DB_PATH")" "$IMAGES_DIR" "$(dirname "$LM_LAST_USE_PATH")"

echo "[entrypoint] DB_PATH=$DB_PATH"
echo "[entrypoint] IMAGES_DIR=$IMAGES_DIR"
echo "[entrypoint] LM_BACKEND=$LM_BACKEND LM_STUDIO_BASE_URL=${LM_STUDIO_BASE_URL:-<unset>} LM_STUDIO_MODEL=${LM_STUDIO_MODEL:-<unset>}"

exec "$@"
