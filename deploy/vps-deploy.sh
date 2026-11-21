#!/usr/bin/env bash
# Deploy / update SAFE_Links on the VPS:  bash deploy/vps-deploy.sh [branch]
#   1. backs up the database to ~/backups
#   2. saves any local edits as a patch, then checks out the branch
#   3. rebuilds and restarts the containers
#   4. checks the API and the site respond
set -euo pipefail
cd "$(dirname "$0")/.."
BRANCH="${1:-main}"
COMPOSE="docker compose -f docker-compose.vps.yml --env-file .env"
[ -f .env ] || { echo "No .env yet: run  bash deploy/vps-setup-env.sh  first"; exit 1; }
mkdir -p ~/backups
STAMP=$(date +%Y%m%d-%H%M%S)

if docker ps --format '{{.Names}}' | grep -qx safelinks_db; then
  echo "== Backing up database"
  docker exec safelinks_db sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip > ~/backups/safelinks-db-$STAMP.sql.gz
  ls -lh ~/backups/safelinks-db-$STAMP.sql.gz
fi

echo "== Updating code ($BRANCH)"
git diff --quiet || git diff > ~/backups/safelinks-local-edits-$STAMP.patch
git fetch origin "$BRANCH"
git checkout -f -B "$BRANCH" "origin/$BRANCH"

echo "== Building and starting"
$COMPOSE build
docker run --rm -v "$PWD/web/frontend/nginx.conf:/etc/nginx/conf.d/default.conf:ro" \
  --add-host backend:127.0.0.1 nginx:alpine nginx -t
$COMPOSE up -d --remove-orphans

echo "== Checking"
for i in $(seq 1 30); do
  if docker exec safelinks_frontend wget -qO- http://backend:4000/health >/dev/null 2>&1; then break; fi
  sleep 2
done
docker exec safelinks_frontend wget -qO- http://backend:4000/health && echo
curl -fsS -o /dev/null -w "site (local): HTTP %{http_code}\n" http://127.0.0.1:8080/
curl -fsS -o /dev/null -w "api via site: HTTP %{http_code}\n" http://127.0.0.1:8080/api/payments/providers
docker logs --tail 5 safelinks_backend
docker image prune -f >/dev/null
echo "Deployed $(git log --oneline -1)"
