#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if [[ ! -x .venv/bin/python ]]; then
  echo "SafeLink is not set up yet. Run ./setup.sh first." >&2
  exit 1
fi
if [[ ! -f dist/index.html ]]; then
  echo "The SafeLink frontend has not been built. Run ./setup.sh first." >&2
  exit 1
fi

export SAFELINK_AUTO_REFRESH=true
echo "SafeLink is starting at http://127.0.0.1:8000"
echo "Fresh Copernicus data will be checked after startup and every six hours."
exec .venv/bin/python -m uvicorn backend.app:app --host 127.0.0.1 --port 8000
