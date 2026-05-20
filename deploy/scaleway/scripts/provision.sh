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
#   ./provision.sh start-gpu      # power an existing stopped GPU back on
#   ./provision.sh stop-gpu       # power the GPU instance off (default state)
#   ./provision.sh open-gpu-port  # allow API VM → GPU on tcp/1234 (idempotent)
#   ./provision.sh reserve-gpu-ip # capture the GPU IP id into state.env so it
#                                 #   survives instance recreation
#   ./provision.sh gpu-delete     # delete the GPU instance; preserves the IP
#                                 #   if reserve-gpu-ip was run first
#   ./provision.sh reserve-api-ip # capture the API IP id into state.env so it
#                                 #   survives instance recreation
#   ./provision.sh api-delete     # delete the API instance; preserves the IP
#                                 #   if reserve-api-ip was run first
#   ./provision.sh resize-api <type> [--dry-run]
#                                 # in-place resize the API instance to a new
#                                 # commercial-type (e.g. POP2-HC-8C-16G).
#                                 # Stops, updates commercial-type, restarts.
#                                 # Block volume + reserved IP are preserved.
#   ./provision.sh status         # print IDs + IPs
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
  if [[ "$LM_STUDIO_BASE_URL" == *"10.0.0.2"* ]]; then
    fail "LM_STUDIO_BASE_URL in $ENV_FILE is still the example placeholder (10.0.0.2). Set it to the GPU's actual IP (see: ./provision.sh gpu-ip)."
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

  # If a previous instance reserved an IP we want to reuse, attach by id;
  # otherwise let Scaleway allocate a fresh one. The id, once captured by
  # gpu-reserve-ip, survives `gpu-delete` (which we pass with-ip=false).
  local ip_arg="ip=new"
  if [ -n "${SCW_GPU_IP_ID:-}" ]; then
    ip_arg="ip=$SCW_GPU_IP_ID"
    log "reusing reserved IP id $SCW_GPU_IP_ID"
  fi

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
    "$ip_arg" \
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
  # If a previous instance reserved an IP we want to reuse, attach by id;
  # otherwise let Scaleway allocate a fresh one. The id, once captured by
  # reserve-api-ip, survives `api-delete` (which passes with-ip=false) so
  # DNS doesn't churn across instance recreations.
  local ip_arg="ip=new"
  if [ -n "${SCW_API_IP_ID:-}" ]; then
    ip_arg="ip=$SCW_API_IP_ID"
    log "reusing reserved IP id $SCW_API_IP_ID"
  fi

  log "creating API instance ($API_INSTANCE_TYPE in $SCW_API_ZONE)…"
  local id
  id="$(scw_create_id instance server create \
    type="$API_INSTANCE_TYPE" \
    image="$API_IMAGE" \
    zone="$SCW_API_ZONE" \
    project-id="$SCW_DEFAULT_PROJECT_ID" \
    cloud-init=@"$rendered" \
    additional-volumes.0="$vol_id" \
    name=visual-compare-api \
    "$ip_arg")"
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

cmd_start_gpu() {
  load_env; load_state
  [ -n "${SCW_GPU_INSTANCE_ID:-}" ] || fail "no GPU instance id in state"
  # Idempotency: skip the poweron call if the instance is already running
  # or in transition. `scw instance server start` rejects with
  # "precondition failed: server should be stopped" otherwise.
  local state
  state="$(scw instance server get "$SCW_GPU_INSTANCE_ID" zone="$SCW_GPU_ZONE" -o json | jq -r '.state // "unknown"')"
  case "$state" in
    running)
      log "GPU instance is already running; skipping poweron"
      ;;
    starting)
      log "GPU instance is already starting; waiting for it to settle"
      scw instance server wait "$SCW_GPU_INSTANCE_ID" zone="$SCW_GPU_ZONE" timeout=10m
      ;;
    stopped|"stopped in place"|archived)
      log "powering on GPU instance ${SCW_GPU_INSTANCE_ID}…"
      scw instance server start "$SCW_GPU_INSTANCE_ID" zone="$SCW_GPU_ZONE" >/dev/null
      scw instance server wait  "$SCW_GPU_INSTANCE_ID" zone="$SCW_GPU_ZONE" timeout=10m
      ;;
    *)
      fail "GPU instance is in unexpected state '$state'; refusing to act"
      ;;
  esac
  # Refresh the cached IP — stop-in-place usually preserves it but
  # snapshot/restore or migration can reassign.
  local ip
  ip="$(scw_server_ip "$SCW_GPU_INSTANCE_ID" "$SCW_GPU_ZONE")"
  if [ -n "$ip" ] && [ "${GPU_PUBLIC_IP:-}" != "$ip" ]; then
    save_state GPU_PUBLIC_IP "$ip"
  fi
  log "instance is running. lm-studio.service should auto-load the model"
  log "within ~60s — verify with: ./provision.sh wait-gpu"
}

cmd_reserve_gpu_ip() {
  load_env; load_state
  [ -n "${SCW_GPU_INSTANCE_ID:-}" ] || fail "no GPU instance id in state — run ./provision.sh gpu first"
  if [ -n "${SCW_GPU_IP_ID:-}" ]; then
    log "GPU IP already tracked: $SCW_GPU_IP_ID  (= ${GPU_PUBLIC_IP:-<unknown>})"
    return 0
  fi

  local ip_id ip_addr
  ip_id="$(scw instance server get "$SCW_GPU_INSTANCE_ID" zone="$SCW_GPU_ZONE" -o json \
    | jq -r '[.public_ip.id, ((.public_ips // []) | .[].id)] | map(select(. != null and . != "")) | .[0] // empty')"
  [ -n "$ip_id" ] || fail "GPU instance has no public IP — start it first with ./provision.sh start-gpu"
  ip_addr="$(scw_server_ip "$SCW_GPU_INSTANCE_ID" "$SCW_GPU_ZONE")"

  save_state SCW_GPU_IP_ID "$ip_id"
  log "tracked GPU IP id: $ip_id  (= $ip_addr)"
  log "next \`./provision.sh gpu-delete\` will preserve this IP (with-ip=false);"
  log "next \`./provision.sh gpu\` will re-attach it via \`ip=$ip_id\`."
}

cmd_gpu_delete() {
  load_env; load_state
  [ -n "${SCW_GPU_INSTANCE_ID:-}" ] || fail "no GPU instance id in state"

  # Decide IP-preservation policy. If SCW_GPU_IP_ID is tracked, we keep
  # the IP so the next provision can re-attach it; otherwise the IP is
  # released alongside the instance (default Scaleway behaviour).
  local with_ip="true"
  if [ -n "${SCW_GPU_IP_ID:-}" ]; then
    with_ip="false"
    log "will preserve tracked IP $SCW_GPU_IP_ID across delete"
  fi

  log "stopping GPU instance $SCW_GPU_INSTANCE_ID …"
  scw instance server stop "$SCW_GPU_INSTANCE_ID" zone="$SCW_GPU_ZONE" >/dev/null || true
  scw instance server wait "$SCW_GPU_INSTANCE_ID" zone="$SCW_GPU_ZONE" timeout=5m
  log "deleting instance (with-volumes=all with-ip=$with_ip) …"
  scw instance server delete "$SCW_GPU_INSTANCE_ID" zone="$SCW_GPU_ZONE" \
    with-volumes=all "with-ip=$with_ip" >/dev/null

  # Strip the instance-bound state but keep the IP id if we preserved it.
  sed -i.bak -E '/^(SCW_GPU_INSTANCE_ID|GPU_PUBLIC_IP)=/d' "$STATE_FILE" && rm -f "$STATE_FILE.bak"
  log "instance deleted. state.env now: "
  cat "$STATE_FILE" | sed 's/^/  /'
}

cmd_reserve_api_ip() {
  load_env; load_state
  [ -n "${SCW_API_INSTANCE_ID:-}" ] || fail "no API instance id in state — run ./provision.sh api first"
  if [ -n "${SCW_API_IP_ID:-}" ]; then
    log "API IP already tracked: $SCW_API_IP_ID  (= ${API_PUBLIC_IP:-<unknown>})"
    return 0
  fi

  local ip_id ip_addr
  ip_id="$(scw instance server get "$SCW_API_INSTANCE_ID" zone="$SCW_API_ZONE" -o json \
    | jq -r '[.public_ip.id, ((.public_ips // []) | .[].id)] | map(select(. != null and . != "")) | .[0] // empty')"
  [ -n "$ip_id" ] || fail "API instance has no public IP — is it running?"
  ip_addr="$(scw_server_ip "$SCW_API_INSTANCE_ID" "$SCW_API_ZONE")"

  save_state SCW_API_IP_ID "$ip_id"
  log "tracked API IP id: $ip_id  (= $ip_addr)"
  log "next \`./provision.sh api-delete\` will preserve this IP (with-ip=false);"
  log "next \`./provision.sh api\` will re-attach it via \`ip=$ip_id\`."
}

cmd_api_delete() {
  load_env; load_state
  [ -n "${SCW_API_INSTANCE_ID:-}" ] || fail "no API instance id in state"

  # Decide IP-preservation policy. If SCW_API_IP_ID is tracked, we keep
  # the IP so the next provision can re-attach it; otherwise the IP is
  # released alongside the instance (default Scaleway behaviour).
  local with_ip="true"
  if [ -n "${SCW_API_IP_ID:-}" ]; then
    with_ip="false"
    log "will preserve tracked IP $SCW_API_IP_ID across delete"
  fi

  log "stopping API instance $SCW_API_INSTANCE_ID …"
  scw instance server stop "$SCW_API_INSTANCE_ID" zone="$SCW_API_ZONE" >/dev/null || true
  scw instance server wait "$SCW_API_INSTANCE_ID" zone="$SCW_API_ZONE" timeout=5m
  # `with-volumes=local` deletes only the boot/root volume; SBS-managed
  # block volumes attached as additional-volumes are preserved so the
  # SQLite DB + image artifacts survive the rebuild.
  #
  # WARNING: do NOT pass `with-volumes=all` here. It deletes EVERY volume
  # attached to the instance, including the SBS data volume, irrecoverably.
  log "deleting instance (with-volumes=local with-ip=$with_ip) …"
  scw instance server delete "$SCW_API_INSTANCE_ID" zone="$SCW_API_ZONE" \
    with-volumes=local "with-ip=$with_ip" >/dev/null

  # Strip the instance-bound state but keep the IP id + block volume id.
  sed -i.bak -E '/^(SCW_API_INSTANCE_ID|API_PUBLIC_IP)=/d' "$STATE_FILE" && rm -f "$STATE_FILE.bak"
  log "instance deleted. state.env now: "
  cat "$STATE_FILE" | sed 's/^/  /'
}

cmd_resize_api() {
  load_env; load_state

  # ---- Arg parsing: positional target type + optional flags ----
  local target_type=""
  local dry_run="false"
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) dry_run="true"; shift ;;
      -h|--help)
        cat <<'EOF'
Usage: provision.sh resize-api <commercial-type> [--dry-run]

In-place resize of the API instance (visual-compare-api) to a new
Scaleway commercial type. Stops the VM, updates commercial-type via the
Scaleway API, then powers it back on. The attached block volume and any
reserved IP carry over untouched.

Example:
  ./provision.sh resize-api POP2-HC-8C-16G
  ./provision.sh resize-api POP2-HC-8C-16G --dry-run

Pre-flight verifies the target type exists in the zone and that the
instance is in a state we can act on. After pre-flight, prompts
interactively to create a pre-resize block-volume snapshot (y/n/a).
With --dry-run, exits before the prompt and any state-changing call.
EOF
        return 0
        ;;
      -*) fail "unknown flag: $1 (try --help)" ;;
      *)
        if [ -z "$target_type" ]; then target_type="$1"
        else fail "unexpected positional arg: $1"
        fi
        shift
        ;;
    esac
  done

  [ -n "$target_type" ] || fail "missing target commercial-type. Try: ./provision.sh resize-api --help"
  [ -n "${SCW_API_INSTANCE_ID:-}" ] || fail "no API instance id in state — run ./provision.sh api first"

  # ---- Pre-flight: inspect current state + validate target ----
  local server_json
  server_json="$(scw instance server get "$SCW_API_INSTANCE_ID" zone="$SCW_API_ZONE" -o json)"
  local current_type current_state
  current_type="$(printf '%s' "$server_json" | jq -r '.commercial_type')"
  current_state="$(printf '%s' "$server_json" | jq -r '.state')"

  log "instance:      $SCW_API_INSTANCE_ID (zone $SCW_API_ZONE)"
  log "current type:  $current_type"
  log "current state: $current_state"

  if [ "$current_type" = "$target_type" ]; then
    log "already at target type ($target_type); nothing to do."
    return 0
  fi

  # list-server-types returns an array of `{name, availability, cpu, ram,
  # hourly_price, …}`. Fail fast if the target isn't there at all OR if
  # Scaleway reports its availability as anything other than "available"
  # (e.g. "scarce", "shortage"), so we don't stop the VM only to discover
  # the new type can't actually be allocated.
  local type_meta
  type_meta="$(scw instance server-type list zone="$SCW_API_ZONE" -o json \
               | jq -r --arg t "$target_type" '
                   .[]
                   | select(.name == $t)
                   | [.availability, .cpu, .ram,
                      ((.hourly_price.units // 0) * 1e9 + (.hourly_price.nanos // 0)) / 1e9]
                   | @tsv')"
  if [ -z "$type_meta" ]; then
    fail "target type '$target_type' is not listed in zone $SCW_API_ZONE — see: scw instance server-type list zone=$SCW_API_ZONE"
  fi
  local availability cpu ram hourly_eur
  IFS=$'\t' read -r availability cpu ram hourly_eur <<<"$type_meta"
  if [ "$availability" != "available" ]; then
    fail "target type '$target_type' availability=$availability in zone $SCW_API_ZONE — pick a different size or zone"
  fi
  log "target type:   $target_type — cpu=$cpu ram=$((ram / 1024 / 1024 / 1024))GB hourly≈€$hourly_eur"

  if [ "$dry_run" = "true" ]; then
    log "DRY RUN — would prompt for pre-resize snapshot, then stop, update commercial-type, then start. Exiting."
    return 0
  fi

  # ---- Pre-resize snapshot prompt ----
  # Always ask. Snapshots are slow but cheap insurance; surfacing the
  # choice each time beats an opt-in flag the operator might forget.
  [ -n "${SCW_BLOCK_VOLUME_ID:-}" ] \
    || fail "SCW_BLOCK_VOLUME_ID not set in state.env — can't offer a pre-resize snapshot. Run ./provision.sh status to inspect."
  [ -t 0 ] \
    || fail "stdin is not a TTY — re-run interactively so the pre-resize snapshot prompt can be answered."

  log "pre-resize snapshot of block volume $SCW_BLOCK_VOLUME_ID?"
  log "  [y] yes   — create snapshot, wait for it to finish, then resize"
  log "  [n] no    — skip snapshot, proceed with resize"
  log "  [a] abort — exit without changing anything"
  printf '[provision] choice [y/n/a]: ' >&2
  local choice=""
  read -r choice
  case "$choice" in
    y|Y|yes)
      local snapshot_name="pre-resize-$(date +%F-%H%M%S)"
      log "creating snapshot '$snapshot_name' …"
      local snapshot_id
      snapshot_id="$(scw_create_id block snapshot create \
                       volume-id="$SCW_BLOCK_VOLUME_ID" \
                       zone="$SCW_API_ZONE" \
                       name="$snapshot_name")"
      log "snapshot id: $snapshot_id — waiting for status=available …"
      local deadline=$(( $(date +%s) + 900 ))  # 15 min cap
      while :; do
        local snap_status
        snap_status="$(scw block snapshot get "$snapshot_id" zone="$SCW_API_ZONE" -o json | jq -r '.status')"
        case "$snap_status" in
          available) log "snapshot ready."; break ;;
          error|deleting|deleted) fail "snapshot ended in status=$snap_status — aborting resize." ;;
        esac
        [ "$(date +%s)" -lt "$deadline" ] \
          || fail "snapshot did not become available within 15min (last status=$snap_status) — aborting resize."
        sleep 10
      done
      ;;
    n|N|no)
      log "skipping snapshot — proceeding with resize."
      ;;
    a|A|abort|"")
      log "aborted by user — no changes made."
      return 0
      ;;
    *)
      fail "unrecognised choice: '$choice' (expected y/n/a)"
      ;;
  esac

  # ---- Stop ----
  case "$current_state" in
    stopped|"stopped in place"|archived)
      log "instance already $current_state; skipping stop."
      ;;
    running)
      log "stopping API instance $SCW_API_INSTANCE_ID …"
      scw instance server stop "$SCW_API_INSTANCE_ID" zone="$SCW_API_ZONE" >/dev/null
      scw instance server wait "$SCW_API_INSTANCE_ID" zone="$SCW_API_ZONE" timeout=5m
      ;;
    *)
      fail "instance is in unexpected state '$current_state'; refusing to act"
      ;;
  esac

  # ---- Resize ----
  log "updating commercial-type → $target_type …"
  scw instance server update "$SCW_API_INSTANCE_ID" zone="$SCW_API_ZONE" \
    commercial-type="$target_type" >/dev/null

  # ---- Start ----
  log "powering API instance back on …"
  scw instance server start "$SCW_API_INSTANCE_ID" zone="$SCW_API_ZONE" >/dev/null
  scw instance server wait  "$SCW_API_INSTANCE_ID" zone="$SCW_API_ZONE" timeout=10m

  # Refresh public IP into state.env. With a reserved IP this should be a
  # no-op, but the assignment can shift across instance type changes in
  # some Scaleway zones; checking is cheap insurance.
  local ip
  ip="$(scw_server_ip "$SCW_API_INSTANCE_ID" "$SCW_API_ZONE")"
  if [ -n "$ip" ] && [ "${API_PUBLIC_IP:-}" != "$ip" ]; then
    save_state API_PUBLIC_IP "$ip"
  fi

  # Verify the new type is actually what the instance reports.
  local new_type
  new_type="$(scw instance server get "$SCW_API_INSTANCE_ID" zone="$SCW_API_ZONE" -o json | jq -r '.commercial_type')"
  if [ "$new_type" != "$target_type" ]; then
    fail "resize verification failed: instance reports commercial_type=$new_type (expected $target_type)"
  fi
  log "resize complete: $current_type → $new_type"
  log ""
  log "next steps (manual):"
  log "  ssh deploy@${API_PUBLIC_IP:-<unknown>}"
  log "  nproc                                                 # confirm core count"
  log "  systemctl show visual-compare-api -p MemoryMax        # confirm cgroup cap"
  log "  systemctl show visual-compare-api -p Environment | tr ' ' '\\n' | grep MAGICK_NICE"
  log "  curl -sS http://127.0.0.1:3001/healthz                # API responding"
  log "  sudo journalctl -u visual-compare-api -f              # tail for errors"
}

cmd_open_gpu_port() {
  load_env; load_state
  [ -n "${SCW_GPU_INSTANCE_ID:-}" ] || fail "no GPU instance id in state — run ./provision.sh gpu first"
  [ -n "${API_PUBLIC_IP:-}" ] || fail "no API public IP in state — run ./provision.sh api first"

  # The GPU instance might be stopped (default state) — that's fine, security
  # group rules apply at SG level regardless of instance power state. They take
  # effect on the next boot.

  local sg_id
  sg_id="$(scw instance server get "$SCW_GPU_INSTANCE_ID" zone="$SCW_GPU_ZONE" -o json \
    | jq -r '.security_group.id // empty')"
  [ -n "$sg_id" ] || fail "could not resolve security group for GPU instance $SCW_GPU_INSTANCE_ID"

  local sg_name
  sg_name="$(scw instance security-group get "$sg_id" zone="$SCW_GPU_ZONE" -o json \
    | jq -r '.name // .security_group.name // "(unknown)"')"
  log "GPU instance is in security group: $sg_name ($sg_id)"

  # Heads-up if it's the project's default SG: any rule added here applies to
  # every instance that shares this SG. Acceptable for a single-app project,
  # noisy in a shared one.
  if [[ "$sg_name" == "Default security group" ]]; then
    log "note: this is the project-wide default SG. The rule will apply to all instances that use it."
  fi

  local cidr="${API_PUBLIC_IP}/32"

  # Idempotency: check for an equivalent existing rule before creating.
  # `list-rules` returns a bare array of rule objects.
  local existing
  existing="$(scw instance security-group list-rules security-group-id="$sg_id" zone="$SCW_GPU_ZONE" -o json \
    | jq -r --arg ip "$cidr" '
        .[]?
        | select(
            .direction == "inbound"
            and (.protocol | ascii_upcase) == "TCP"
            and .dest_port_from == 1234
            and .ip_range == $ip
          )
        | .id' | head -1)"
  if [ -n "$existing" ] && [ "$existing" != "null" ]; then
    log "rule already exists ($existing) — nothing to do."
    return 0
  fi

  log "adding inbound rule: TCP 1234 from ${cidr} on SG ${sg_id}…"
  scw instance security-group create-rule \
    security-group-id="$sg_id" \
    zone="$SCW_GPU_ZONE" \
    direction=inbound \
    action=accept \
    protocol=TCP \
    dest-port-from=1234 \
    ip-range="$cidr" >/dev/null
  log "rule added. API VM ($API_PUBLIC_IP) can now reach the GPU on port 1234."
  log "to undo: scw instance security-group delete-rule security-group-id=$sg_id <rule-id> zone=$SCW_GPU_ZONE"
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
    start-gpu)      shift; cmd_start_gpu      "$@" ;;
    stop-gpu)       shift; cmd_stop_gpu       "$@" ;;
    open-gpu-port)  shift; cmd_open_gpu_port  "$@" ;;
    reserve-gpu-ip) shift; cmd_reserve_gpu_ip "$@" ;;
    gpu-delete)     shift; cmd_gpu_delete     "$@" ;;
    reserve-api-ip) shift; cmd_reserve_api_ip "$@" ;;
    api-delete)     shift; cmd_api_delete     "$@" ;;
    resize-api)     shift; cmd_resize_api     "$@" ;;
    status)    shift; cmd_status    "$@" ;;
    "")        sed -n '2,30p' "$0" ;;
    *)         fail "unknown subcommand: $sub" ;;
  esac
}

main "$@"
