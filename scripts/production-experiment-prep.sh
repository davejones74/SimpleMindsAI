#!/usr/bin/env bash
# Prepare a read-only sandbox copy of the active model for regression analysis.
# This does not touch the production store, admission state, frontier or jobs.
#
#   sudo bash /home/dave/Repositories/SimpleMindsAI/scripts/production-experiment-prep.sh
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "must run as root" >&2; exit 1; }
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
ROOT="/tmp/opencode/train-regression-$STAMP"
install -d -o dave -g dave -m 0755 "$ROOT/store" "$ROOT/data"
cp -a /var/lib/simpleminds/store/v199 "$ROOT/store/v199"
if [ -d /var/lib/simpleminds/store/_reference ]; then cp -a /var/lib/simpleminds/store/_reference "$ROOT/store/_reference"; fi
cp -a /var/lib/simpleminds/store/active.json "$ROOT/store/active.json"
cp /var/lib/simpleminds/data/snapshots/dataset-20261025-007-6f5ccf99ebf9.jsonl "$ROOT/data/dataset-run214.jsonl"
cp /var/lib/simpleminds/data/evaluation/eval-002.jsonl "$ROOT/data/eval-002.jsonl"
cp /var/lib/simpleminds/data/evaluation/eval-002.manifest.json "$ROOT/data/eval-002.manifest.json"
chown -R dave:dave "$ROOT"
chmod -R u+rwX,go+rX "$ROOT"
printf '%s\n' "$ROOT" > /tmp/opencode/train-experiment-dir
chown dave:dave /tmp/opencode/train-experiment-dir
echo "$ROOT"
