#!/usr/bin/env bash
# Provision Scaleway resources for visual-compare.
#
# This script is *not* fully idempotent — it creates resources and
# captures their IDs into `state.env`. If a step fails partway through,
# inspect `state.env`, finish the affected resource manually via
# `scw`/console, and re-run the remaining subcommands. The script is
# structured as sub-commands so you can re-run pieces:
#
#   ./provision.sh check        # verify env + scw config + ssh key
#   ./provision.sh gpu          # create the GPU instance
#   ./provision.sh gpu-ip       # print the GPU's current public IP
#   ./provision.sh wait-gpu     # tail cloud-init on the GPU over ssh
#   ./provision.sh api          # create API instance + block volume
#   ./provision.sh wait-api     # tail cloud-init on the API over ssh
#   ./provision.sh stop-gpu     # power the GPU instance off (default state)
#   ./provision.sh status       # print IDs + IPs
#
# All required secrets / parameters come from `provision.env` in this
# directory. See `provision.env.example` for the shape.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$HERE/.." && pwd)"
STATE_FILE="$DEPLOY_DIR/state.env"
ENV_FILE="$DEPLOY_DIR/provision.env"

log() { printf '[provision] %s\n' "$*" >&2; }
fail() { log "ERROR: $*"; exit 1; }

# Read the server's public IPv4. Scaleway moved from `public_ip` (singular
# object, legacy "Nat IP" instances) to `public_ips[]` (array, routed-IP
# era). New L4 GPU instances only populate the array. Return the first
# IPv4 found in either, or empty if there is none.
scw_server_ip() {
  local server_id="$1" zone="$2"
  scw instance server get "$server_id" zone="$zone" -o json \
    | jq -r '
        [.public_ip.address, ((.public_ips // []) | .[].address)]
        | map(select(. != null and test("^[0-9.]+$")))
        | .[0] // empty'
}

# Run `scw ... -o json` and return only the id field. If scw fails OR the
# response doesn't contain a UUID-looking id, abort with the raw output
# so the IAM / quota / arg error is visible instead of being captured
# silently into $id and persisted as "null".
scw_create_id() {
  local raw
  if ! raw="$(scw "$@" -o json 2>&1)"; then
    fail "scw $1 $2 failed:"$'\n'"$raw"
  fi
  local id
  id="$(printf '%s' "$raw" | jq -r 'if type=="object" and has("id") then .id else "null" end')"
  if [[ ! "$id" =~ ^[0-9a-f-]{36}$ ]]; then
    fail "scw $1 $2 did not return a usable id. Raw response:"$'\n'"$raw"
  fi
  printf '%s' "$id"
}

load_env() {
  [ -f "$ENV_FILE" ] || fail "missing $ENV_FILE — copy provision.env.example and fill it in"
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE"; set +a
  # SCW_ACCESS_KEY / SCW_SECRET_KEY / SCW_DEFAULT_PROJECT_ID /
  # SCW_DEFAULT_ORGANIZATION_ID are the canonical names the `scw` CLI and
  # Scaleway SDKs read directly — sourcing provision.env above is enough
  # to authenticate `scw` without further re-exporting.
  for v in SCW_ACCESS_KEY SCW_SECRET_KEY SCW_DEFAULT_PROJECT_ID \
           SCW_DEFAULT_ORGANIZATION_ID SCW_GPU_ZONE SCW_API_ZONE \
           DOMAIN ACME_EMAIL BASIC_AUTH_USER BASIC_AUTH_HASH \
           LM_STUDIO_MODEL DEPLOY_SSH_KEY \
           GPU_INSTANCE_TYPE GPU_IMAGE GPU_ROOT_VOLUME_SIZE_GB \
           API_INSTANCE_TYPE API_IMAGE \
           BLOCK_VOLUME_SIZE_GB; do
    [ -n "${!v:-}" ] || fail "$v is not set in $ENV_FILE"
  done
  # Reject placeholder values left over from provision.env.example. These
  # would otherwise be silently embedded into cloud-init and burned onto
  # the VM (e.g. "ssh-ed25519 AAAA... your-key" becoming the deploy
  # user's authorized_keys — locking you out without a clear error).
  if [[ "$DEPLOY_SSH_KEY" == *"AAAA... your-key"* ]]; then
    fail "DEPLOY_SSH_KEY in $ENV_FILE is still the example placeholder. Set it to a real SSH public key."
  fi
  if ! printf '%s' "$DEPLOY_SSH_KEY" | grep -qE '^(ssh-ed25519|ssh-rsa|ecdsa-sha2-) '; then
    fail "DEPLOY_SSH_KEY in $ENV_FILE doesn't look like an OpenSSH public key (must start with ssh-ed25519 / ssh-rsa / ecdsa-sha2-…)."
  fi
  if [[ "$BASIC_AUTH_HASH" == *"REPLACE_ME"* ]]; then
    fail "BASIC_AUTH_HASH in $ENV_FILE is still the example placeholder. Generate one with: caddy hash-password --plaintext 'your-password'"
  fi
}

load_state() {
  if [ -f "$STATE_FILE" ]; then
    # shellcheck disable=SC1090
    set -a; . "$STATE_FILE"; set +a
  fi
}

save_state() {
  local key="$1" val="$2"
  touch "$STATE_FILE"
  # Replace any existing assignment for this key, else append.
  if grep -q "^${key}=" "$STATE_FILE"; then
    sed -i.bak "s|^${key}=.*|${key}=${val}|" "$STATE_FILE" && rm -f "$STATE_FILE.bak"
  else
    printf '%s=%s\n' "$key" "$val" >> "$STATE_FILE"
  fi
  log "saved $key=$val"
}

cmd_check() {
  load_env
  command -v scw >/dev/null || fail "scw CLI not found on PATH (https://github.com/scaleway/scaleway-cli)"
  scw info >/dev/null 2>&1 || fail "scw is not authenticated — run \`scw init\` or ensure SCW_ACCESS_KEY/SCW_SECRET_KEY are set"
  log "scw OK; project=$SCW_DEFAULT_PROJECT_ID"
  log "domain=$DOMAIN  api-zone=$SCW_API_ZONE  gpu-zone=$SCW_GPU_ZONE"
}

cmd_gpu() {
  load_env; load_state
  if [ -n "${SCW_GPU_INSTANCE_ID:-}" ]; then
    log "GPU instance already provisioned ($SCW_GPU_INSTANCE_ID); skipping"
    return 0
  fi

  local rendered
  rendered="$(mktemp -t cloud-init-gpu.XXXXXX.yaml)"
  trap "rm -f '$rendered'" RETURN

  "$HERE/render-template.sh" "$DEPLOY_DIR/cloud-init.gpu.yaml" \
    "DEPLOY_SSH_KEY=$DEPLOY_SSH_KEY" \
    "LM_STUDIO_MODEL=$LM_STUDIO_MODEL" \
    "API_VM_PRIVATE_IP=${API_VM_PRIVATE_IP:-0.0.0.0/0}" \
    "SYSTEMD_LM_UNIT_B64=$(base64 < "$DEPLOY_DIR/systemd/lm-studio.service" | tr -d '\n')" \
    > "$rendered"

  log "creating GPU instance ($GPU_INSTANCE_TYPE root=${GPU_ROOT_VOLUME_SIZE_GB}GB in $SCW_GPU_ZONE)…"
  local id
  # ip=new is explicit on purpose. Without it scw may default to no
  # public IPv4 depending on instance type, which leaves cloud-init
  # unable to fetch LM Studio + the model from the internet. The IP
  # stays attached across stop/start cycles (we use "stop in place").
  #
  # root-volume overrides the image's default boot disk. Format is
  # `<type>:<size>` (e.g. sbs:100GB). The L40S SKU doesn't permit local
  # root volumes ("local volume size must be 0 B"), so we use `sbs`
  # (Scaleway Block Storage). The default size in provision.env is
  # 100 GB — large enough for OS + LM Studio + multi-quant model files
  # without recurrences of the 18 GB disk-full failure we hit earlier.
  id="$(scw_create_id instance server create \
    type="$GPU_INSTANCE_TYPE" \
    image="$GPU_IMAGE" \
    zone="$SCW_GPU_ZONE" \
    project-id="$SCW_DEFAULT_PROJECT_ID" \
    cloud-init=@"$rendered" \
    name=visual-compare-lm \
    ip=new \
    root-volume="sbs:${GPU_ROOT_VOLUME_SIZE_GB}GB")"
  save_state SCW_GPU_INSTANCE_ID "$id"
  log "GPU instance created: $id"
  log "waiting for instance state to settle (typically <90s)…"
  scw instance server wait "$id" zone="$SCW_GPU_ZONE" timeout=10m
  local gpu_ip
  gpu_ip="$(scw_server_ip "$id" "$SCW_GPU_ZONE")"
  if [ -n "$gpu_ip" ]; then
    save_state GPU_PUBLIC_IP "$gpu_ip"
  fi
  log "instance is running. Cloud-init continues in the background — model"
  log "download alone can take 10–15 min. Tail it with:"
  log "  ./provision.sh wait-gpu"
  log "Then verify the model is loaded:"
  log "  ssh deploy@${gpu_ip:-<gpu-public-ip>} systemctl status lm-studio"
}

cmd_gpu_ip() {
  load_env; load_state
  [ -n "${SCW_GPU_INSTANCE_ID:-}" ] || fail "no GPU instance id in state — run ./provision.sh gpu first"
  # Always re-fetch rather than trust state.env, since a stop/start cycle
  # on Scaleway can change the assigned public IP.
  local ip
  ip="$(scw_server_ip "$SCW_GPU_INSTANCE_ID" "$SCW_GPU_ZONE")"
  [ -n "$ip" ] || fail "GPU instance has no public IP (state may be stopped)"
  if [ "${GPU_PUBLIC_IP:-}" != "$ip" ]; then
    save_state GPU_PUBLIC_IP "$ip"
  fi
  printf '%s\n' "$ip"
}

cmd_wait_gpu() {
  load_env; load_state
  local ip
  ip="$(cmd_gpu_ip)"
  log "tailing cloud-init on deploy@$ip (Ctrl-C to detach)…"
  ssh -o StrictHostKeyChecking=accept-new "deploy@${ip}" \
    "sudo tail -f /var/log/cloud-init-output.log"
}

cmd_api() {
  load_env; load_state
  if [ -n "${SCW_API_INSTANCE_ID:-}" ]; then
    log "API instance already provisioned ($SCW_API_INSTANCE_ID); skipping"
    return 0
  fi
  [ -n "${SCW_GPU_INSTANCE_ID:-}" ] || fail "create the GPU instance first: ./provision.sh gpu"

  # ---- Block volume for persistent state ----
  local vol_id
  if [ -z "${SCW_BLOCK_VOLUME_ID:-}" ]; then
    log "creating ${BLOCK_VOLUME_SIZE_GB}G block volume in ${SCW_API_ZONE}…"
    vol_id="$(scw_create_id block volume create \
      zone="$SCW_API_ZONE" \
      project-id="$SCW_DEFAULT_PROJECT_ID" \
      from-empty.size="${BLOCK_VOLUME_SIZE_GB}GB" \
      perf-iops=5000 \
      name=visual-compare-data)"
    save_state SCW_BLOCK_VOLUME_ID "$vol_id"
  else
    vol_id="$SCW_BLOCK_VOLUME_ID"
    log "reusing existing block volume $vol_id"
  fi

  # ---- Cloud-init with substitutions ----
  local rendered
  rendered="$(mktemp -t cloud-init-api.XXXXXX.yaml)"
  trap "rm -f '$rendered'" RETURN

  "$HERE/render-template.sh" "$DEPLOY_DIR/cloud-init.api.yaml" \
    "DEPLOY_SSH_KEY=$DEPLOY_SSH_KEY" \
    "LM_STUDIO_BASE_URL=$LM_STUDIO_BASE_URL" \
    "LM_STUDIO_MODEL=$LM_STUDIO_MODEL" \
    "SCW_GPU_ZONE=$SCW_GPU_ZONE" \
    "SCW_GPU_INSTANCE_ID=$SCW_GPU_INSTANCE_ID" \
    "SCW_SECRET_KEY=$SCW_SECRET_KEY" \
    "SYSTEMD_API_UNIT_B64=$(base64 < "$DEPLOY_DIR/systemd/visual-compare-api.service" | tr -d '\n')" \
    "CRON_REAPER_B64=$(base64 < "$DEPLOY_DIR/cron.d/lm-idle-reaper" | tr -d '\n')" \
    > "$rendered"

  # ---- API instance with block volume attached ----
  log "creating API instance ($API_INSTANCE_TYPE in $SCW_API_ZONE)…"
  local id
  id="$(scw_create_id instance server create \
    type="$API_INSTANCE_TYPE" \
    image="$API_IMAGE" \
    zone="$SCW_API_ZONE" \
    project-id="$SCW_DEFAULT_PROJECT_ID" \
    cloud-init=@"$rendered" \
    additional-volumes.0=block:"$vol_id" \
    name=visual-compare-api \
    ip=new)"
  save_state SCW_API_INSTANCE_ID "$id"

  scw instance server wait "$id" zone="$SCW_API_ZONE" timeout=10m
  local ip
  ip="$(scw_server_ip "$id" "$SCW_API_ZONE")"
  save_state API_PUBLIC_IP "$ip"
  log "API instance created: $id  public-ip=$ip"
  log "Set DNS A record: $DOMAIN -> $ip"
  log "Then run: ./provision.sh wait-api  (tails cloud-init via ssh)"
}

cmd_wait_api() {
  load_env; load_state
  [ -n "${API_PUBLIC_IP:-}" ] || fail "API_PUBLIC_IP not in state — run ./provision.sh api first"
  log "tailing cloud-init on deploy@$API_PUBLIC_IP (Ctrl-C to detach)…"
  ssh -o StrictHostKeyChecking=accept-new "deploy@${API_PUBLIC_IP}" \
    "sudo tail -f /var/log/cloud-init-output.log"
}

cmd_stop_gpu() {
  load_env; load_state
  [ -n "${SCW_GPU_INSTANCE_ID:-}" ] || fail "no GPU instance id in state"
  log "powering off GPU instance ${SCW_GPU_INSTANCE_ID}…"
  scw instance server stop "$SCW_GPU_INSTANCE_ID" zone="$SCW_GPU_ZONE" >/dev/null
  log "stopped. The API will power it on again on the next LM request."
}

cmd_status() {
  load_env; load_state
  printf '%-32s %s\n' GPU_INSTANCE "${SCW_GPU_INSTANCE_ID:-<unset>}"
  printf '%-32s %s\n' GPU_ZONE "$SCW_GPU_ZONE"
  printf '%-32s %s\n' API_INSTANCE "${SCW_API_INSTANCE_ID:-<unset>}"
  printf '%-32s %s\n' API_ZONE "$SCW_API_ZONE"
  printf '%-32s %s\n' API_PUBLIC_IP "${API_PUBLIC_IP:-<unset>}"
  printf '%-32s %s\n' BLOCK_VOLUME "${SCW_BLOCK_VOLUME_ID:-<unset>}"
  printf '%-32s %s\n' DOMAIN "$DOMAIN"
  if [ -n "${SCW_GPU_INSTANCE_ID:-}" ]; then
    local state
    state="$(scw instance server get "$SCW_GPU_INSTANCE_ID" zone="$SCW_GPU_ZONE" -o json | jq -r .state)"
    printf '%-32s %s\n' GPU_STATE "$state"
  fi
}

main() {
  local sub="${1:-}"
  case "$sub" in
    check)     shift; cmd_check     "$@" ;;
    gpu)       shift; cmd_gpu       "$@" ;;
    gpu-ip)    shift; cmd_gpu_ip    "$@" ;;
    wait-gpu)  shift; cmd_wait_gpu  "$@" ;;
    api)       shift; cmd_api       "$@" ;;
    wait-api)  shift; cmd_wait_api  "$@" ;;
    stop-gpu)  shift; cmd_stop_gpu  "$@" ;;
    status)    shift; cmd_status    "$@" ;;
    "")        sed -n '2,30p' "$0" ;;
    *)         fail "unknown subcommand: $sub" ;;
  esac
}

main "$@"
