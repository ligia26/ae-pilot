#!/bin/sh
# Prints a fresh Corti access token (OAuth2 client credentials) — nothing else.
# Reads CORTI_TENANT_NAME / CORTI_CLIENT_ID / CORTI_CLIENT_SECRET / CORTI_ENVIRONMENT from .env.local.
# Used by the copilot via CORTI_TOKEN_CMD="sh scripts/get-token.sh" to refresh tokens (~5 min lifetime).
cd "$(dirname "$0")/.." || exit 1
set -a; [ -f .env.local ] && . ./.env.local; set +a
curl -s -X POST "https://auth.${CORTI_ENVIRONMENT:-eu}.corti.app/realms/${CORTI_TENANT_NAME:-base}/protocol/openid-connect/token" \
  --data-urlencode grant_type=client_credentials --data-urlencode scope=openid \
  --data-urlencode "client_id=${CORTI_CLIENT_ID}" --data-urlencode "client_secret=${CORTI_CLIENT_SECRET}" \
  | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p'
