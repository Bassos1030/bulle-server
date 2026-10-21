# Serveur Bulle

Le serveur de traduction de l’app Bulle, compilé. Il traduit un chapitre en entier en même temps
(toutes les bulles en parallèle) et prépare les chapitres suivants, pour qu’ils s’ouvrent
instantanément dans l’app.

- Aucun secret dans ce dépôt : la clé Claude est envoyée par l’app à chaque demande et gardée en
  mémoire seulement ; le code d’accès est créé à l’installation, dans `.env` (non versionné).
- HTTPS automatique (Caddy, Let’s Encrypt), sur `<ip>.sslip.io` ou ton propre domaine.

## Installer (Ubuntu ou Debian)

```sh
git clone https://github.com/Bassos1030/bulle-server.git
cd bulle-server
./install.sh
```

Le script installe Docker si besoin, ouvre les ports 80 et 443, démarre le serveur et affiche
l’adresse et le code à saisir dans l’app (Réglages → Serveur Bulle).

Avec ton domaine (un enregistrement A vers la machine) : `BULLE_HOST=bulle.mondomaine.fr ./install.sh`.

## Mettre à jour

```sh
cd bulle-server && git pull && ./install.sh
```

Le code et les chapitres déjà traduits sont gardés.
