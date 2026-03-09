#!/usr/bin/env bash
# init-tls.sh — one-time TLS bootstrapper for Layne.
#
# Run this once on a fresh server before `docker compose up -d`.
# It places a self-signed dummy cert so nginx can start, obtains a real
# certificate from Let's Encrypt, then reloads nginx.
#
# Usage:
#   chmod +x scripts/init-tls.sh
#   ./scripts/init-tls.sh

set -euo pipefail

# ── Load environment ──────────────────────────────────────────────────────────
if [ -f .env ]; then
  # Export only DOMAIN and LETSENCRYPT_EMAIL from .env
  set -o allexport
  # shellcheck disable=SC1091
  source <(grep -E '^(DOMAIN|LETSENCRYPT_EMAIL)=' .env)
  set +o allexport
fi

: "${DOMAIN:?DOMAIN must be set in .env}"
: "${LETSENCRYPT_EMAIL:?LETSENCRYPT_EMAIL must be set in .env}"

CERT_DIR="./data/certbot/certs/live/${DOMAIN}"
WWW_DIR="./data/certbot/www"

# ── Step 1: Create directories ────────────────────────────────────────────────
mkdir -p "${CERT_DIR}" "${WWW_DIR}"

# ── Step 2: Create a dummy self-signed cert so nginx can start ────────────────
echo "Generating dummy certificate for ${DOMAIN}…"
openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
  -keyout "${CERT_DIR}/privkey.pem" \
  -out    "${CERT_DIR}/fullchain.pem" \
  -subj   "/CN=${DOMAIN}" 2>/dev/null

# Create the symlink nginx.conf references (/etc/letsencrypt/live/layne)
(cd ./data/certbot/certs/live && ln -sfn "${DOMAIN}" layne)

# ── Step 3: Start nginx with the dummy cert ───────────────────────────────────
echo "Starting nginx…"
docker compose up -d nginx

echo "Waiting for nginx to be ready…"
sleep 3

# ── Step 4: Remove the dummy cert so Certbot can create its own directory ────
echo "Removing dummy certificate…"
rm -rf "${CERT_DIR}"

# ── Step 5 (was 4): Obtain a real certificate from Let's Encrypt ──────────────
echo "Requesting certificate from Let's Encrypt…"
docker compose run --rm certbot certonly \
  --webroot \
  --webroot-path /var/www/certbot \
  --email "${LETSENCRYPT_EMAIL}" \
  --agree-tos \
  --no-eff-email \
  -d "${DOMAIN}"

# ── Step 6: Update the symlink to point at the new cert ──────────────────────
# Certbot may append -0001, -0002, etc. if the directory already existed.
# Find the actual directory it created (most recently modified match).
LIVE_DIR=$(ls -dt ./data/certbot/certs/live/"${DOMAIN}"* 2>/dev/null | head -1 | xargs basename)
if [ -z "${LIVE_DIR}" ]; then
  echo "ERROR: No certbot live directory found for ${DOMAIN}" >&2
  exit 1
fi
echo "Linking layne → ${LIVE_DIR}"
(cd ./data/certbot/certs/live && ln -sfn "${LIVE_DIR}" layne)

# ── Step 7: Reload nginx to pick up the real certificate ─────────────────────
echo "Reloading nginx…"
docker compose exec nginx nginx -s reload

echo ""
echo "TLS setup complete. Start all services with:"
echo "  docker compose up -d"
