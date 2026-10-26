#!/usr/bin/env bash
# Deploy the training-evidence fixes and restart the data plane.
# Run as root after the source has been synced to /opt/simpleminds/src.
#
#   sudo bash /home/dave/Repositories/SimpleMindsAI/scripts/production-evidence-restart.sh
#
# It prunes only the stale v199 aggregate-only baseline cache entry, restarts the
# service and validates health. It does not touch admission state, the frontier,
# jobs, training data or the active model.
set -euo pipefail

REGISTRY_DIR=/var/lib/simpleminds/data/registry
APP_DIR=/opt/simpleminds
SERVICE=simpleminds.service

log() { printf '[evidence-deploy] %s\n' "$*"; }
fail() { printf '[evidence-deploy] ERROR: %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || fail "must run as root"
[ -f "${APP_DIR}/src/cli/eval-cache.js" ] || fail "deployed eval-cache CLI is missing"
[ -f "${APP_DIR}/src/training/eval-cache.js" ] || fail "deployed eval-cache implementation is missing"

log "stale v199 cache before"
sudo -u simpleminds env HOME=/var/lib/simpleminds \
  node "${APP_DIR}/src/cli/eval-cache.js" prune --missing-per-document --version v199 --dry-run \
  --registry-dir "$REGISTRY_DIR"

log "stopping ${SERVICE}"
systemctl stop "$SERVICE"

log "pruning stale v199 cache entry (the new key schema makes every old key unreachable anyway)"
sudo -u simpleminds env HOME=/var/lib/simpleminds \
  node "${APP_DIR}/src/cli/eval-cache.js" prune --missing-per-document --version v199 \
  --registry-dir "$REGISTRY_DIR"

log "starting ${SERVICE}"
systemctl start "$SERVICE"
for _ in $(seq 1 90); do
  if curl -fsS --max-time 2 http://127.0.0.1:4000/health >/tmp/simpleminds-evidence-health.json 2>/dev/null; then
    break
  fi
  sleep 1
done
curl -fsS --max-time 3 http://127.0.0.1:4000/health >/dev/null || fail "health check failed"
systemctl is-active --quiet "$SERVICE" || fail "${SERVICE} is not active"

log "cache status after"
sudo -u simpleminds env HOME=/var/lib/simpleminds \
  node "${APP_DIR}/src/cli/eval-cache.js" status --registry-dir "$REGISTRY_DIR"

log "health: $(cat /tmp/simpleminds-evidence-health.json)"
log "complete"
