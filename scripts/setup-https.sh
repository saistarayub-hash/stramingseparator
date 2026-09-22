#!/usr/bin/env bash
# ==============================================================================
#  StreamPilot — free HTTPS + custom domain (DuckDNS + Caddy)
#  ----------------------------------------------------------
#  Turns http://<ip>:8787 into https://YOURNAME.duckdns.org — for free, with
#  automatic LetsEncrypt TLS, no config files to hand-edit.
#
#  Prerequisites:
#    · run scripts/setup-vps.sh first (the app is in /opt/streampilot)
#    · a free DuckDNS account with your subdomain ALREADY added at
#      https://www.duckdns.org (Deposit → create the domain)
#
#  Usage (as root):
#    export SP_DUCK_DOMAIN="yourname"       # subdomain only (no .duckdns.org)
#    export SP_DUCK_TOKEN="xxxxxxxx-xxxx"   # from the DuckDNS page
#    bash scripts/setup-https.sh            # or the curl | bash one-liner below
#
#  After it finishes: https://yourname.duckdns.org is live, the app's APP_URL
#  + YouTube OAuth redirect are updated, and DNS auto-refreshes every 5 min.
# ==============================================================================
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Run as root: sudo bash $0" >&2; exit 1; }

APP_DIR="${APP_DIR:-/opt/streampilot}"
DOMAIN="${SP_DUCK_DOMAIN:-}"
TOKEN="${SP_DUCK_TOKEN:-}"
log()  { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m⚠ %s\033[0m\n' "$*"; }

# ---------------------------------------------------------------- inputs
if [ -z "${DOMAIN}" ]; then read -rp "DuckDNS subdomain (e.g. mystream): " DOMAIN; fi
if [ -z "${TOKEN}" ];  then read -rsp "DuckDNS token: " TOKEN; echo; fi
DOMAIN="$(echo "${DOMAIN}" | tr 'A-Z' 'a-z' | sed 's|https\?://||; s|/.*||; s|\.duckdns\.org$||')"
[ -n "${DOMAIN}" ] || { echo "No domain given." >&2; exit 1; }
FULL="${DOMAIN}.duckdns.org"
log "Setting up https://${FULL}"

# ---------------------------------------------------------------- public IP
IP="$(curl -fsS -m 10 https://api.ipify.org 2>/dev/null || curl -fsS -m 10 https://ifconfig.me 2>/dev/null || echo "")"

# ---------------------------------------------------------------- duckdns update
log "Pointing ${FULL} → ${IP:-auto-detected} on DuckDNS…"
mkdir -p "${APP_DIR}/duckdns"
printf '%s' "${TOKEN}" > "${APP_DIR}/duckdns/token"
chmod 600 "${APP_DIR}/duckdns/token"

cat > "${APP_DIR}/duckdns/update.sh" <<EOF
#!/bin/sh
# Auto-refresh DuckDNS (every 5 min via cron). DuckDNS detects our public IP.
TOKEN="\$(cat ${APP_DIR}/duckdns/token)"
curl -fsS "https://www.duckdns.org/update?domains=${DOMAIN}&token=\${TOKEN}" >/dev/null 2>&1 || true
EOF
chmod 700 "${APP_DIR}/duckdns/update.sh"

# one immediate update (with explicit IP when we have it)
RESP="$(curl -fsS -m 15 "https://www.duckdns.org/update?domains=${DOMAIN}&token=${TOKEN}${IP:+&ip=${IP}}" || true)"
if [ "${RESP}" != "OK" ]; then
  warn "DuckDNS update returned '${RESP:-nothing}' — check the token and that the subdomain is added at duckdns.org."
else
  log "DuckDNS updated: ${RESP}"
fi

# ---------------------------------------------------------------- cron (keep IP fresh)
cat > /etc/cron.d/streampilot-duckdns <<EOF
*/5 * * * * root ${APP_DIR}/duckdns/update.sh >/dev/null 2>&1
EOF
log "DNS auto-refresh cron installed (every 5 min)."

# ---------------------------------------------------------------- caddy
if ! command -v caddy >/dev/null 2>&1; then
  log "Installing Caddy…"
  if apt-get install -y caddy >/dev/null 2>&1; then
    :
  else
    log "apt path failed — installing Caddy binary directly…"
    ARCH="$(dpkg --print-architecture)"
    [ "${ARCH}" = "amd64" ] || [ "${ARCH}" = "arm64" ] || ARCH="amd64"
    curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=${ARCH}" -o /usr/bin/caddy
    chmod 755 /usr/bin/caddy
  fi
fi

# ---------------------------------------------------------------- caddyfile
mkdir -p /etc/caddy
cat > /etc/caddy/Caddyfile <<EOF
${FULL} {
    reverse_proxy 127.0.0.1:8787
}
EOF
log "Caddyfile written for ${FULL}."

systemctl enable caddy >/dev/null 2>&1 || true
if systemctl is-active --quiet caddy 2>/dev/null; then
  systemctl reload caddy
else
  systemctl start caddy
fi

# ---------------------------------------------------------------- firewall (incl. Oracle iptables gotcha)
if command -v ufw >/dev/null 2>&1; then
  ufw allow 80/tcp  >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
fi
if command -v iptables >/dev/null 2>&1; then
  # Oracle's Ubuntu image ships its own iptables rules that block these ports.
  for P in 80 443; do
    iptables -C INPUT -p tcp --dport "${P}" -j ACCEPT 2>/dev/null || \
      iptables -I INPUT 1 -p tcp --dport "${P}" -j ACCEPT
  done
  if command -v netfilter-persistent >/dev/null 2>&1; then
    netfilter-persistent save >/dev/null 2>&1 || true
  else
    apt-get install -y iptables-persistent >/dev/null 2>&1 && netfilter-persistent save >/dev/null 2>&1 || true
  fi
fi

# ---------------------------------------------------------------- update app env
ENV_FILE="${APP_DIR}/.env"
if [ -f "${ENV_FILE}" ]; then
  log "Updating APP_URL + YouTube OAuth redirect in ${ENV_FILE}…"
  sed -i "s|^APP_URL=.*|APP_URL=https://${FULL}|" "${ENV_FILE}"
  sed -i "s|^YOUTUBE_REDIRECT_URI=.*|YOUTUBE_REDIRECT_URI=https://${FULL}/auth/youtube/callback|" "${ENV_FILE}"
  # restart the app to pick up the new URL
  if [ -f "${APP_DIR}/docker-compose.yml" ]; then
    log "Restarting StreamPilot…"
    docker compose -f "${APP_DIR}/docker-compose.yml" up -d >/dev/null 2>&1 || \
      (cd "${APP_DIR}" && docker compose up -d)
  fi
fi

# ---------------------------------------------------------------- summary
printf '\n\033[1;32m✅ HTTPS is set up.\033[0m\n'
printf '   Site:  https://%s\n' "${FULL}"
printf '   App:   http://127.0.0.1:8787 (proxied by Caddy)\n\n'
printf '   ⏳ TLS takes up to ~1 min on first load.\n'
printf '   🔑 For YouTube Connect: add this redirect URI in Google Cloud Console:\n'
printf '      https://%s/auth/youtube/callback\n' "${FULL}"
printf '   (You must also open ports 80 + 443 in the Oracle VCN security list.)\n'
