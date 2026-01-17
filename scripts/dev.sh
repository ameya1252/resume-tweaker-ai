#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"

UVICORN_BIN="$BACKEND_DIR/.venv/bin/uvicorn"
PYTHON_BIN="$BACKEND_DIR/.venv/bin/python"

if [[ -x "$UVICORN_BIN" ]]; then
  BACKEND_CMD=("$UVICORN_BIN" "app.main:app" "--reload" "--port" "8000")
elif [[ -x "$PYTHON_BIN" ]]; then
  BACKEND_CMD=("$PYTHON_BIN" "-m" "uvicorn" "app.main:app" "--reload" "--port" "8000")
else
  BACKEND_CMD=("python" "-m" "uvicorn" "app.main:app" "--reload" "--port" "8000")
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
