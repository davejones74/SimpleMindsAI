#!/usr/bin/env bash
#
# Deploy SimpleMindsAI application files from this checkout to /opt/simpleminds.
#
# Default behaviour is SAFE and NON-DISRUPTIVE:
#   - sync code only (src, python/sma, scripts, package files, requirements)
#   - take a backup before changing anything
#   - never modify /etc/simpleminds/simpleminds.env or any .env file
#   - do not restart any service
#
# Restart is opt-in and requires --yes:
#   --restart-service   restart simpleminds.service
#   --restart-all       restart simpleminds.service and, ONLY if it is already
#                       active, restart simpleminds-perpetual.timer. A paused
#                       timer is left paused; it is never enabled or started.
#
# Usage:
#   ./deploy/deploy-x1pro-files.sh
#   ./deploy/deploy-x1pro-files.sh --dry-run
#   ./deploy/deploy-x1pro-files.sh --restart-service --yes
#   ./deploy/deploy-x1pro-files.sh --restart-all --yes
#
# Environment overrides:
#   SIMPLEMINDS_DEST       default /opt/simpleminds
#   SIMPLEMINDS_SERVICE    default simpleminds
#   SIMPLEMINDS_ENV_FILE   default /etc/simpleminds/simpleminds.env
#   SIMPLEMINDS_USER       default simpleminds
#
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
DEST="${SIMPLEMINDS_DEST:-/opt/simpleminds}"
SERVICE="${SIMPLEMINDS_SERVICE:-simpleminds}"
ENV_FILE="${SIMPLEMINDS_ENV_FILE:-/etc/simpleminds/simpleminds.env}"
SERVICE_USER="${SIMPLEMINDS_USER:-simpleminds}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_ROOT="${DEST}/.deploy-backup"
BACKUP_DIR="${BACKUP_ROOT}/deploy-${STAMP}"
RESTART_MODE="none"
DRY_RUN=0
RUN_NPM="auto"
VERIFY=1
ASSUME_YES=0

usage() {
  sed -n '1,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

while (($#)); do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --no-npm) RUN_NPM=0 ;;
    --npm) RUN_NPM=1 ;;
    --skip-verify) VERIFY=0 ;;
    --restart-service) RESTART_MODE="service" ;;
    --restart-all) RESTART_MODE="all" ;;
    --yes|-y) ASSUME_YES=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1 (use --help)" ;;
  esac
  shift
done

run() {
  if ((DRY_RUN)); then
    printf '+'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

require_file() {
  [[ -f "$1" ]] || die "missing required file: $1"
}

require_dir() {
  [[ -d "$1" ]] || die "missing required directory: $1"
}

require_file "${REPO_ROOT}/package.json"
require_file "${REPO_ROOT}/package-lock.json"
require_dir "${REPO_ROOT}/src"
require_dir "${REPO_ROOT}/python/sma"
require_dir "${REPO_ROOT}/scripts"
require_dir "${DEST}"
require_file "${ENV_FILE}"

if [[ -n "$(command -v git || true)" ]] && git -C "${REPO_ROOT}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  SOURCE_COMMIT="$(git -C "${REPO_ROOT}" rev-parse HEAD)"
  SOURCE_STATUS="$(git -C "${REPO_ROOT}" status --porcelain | head -n 1 || true)"
  if [[ -n "${SOURCE_STATUS}" ]]; then
    printf 'WARNING: source tree is dirty; deploying working-tree content, not a clean commit.\n' >&2
  fi
else
  SOURCE_COMMIT="unavailable"
fi

ENV_HASH_BEFORE="$(sha256sum "${ENV_FILE}" | awk '{print $1}')"

printf 'SimpleMindsAI deployment\n'
printf '  source:       %s\n' "${REPO_ROOT}"
printf '  destination:  %s\n' "${DEST}"
printf '  service:      %s\n' "${SERVICE}"
printf '  env file:     %s (will NOT be modified)\n' "${ENV_FILE}"
printf '  backup:       %s\n' "${BACKUP_DIR}"
printf '  restart:      %s\n' "${RESTART_MODE}"
printf '  dry run:      %s\n' "$([[ ${DRY_RUN} -eq 1 ]] && echo yes || echo no)"

if [[ "${RESTART_MODE}" != "none" && "${ASSUME_YES}" -ne 1 ]]; then
  die "restart requested without --yes; refusing to interrupt a running service"
fi

# ---------------------------------------------------------------- backup
if ((DRY_RUN)); then
  printf '+ mkdir -p %q\n' "${BACKUP_DIR}"
else
  sudo mkdir -p "${BACKUP_DIR}"
fi

backup_path() {
  local rel="$1"
  if [[ -e "${DEST}/${rel}" ]]; then
    run sudo mkdir -p "${BACKUP_DIR}/$(dirname "${rel}")"
    run sudo cp -a "${DEST}/${rel}" "${BACKUP_DIR}/${rel}"
  fi
}

backup_path "src"
backup_path "python/sma"
backup_path "scripts"
backup_path "package.json"
backup_path "package-lock.json"
backup_path "python/requirements.txt"
backup_path "python/requirements-cuda.txt"
backup_path "python/requirements-rocm.txt"

if ((DRY_RUN)); then
  printf '+ write %q\n' "${BACKUP_DIR}/DEPLOYMENT.txt"
else
  sudo tee "${BACKUP_DIR}/DEPLOYMENT.txt" >/dev/null <<EOF
SimpleMindsAI deployment backup
at=${STAMP}
source=${REPO_ROOT}
sourceCommit=${SOURCE_COMMIT}
sourceDirty=$([[ -n "${SOURCE_STATUS:-}" ]] && echo yes || echo no)
destination=${DEST}
service=${SERVICE}
envFile=${ENV_FILE}
envSha256=${ENV_HASH_BEFORE}
restartMode=${RESTART_MODE}
EOF
fi

# ---------------------------------------------------------------- sync code
# Explicit paths only. No .env, no data, no store, no node_modules, no models.
run sudo rsync -a --delete --chown="${SERVICE_USER}:${SERVICE_USER}" \
  --exclude '__pycache__/' --exclude '*.pyc' \
  "${REPO_ROOT}/python/sma/" "${DEST}/python/sma/"

run sudo rsync -a --delete --chown="${SERVICE_USER}:${SERVICE_USER}" \
  --exclude '.DS_Store' \
  "${REPO_ROOT}/src/" "${DEST}/src/"

run sudo rsync -a --delete --chown="${SERVICE_USER}:${SERVICE_USER}" \
  --exclude '__pycache__/' --exclude '*.pyc' \
  "${REPO_ROOT}/scripts/" "${DEST}/scripts/"

run sudo rsync -a --chown="${SERVICE_USER}:${SERVICE_USER}" \
  "${REPO_ROOT}/package.json" "${REPO_ROOT}/package-lock.json" "${DEST}/"

for req in requirements.txt requirements-cuda.txt requirements-rocm.txt; do
  if [[ -f "${REPO_ROOT}/python/${req}" ]]; then
    run sudo rsync -a --chown="${SERVICE_USER}:${SERVICE_USER}" \
      "${REPO_ROOT}/python/${req}" "${DEST}/python/${req}"
  fi
done

# --------------------------------------------------------------- node deps
OLD_LOCK_HASH=""
if [[ -f "${DEST}/package-lock.json" ]]; then
  OLD_LOCK_HASH="$(sha256sum "${DEST}/package-lock.json" | awk '{print $1}')"
fi
NEW_LOCK_HASH="$(sha256sum "${REPO_ROOT}/package-lock.json" | awk '{print $1}')"
NEED_NPM=0
if [[ ! -d "${DEST}/node_modules" ]]; then
  NEED_NPM=1
elif [[ "${OLD_LOCK_HASH}" != "${NEW_LOCK_HASH}" ]]; then
  NEED_NPM=1
fi
if [[ "${RUN_NPM}" == "0" ]]; then
  NEED_NPM=0
elif [[ "${RUN_NPM}" == "1" ]]; then
  NEED_NPM=1
fi

if ((NEED_NPM)); then
  printf 'Running npm install (package-lock changed or node_modules missing)...\n'
  run sudo -u "${SERVICE_USER}" env HOME=/var/lib/simpleminds \
    bash -c "cd $(printf '%q' "${DEST}") && npm install --omit=dev"
else
  printf 'npm install skipped (lock unchanged and node_modules present).\n'
fi

# ---------------------------------------------------------------- verify
if ((VERIFY)); then
  printf 'Verifying deployed Python CLI contract...\n'
  if ((DRY_RUN)); then
    printf '+ verify deployed sma.brain accepts --validation-policy/--require-prospective-validation\n'
  else
    (
      cd "${DEST}/python"
      "${DEST}/python/.venv/bin/python" -m sma.brain train \
        --parent v001 --corpus /tmp/simpleminds-deploy-check.jsonl \
        --lr 1e-4 --steps 1 --seq-len 32 --micro-batch 1 --grad-accum 1 \
        --warmup 1 --val-blocks 2 --eval-every 1 --document-boundary separator \
        --validation-policy document-source-disjoint \
        --require-prospective-validation --seed 0 \
        --compute-dtype float32 --device cpu --help >/tmp/simpleminds-deploy-help.txt 2>&1
      grep -q -- '--validation-policy' /tmp/simpleminds-deploy-help.txt
      grep -q -- '--require-prospective-validation' /tmp/simpleminds-deploy-help.txt
    ) || die "deployed Python CLI does not accept the required validation arguments"
  fi
fi

ENV_HASH_AFTER="$(sha256sum "${ENV_FILE}" | awk '{print $1}')"
[[ "${ENV_HASH_BEFORE}" == "${ENV_HASH_AFTER}" ]] || die "secrets env file changed unexpectedly"

if ((DRY_RUN)); then
  printf 'Dry run complete. No files were changed and no services were restarted.\n'
  exit 0
fi

# Record deployed file hashes for audit/rollback.
sudo bash -c "
  cd $(printf '%q' "${DEST}") || exit 1
  find src python/sma scripts -type f \
    ! -path '*/__pycache__/*' ! -name '*.pyc' -print0 \
    | sort -z | xargs -0 sha256sum > $(printf '%q' "${BACKUP_DIR}/DEPLOYED.sha256")
"
printf 'Deployed file hash manifest: %s\n' "${BACKUP_DIR}/DEPLOYED.sha256"

printf 'Deployment complete. Secrets env file unchanged: %s\n' "${ENV_HASH_AFTER}"
printf 'Rollback backup: %s\n' "${BACKUP_DIR}"

# ---------------------------------------------------------------- restart
if [[ "${RESTART_MODE}" == "none" ]]; then
  printf 'No service restart requested. Restart manually when ready.\n'
  exit 0
fi

printf 'WARNING: restarting %s will interrupt any in-flight job in that service.\n' "${SERVICE}"
run sudo systemctl restart "${SERVICE}"
run sudo systemctl is-active --quiet "${SERVICE}" || die "${SERVICE} did not become active"
printf 'Restarted %s.\n' "${SERVICE}"

if [[ "${RESTART_MODE}" == "all" ]]; then
  if sudo systemctl is-active --quiet simpleminds-perpetual.timer; then
    run sudo systemctl restart simpleminds-perpetual.timer
    printf 'Restarted simpleminds-perpetual.timer (it was already active).\n'
  else
    printf 'simpleminds-perpetual.timer is not active; leaving it paused (never auto-enabled).\n'
  fi
fi
