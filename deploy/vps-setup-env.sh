#!/usr/bin/env bash
# Creates ~/safelinks-app/.env with strong random secrets, asks for your
# super-admin login and Paystack key, and sets the new database password on
# the running database. Safe to re-run: an existing .env is kept unless you
# pass --rotate.
set -euo pipefail
cd "$(dirname "$0")/.."
rand() { head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "$1"; }

if [ -f .env ] && [ "${1:-}" != "--rotate" ]; then
  echo ".env already exists. Use --rotate to regenerate secrets."; exit 0
fi
[ -f .env ] && cp .env ".env.bak-$(date +%Y%m%d%H%M%S)"
cp .env.vps.example .env
chmod 600 .env

set_kv() { # set_kv KEY VALUE  (value may contain any characters)
  python3 - "$1" "$2" <<'PY'
import sys,re
k,v=sys.argv[1],sys.argv[2]
p='.env'; s=open(p).read()
s=re.sub(rf'^{re.escape(k)}=.*$', lambda m: f'{k}={v}', s, flags=re.M)
open(p,'w').write(s)
PY
}

DBPASS=$(rand 32)
set_kv POSTGRES_PASSWORD "$DBPASS"
set_kv JWT_SECRET "$(rand 64)"

read -rp  "Super-admin email: " SAE
read -rsp "Super-admin password (10+ chars): " SAP; echo
[ ${#SAP} -ge 10 ] || { echo "Password too short"; exit 1; }
set_kv SUPER_ADMIN_EMAIL "$SAE"
set_kv SUPER_ADMIN_PASSWORD "$SAP"
read -rsp "Paystack secret key (Enter to skip): " PSK; echo
[ -n "$PSK" ] && set_kv PAYSTACK_SECRET_KEY "$PSK"
read -rsp "Termii API key (Enter to skip): " TK; echo
[ -n "$TK" ] && set_kv TERMII_API_KEY "$TK"

# Apply the new DB password to the existing database (local socket inside
# the container needs no password, so this works whatever the old one was).
if docker ps --format '{{.Names}}' | grep -qx safelinks_db; then
  U=$(docker exec safelinks_db sh -c 'echo $POSTGRES_USER')
  docker exec -i safelinks_db psql -U "$U" -d postgres -v ON_ERROR_STOP=1 \
    -c "ALTER USER \"$U\" WITH PASSWORD '$DBPASS';" >/dev/null
  echo "Database password rotated for user $U."
fi
echo "Wrote .env (only root can read it). Next: bash deploy/vps-deploy.sh"
