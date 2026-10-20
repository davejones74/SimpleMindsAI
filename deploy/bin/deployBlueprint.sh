#!/usr/bin/bash
set -euo pipefail

sudo -u simpleminds env \
  HOME=/var/lib/simpleminds \
  SMA_STORE=/var/lib/simpleminds/store \
  SMA_PYTHON=/opt/simpleminds/python/.venv/bin/python \
  SMA_BLUEPRINT=/var/lib/simpleminds/data/visualisation/brain-blueprint.json \
  bash -c 'cd /opt/simpleminds && npm run blueprint'
