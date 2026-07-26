#!/usr/bin/env bash
set -euo pipefail

DOMAIN="${DOMAIN:-${SSL_DOMAIN:-}}"
EMAIL="${LETSENCRYPT_EMAIL:-${EMAIL:-}}"
CERT_DIR="${CERT_DIR:-${CERT_PATH:-$(cd "$(dirname "$0")/.." && pwd)/certs}}"
LIVE_DIR="/etc/letsencrypt/live/${DOMAIN}"

if [[ -z "$DOMAIN" || -z "$EMAIL" ]]; then
  echo "DOMAIN and LETSENCRYPT_EMAIL must be set before renewing certificates." >&2
  exit 1
fi

mkdir -p "$CERT_DIR"

if ! command -v certbot >/dev/null 2>&1; then
  echo "Error: certbot is not installed. Install via: sudo apt-get install certbot (Linux) or brew install certbot (macOS)" >&2
  exit 1
fi

echo "Attempting certificate renewal for domain: $DOMAIN"

if certbot renew --non-interactive --agree-tos --quiet 2>/dev/null; then
  echo "Certificate renewed successfully."
elif certbot certonly --standalone --non-interactive --agree-tos -m "$EMAIL" -d "$DOMAIN" 2>/dev/null; then
  echo "Initial certificate obtained successfully."
else
  echo "Error: Failed to obtain/renew certificate. Ensure:" >&2
  echo "  1. Domain $DOMAIN points to this server's IP" >&2
  echo "  2. Port 80 is accessible and not blocked" >&2
  echo "  3. No other service is running on port 80" >&2
  exit 1
fi

if [[ -f "$LIVE_DIR/fullchain.pem" && -f "$LIVE_DIR/privkey.pem" ]]; then
  cp "$LIVE_DIR/fullchain.pem" "$CERT_DIR/fullchain.pem"
  cp "$LIVE_DIR/privkey.pem" "$CERT_DIR/privkey.pem"
fi

if [[ -f "$CERT_DIR/fullchain.pem" && -f "$CERT_DIR/privkey.pem" ]]; then
  echo "Certificates renewed successfully."
else
  echo "Expected certificate files were not created." >&2
  exit 1
fi
