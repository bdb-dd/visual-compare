# Scaleway deployment

Bring up `visual-compare` on Scaleway:

- **API VM** — `POP2-HC-4C-8G` (4 dedicated AMD EPYC vCPU / 8 GB), Caddy + TLS + basic auth in front of
  the Node API. SQLite + image artifacts on an attached Block Storage volume.
- **GPU VM** — `L4-1-24G`, LM Studio. Powered off by default; the API powers
  it on the first time it needs an LM verdict, and a cron job on the API VM
  powers it back off after 60 min of idle.

## Prerequisites

1. **Scaleway account** with a project, IAM API key, and quota for the GPU
   SKU you picked. The GPU quota is per-region — request it ahead of time
   if your account is fresh.
2. **`scw` CLI** authenticated locally: `brew install scw && scw init`.
   The script uses `scw info` to confirm auth before touching anything.
3. **DNS control** for the domain you'll serve from. You'll add an A
   record pointing at the API VM's public IPv4 after step 2 below.
4. **SSH keypair** for the `deploy` user on both VMs. Public key goes in
   `provision.env`; private key needs to be on whatever machine runs
   `deploy.sh`.

## Files in this directory

| Path | What it is |
| --- | --- |
| `provision.env.example` | Copy to `provision.env` and fill in. Git-ignored. |
| `cloud-init.api.yaml` | Bootstrap for the API VM. |
| `cloud-init.gpu.yaml` | Bootstrap for the GPU VM. |
| `Caddyfile.template` | Reverse proxy + static + basic auth. Rendered by `deploy.sh`. |
| `systemd/visual-compare-api.service` | Runs the Node API. |
| `systemd/lm-studio.service` | Runs LM Studio on the GPU. |
| `cron.d/lm-idle-reaper` | Cron entry; runs every 5 min on the API VM. |
| `scripts/provision.sh` | Creates Scaleway resources. Has sub-commands. |
| `scripts/deploy.sh` | Pushes code + restarts services. |
| `scripts/render-template.sh` | Internal: substitutes `__PLACEHOLDERS__`. |
| `state.env` | Generated. Captures created resource IDs. Git-ignored. |

## Bring-up

```sh
cd deploy/scaleway
cp provision.env.example provision.env
$EDITOR provision.env                  # fill in secrets, domain, model id
./scripts/provision.sh check           # sanity-check env + scw auth
./scripts/provision.sh gpu             # creates GPU instance; waits for cloud-init
./scripts/provision.sh api             # creates block volume + API instance
```

The `api` step prints the new public IP. Set the DNS A record:

```
$DOMAIN.    IN  A   <API_PUBLIC_IP>
```

When DNS propagates (`dig +short $DOMAIN` returns the IP), push code:

```sh
./scripts/deploy.sh
```

On first run, Caddy provisions a Let's Encrypt certificate (give it ~30 s).
Visit `https://$DOMAIN` — you should hit the basic-auth prompt. The
`/healthz` endpoint stays unauthenticated for uptime monitors.

Finally, power the GPU back off so it isn't billing while idle:

```sh
./scripts/provision.sh stop-gpu
```

The API will turn it back on the next time it needs a verdict.

## Verifying

```sh
# liveness (no auth)
curl -fsSL https://$DOMAIN/healthz

# authenticated (use the basic-auth creds you set in provision.env)
curl -fsSL -u $BASIC_AUTH_USER:$PASSWORD https://$DOMAIN/api/sessions

# tail the API log
ssh deploy@$API_PUBLIC_IP sudo journalctl -u visual-compare-api -f

# tail the reaper log (runs every 5 min)
ssh deploy@$API_PUBLIC_IP sudo tail -f /var/log/lm-idle-reaper.log

# inspect GPU state
./scripts/provision.sh status
```

## Updating

```sh
./scripts/deploy.sh
```

rsyncs the current checkout, re-installs deps, rebuilds, reloads Caddy,
restarts the API service. The script is safe to re-run; it only restarts
what it touched. Data on `/mnt/data` is untouched.

## Rotating secrets

Edit `provision.env` locally, then re-render the API env file on the VM:

```sh
ssh deploy@$API_PUBLIC_IP
sudoedit /etc/visual-compare/env       # change the affected line
sudo systemctl restart visual-compare-api
```

For the basic-auth password, regenerate the bcrypt hash:

```sh
ssh deploy@$API_PUBLIC_IP caddy hash-password --plaintext 'new-password'
```

Update `BASIC_AUTH_HASH` in `provision.env` and run `./scripts/deploy.sh`
again. Caddy reloads in-place — no downtime.

## Backups

The block volume holds everything that matters. Snapshot it on a schedule:

```sh
scw block snapshot create volume-id=$SCW_BLOCK_VOLUME_ID zone=$SCW_API_ZONE name=vc-$(date +%F)
```

Easiest: set up a daily cron on your laptop, or use Scaleway's Cockpit
scheduler. Restore is `scw block volume create from-snapshot=...` and
attach to a fresh API VM.

## GPU lifecycle

Normal flow:

1. API receives a request that needs the LM.
2. Preflight calls `scw instance server poweron $SCW_GPU_INSTANCE_ID` and
   polls `${LM_STUDIO_BASE_URL}/models` until the configured model is
   loaded. Typical: 60–120 s from cold.
3. The analyze call proceeds. Every successful call updates
   `/mnt/data/lm-last-use`.
4. The reaper runs every 5 min. When `now - last-use ≥ 60 min` *and* the
   instance is `running`, it issues `stop_in_place` (hypervisor-level
   halt; stops compute billing, preserves disk + IP). `poweroff` was
   tried initially and observed to leave Scaleway tasks `pending` while
   the guest ignored the ACPI signal.

Override knobs (all env, on the API VM in `/etc/visual-compare/env`):

| Var | Default | Effect |
| --- | --- | --- |
| `LM_IDLE_SHUTDOWN_MINUTES` | 60 | Idle threshold for the reaper. |
| `LM_START_TIMEOUT_SECONDS` | 360 | Max wait for `serverStart`. |
| `LM_LOAD_TIMEOUT_SECONDS` | 240 | Max wait for the model to appear. |
| `LM_POLL_INTERVAL_SECONDS` | 5 | Probe cadence during waits. |
| `LM_BACKEND=local` | `scaleway` | Disable Scaleway control entirely. |

Manual overrides:

```sh
# force the GPU on (e.g. for SSH debugging)
./scripts/provision.sh gpu        # no-op if it exists
scw instance server start $SCW_GPU_INSTANCE_ID zone=$SCW_GPU_ZONE

# force it off right now (don't wait for the reaper)
./scripts/provision.sh stop-gpu

# pause the reaper temporarily
ssh deploy@$API_PUBLIC_IP sudo systemctl stop cron
```

## Costs (rough)

Updated against Scaleway's published rates — confirm in your console.

| Item | Rate | Monthly assuming… |
| --- | --- | --- |
| POP2-HC-4C-8G (API) | ~€0.11/h always-on | ~€78 |
| Block Storage 50 GB | ~€0.075/GB/mo | ~€4 |
| L4-1-24G (GPU) | ~€0.75/h, on-demand | ~€45 (2 h/day) |
| Egress + DNS | metered | <€2 |
| **Total** | | **~€60/mo** |

If verdict throughput grows, the GPU dominates. The reaper is the cost
governor — keep `LM_IDLE_SHUTDOWN_MINUTES` low if cost matters more than
warm-start latency.

## Troubleshooting

- **`https://$DOMAIN` returns 503 "awaiting first deploy"** — cloud-init
  finished but `deploy.sh` hasn't been run yet. Run it.
- **First load of the page returns 502** — the API service is failing
  to start. `journalctl -u visual-compare-api -n 200` will show why
  (usually a missing env var or a SQLite schema mismatch).
- **LM verdicts hang for ~6 minutes then fail with "did not become
  reachable"** — the GPU instance can't reach the requested model or
  cloud-init never finished. SSH to the GPU VM (start it first with
  `provision.sh gpu` or `scw instance server start`), then
  `systemctl status lm-studio` and `journalctl -u lm-studio -n 100`.
- **Reaper never powers off the GPU** — `/var/log/lm-idle-reaper.log`
  will say which branch it took. Common causes: clock skew (check
  `timedatectl`), wrong instance id (check `/etc/visual-compare/env`),
  missing `SCW_SECRET_KEY`.
- **Caddy stuck issuing the cert** — DNS hasn't propagated yet. `dig +short`
  must return the API VM's IP from a public resolver. Caddy retries
  automatically; check `journalctl -u caddy -f`.

## What's NOT here

Carried over from the deployment plan; intentionally out of scope:

- No Terraform / IaC — `scw` CLI + state.env is enough for a single env.
- No CI/CD — `deploy.sh` is run from a developer machine. Trivial to wire
  into GitHub Actions later by checking in an SSH key as a secret.
- No multi-region / HA — single VM, single GPU, snapshot-based DR.
- No object-storage migration for images — content-addressed tree stays
  on the block volume.
- No real user accounts — basic auth only.
