#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"

UVICORN_BIN="$BACKEND_DIR/.venv/bin/uvicorn"
PYTHON_BIN="$BACKEND_DIR/.venv/bin/python"

if [[ ! -x "$PYTHON_BIN" ]]; then
  echo "Backend venv not found. Run: cd backend && python -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt" >&2
  exit 1
fi

if [[ -x "$UVICORN_BIN" ]]; then
  BACKEND_CMD=("$UVICORN_BIN" "app.main:app" "--reload" "--host" "0.0.0.0" "--port" "8000")
else
  BACKEND_CMD=("$PYTHON_BIN" "-m" "uvicorn" "app.main:app" "--reload" "--host" "0.0.0.0" "--port" "8000")
fi

cd "$BACKEND_DIR"
"${BACKEND_CMD[@]}" &
BACKEND_PID=$!

cleanup() {
  if kill -0 "$BACKEND_PID" >/dev/null 2>&1; then
    kill "$BACKEND_PID"
  fi
}
trap cleanup EXIT

cd "$FRONTEND_DIR"
npm run dev
