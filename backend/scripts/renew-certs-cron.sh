#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ENV_FILE="$APP_DIR/.env"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

if [[ -z "${DOMAIN:-}" || -z "${LETSENCRYPT_EMAIL:-}" ]]; then
  echo "[$(date)] SSL certificate renewal skipped: DOMAIN or LETSENCRYPT_EMAIL not set in $ENV_FILE" >> "${APP_DIR}/logs/cert-renew.log" 2>&1 || true
  exit 1
fi

mkdir -p "${APP_DIR}/logs"

echo "[$(date)] Starting certificate renewal for $DOMAIN" >> "${APP_DIR}/logs/cert-renew.log"

if bash "${APP_DIR}/scripts/renew-certs.sh" >> "${APP_DIR}/logs/cert-renew.log" 2>&1; then
  echo "[$(date)] Certificate renewal completed successfully" >> "${APP_DIR}/logs/cert-renew.log"
else
  echo "[$(date)] Certificate renewal failed" >> "${APP_DIR}/logs/cert-renew.log"
  exit 1
fi
