#!/usr/bin/env bash
# Installs (or updates) the Bulle server on an Ubuntu/Debian machine: Docker, HTTPS (Caddy), and
# a private code for the app. Run again to update; the code and the cached chapters are kept.
#   BULLE_HOST=bulle.example.com ./install.sh   (optional: your own domain instead of <ip>.sslip.io)
set -euo pipefail
cd "$(dirname "$0")"
SUDO=""
[ "$(id -u)" -ne 0 ] && SUDO="sudo"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

if ! command -v docker >/dev/null 2>&1; then
  say "Installation de Docker…"
  # Docker's own packages; a release too new for them: Ubuntu's.
  curl -fsSL https://get.docker.com | $SUDO sh || {
    $SUDO apt-get update
    $SUDO apt-get install -y docker.io docker-compose-v2 || $SUDO apt-get install -y docker.io docker-compose-plugin
  }
  $SUDO systemctl enable --now docker >/dev/null 2>&1 || true
fi
$SUDO docker compose version >/dev/null 2>&1 || { echo "Docker Compose est introuvable."; exit 1; }

if [ ! -f .env ]; then
  IP="$(curl -fsS4 --max-time 10 https://api.ipify.org || curl -fsS4 --max-time 10 https://ifconfig.me)"
  HOST="${BULLE_HOST:-${IP//./-}.sslip.io}"
  TOKEN="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' | cut -c1-32)"
  umask 077
  printf 'BULLE_HOST=%s\nBULLE_TOKEN=%s\nPUBLIC_IP=%s\n' "$HOST" "$TOKEN" "$IP" > .env
fi
. ./.env

# Ports 80 and 443 (HTTPS certificate) on the public address: free, or already ours. Something
# listening on another address only (a VPN such as Tailscale): Bulle listens on the public one.
running="$($SUDO docker compose ps --services --status running 2>/dev/null || true)"
if ! grep -qx caddy <<<"$running"; then
  other=0
  for p in 80 443; do
    for a in $($SUDO ss -ltnH "( sport = :$p )" | awk '{print $4}'); do
      case "$a" in
        "0.0.0.0:$p" | "*:$p" | "[::]:$p" | "${PUBLIC_IP:-none}:$p")
          echo "Le port $p est déjà utilisé sur l’adresse publique :"
          $SUDO ss -ltnpH "( sport = :$p )" || true
          exit 1
          ;;
        *) other=1 ;;
      esac
    done
  done
  if [ "$other" = 1 ] && [ -n "${PUBLIC_IP:-}" ] && ! grep -q '^BIND_IP=' .env; then
    echo "BIND_IP=$PUBLIC_IP" >> .env
  fi
fi

if command -v ufw >/dev/null 2>&1 && $SUDO ufw status | grep -q "Status: active"; then
  $SUDO ufw allow 80/tcp >/dev/null
  $SUDO ufw allow 443/tcp >/dev/null
fi

say "Démarrage du serveur Bulle…"
$SUDO docker compose build
# A data volume created by an earlier version belongs to root: given to the server's user.
$SUDO docker compose run --rm --no-deps --user root --entrypoint chown bulle -R node:node /data
$SUDO docker compose up -d --remove-orphans

for _ in $(seq 1 60); do
  if curl -fsS --max-time 5 "https://$BULLE_HOST/health" >/dev/null 2>&1; then
    say "Serveur Bulle prêt."
    echo "Adresse : https://$BULLE_HOST"
    echo "Code    : $BULLE_TOKEN"
    exit 0
  fi
  sleep 3
done
echo "Le serveur ne répond pas encore en HTTPS. Journal :"
$SUDO docker compose logs --tail 40
exit 1
