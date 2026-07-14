#!/usr/bin/env bash
# One-shot Fly.io deploy for the VidRush render worker.
# Prereqs: flyctl installed (https://fly.io/docs/flyctl/install/) and authenticated
#   (`fly auth login`  OR  export FLY_API_TOKEN=...).
# Usage:
#   cd worker && ./deploy.sh
set -euo pipefail

APP="${FLY_APP:-vidrush-render}"

cd "$(dirname "$0")"

# Keep the vendored engine in sync with app-live before shipping.
npm run sync:engine

# Create the app if it doesn't exist yet (idempotent).
if ! fly apps list 2>/dev/null | grep -q "\b${APP}\b"; then
  echo "Creating Fly app ${APP}…"
  fly apps create "${APP}"
fi

# Load secrets from .env if present (KEY=value lines), then push them to Fly.
if [ -f .env ]; then
  echo "Setting secrets from .env…"
  # shellcheck disable=SC2046
  fly secrets set $(grep -vE '^\s*#' .env | grep -E '^\s*[A-Z0-9_]+=' | sed 's/[[:space:]]*$//' | xargs) --app "${APP}" --stage
fi

echo "Deploying…"
fly deploy --app "${APP}" --remote-only

echo
echo "Done. Worker URL: https://${APP}.fly.dev"
echo "Now set these in Vercel (app-live):"
echo "  RENDER_WORKER_URL=https://${APP}.fly.dev"
echo "  RENDER_WORKER_TOKEN=<same as the worker's>"
