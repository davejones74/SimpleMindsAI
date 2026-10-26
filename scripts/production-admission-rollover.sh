#!/usr/bin/env bash
# One-shot, idempotent production admission rollover for the X1 Pro host.
#
# Run as root:
#   sudo bash /home/dave/Repositories/SimpleMindsAI/scripts/production-admission-rollover.sh
#
# It stops the data plane, backs up the active/legacy admission databases and
# frontier, seals a new 500-request epoch, recovers only lastError=cap frontier
# rows, updates the environment file, restarts the service and validates health.
# It never edits or deletes an existing sealed epoch.
set -euo pipefail

ADMISSION_DIR=/var/lib/simpleminds/data/gateway
FRONTIER_DIR=/var/lib/simpleminds/data/frontier
BACKUP_ROOT=/var/lib/simpleminds/backups
ENV_FILE=/etc/simpleminds/simpleminds.env
NEW_EPOCH=gateway-20261026-01
NEW_CAP=500
NEXT_EPOCH=0
SERVICE=simpleminds.service
APP_DIR=/opt/simpleminds
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
ENV_BACKUP="${ENV_FILE}.bak.rollover-${STAMP}"
SERVICE_STARTED=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --epoch) [ "$#" -ge 2 ] || { echo "--epoch requires a value" >&2; exit 2; }; NEW_EPOCH="$2"; shift 2 ;;
    --cap)   [ "$#" -ge 2 ] || { echo "--cap requires a value" >&2; exit 2; }; NEW_CAP="$2"; shift 2 ;;
    --next-epoch) NEXT_EPOCH=1; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

log() { printf '[rollover] %s\n' "$*"; }
fail() { printf '[rollover] ERROR: %s\n' "$*" >&2; exit 1; }

cleanup() {
  local rc=$?
  if [ "$rc" -ne 0 ] && [ "$SERVICE_STARTED" -eq 0 ]; then
    log "failure detected; attempting to start ${SERVICE} with the current durable state"
    systemctl start "$SERVICE" || true
  fi
  exit "$rc"
}
trap cleanup EXIT

[ "$(id -u)" -eq 0 ] || fail "must run as root"
[ -f "${APP_DIR}/src/cli/admission.js" ] || fail "deployed admission CLI is missing"
[ -f "$ENV_FILE" ] || fail "environment file is missing: $ENV_FILE"

install -d -o simpleminds -g simpleminds -m 0750 "$BACKUP_ROOT"
install -d -o simpleminds -g simpleminds -m 0750 "$ADMISSION_DIR"

log "preflight status"
sudo -u simpleminds env HOME=/var/lib/simpleminds \
  node "${APP_DIR}/src/cli/admission.js" status \
  --admission-dir "$ADMISSION_DIR" --frontier-dir "$FRONTIER_DIR"

if [ "$NEXT_EPOCH" -eq 1 ]; then
  NEW_EPOCH=$(sudo -u simpleminds env HOME=/var/lib/simpleminds \
    node "${APP_DIR}/src/cli/admission.js" status \
    --admission-dir "$ADMISSION_DIR" --frontier-dir "$FRONTIER_DIR" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["proposedNextEpoch"])')
  log "allocated next epoch ${NEW_EPOCH}"
fi

log "stopping ${SERVICE}"
systemctl stop "$SERVICE"

log "consistent admission + frontier backup"
sudo -u simpleminds env HOME=/var/lib/simpleminds \
  node "${APP_DIR}/src/cli/admission.js" backup \
  --admission-dir "$ADMISSION_DIR" --frontier-dir "$FRONTIER_DIR" --backup-root "$BACKUP_ROOT"

log "sealing ${NEW_EPOCH} with cap ${NEW_CAP}; recovering cap-rejected frontier rows"
sudo -u simpleminds env HOME=/var/lib/simpleminds \
  node "${APP_DIR}/src/cli/admission.js" rollover \
  --admission-dir "$ADMISSION_DIR" --frontier-dir "$FRONTIER_DIR" \
  --epoch "$NEW_EPOCH" --cap "$NEW_CAP" --recover-cap-rejected

log "updating ${ENV_FILE}"
cp -a "$ENV_FILE" "$ENV_BACKUP"
if grep -q '^ADMISSION_CAP_LIMIT=' "$ENV_FILE"; then
  sed -i 's/^ADMISSION_CAP_LIMIT=.*/ADMISSION_CAP_LIMIT='"$NEW_CAP"'/' "$ENV_FILE"
else
  printf '\nADMISSION_CAP_LIMIT=%s\n' "$NEW_CAP" >> "$ENV_FILE"
fi
if grep -q '^ADMISSION_CAP_EPOCH=' "$ENV_FILE"; then
  sed -i 's/^ADMISSION_CAP_EPOCH=.*/ADMISSION_CAP_EPOCH='"$NEW_EPOCH"'/' "$ENV_FILE"
else
  printf 'ADMISSION_CAP_EPOCH=%s\n' "$NEW_EPOCH" >> "$ENV_FILE"
fi
chown root:simpleminds "$ENV_FILE"
chmod 0640 "$ENV_FILE"

log "starting ${SERVICE}"
systemctl start "$SERVICE"
SERVICE_STARTED=1

for _ in $(seq 1 60); do
  if curl -fsS --max-time 2 http://127.0.0.1:4000/health >/tmp/simpleminds-rollover-health.json 2>/dev/null; then
    break
  fi
  sleep 1
done
curl -fsS --max-time 3 http://127.0.0.1:4000/health >/dev/null || fail "health check failed after restart"
systemctl is-active --quiet "$SERVICE" || fail "${SERVICE} is not active"

log "postflight status"
STATUS_JSON=$(sudo -u simpleminds env HOME=/var/lib/simpleminds \
  node "${APP_DIR}/src/cli/admission.js" status \
  --admission-dir "$ADMISSION_DIR" --frontier-dir "$FRONTIER_DIR")
printf '%s\n' "$STATUS_JSON"

python3 - "$STATUS_JSON" "$NEW_EPOCH" "$NEW_CAP" <<'PY'
import json, sys
status = json.loads(sys.argv[1])
epoch = sys.argv[2]
cap = int(sys.argv[3])
active = status.get("active") or {}
if active.get("epoch") != epoch:
    raise SystemExit(f"active epoch is {active.get('epoch')!r}, expected {epoch!r}")
if active.get("capLimit") != cap:
    raise SystemExit(f"active cap is {active.get('capLimit')!r}, expected {cap}")
if active.get("capUsed") not in (0, None) and active.get("capUsed") > cap:
    raise SystemExit(f"cap usage {active.get('capUsed')} exceeds {cap}")
if status.get("capRejectedFrontier") != 0:
    raise SystemExit(f"cap-rejected frontier rows remain: {status.get('capRejectedFrontier')}")
print("[rollover] validation OK: active epoch, cap, usage and frontier are clean")
PY

log "health: $(cat /tmp/simpleminds-rollover-health.json)"
log "environment backup: ${ENV_BACKUP}"
log "complete"
