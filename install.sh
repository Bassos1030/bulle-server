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
  curl -fsSL https://get.docker.com | $SUDO sh
fi
$SUDO docker compose version >/dev/null 2>&1 || { echo "Docker Compose est introuvable."; exit 1; }

if [ ! -f .env ]; then
  IP="$(curl -fsS4 --max-time 10 https://api.ipify.org || curl -fsS4 --max-time 10 https://ifconfig.me)"
  HOST="${BULLE_HOST:-${IP//./-}.sslip.io}"
  TOKEN="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' | cut -c1-32)"
  umask 077
  printf 'BULLE_HOST=%s\nBULLE_TOKEN=%s\n' "$HOST" "$TOKEN" > .env
fi
. ./.env

# Ports 80 and 443 (HTTPS certificate): free, or already ours.
running="$($SUDO docker compose ps --services --status running 2>/dev/null || true)"
if ! grep -qx caddy <<<"$running"; then
  for p in 80 443; do
    if $SUDO ss -ltnH "( sport = :$p )" | grep -q .; then
      echo "Le port $p est déjà utilisé sur cette machine :"
      $SUDO ss -ltnpH "( sport = :$p )" || true
      exit 1
    fi
  done
fi

if command -v ufw >/dev/null 2>&1 && $SUDO ufw status | grep -q "Status: active"; then
  $SUDO ufw allow 80/tcp >/dev/null
  $SUDO ufw allow 443/tcp >/dev/null
fi

say "Démarrage du serveur Bulle…"
$SUDO docker compose up -d --build --remove-orphans

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
