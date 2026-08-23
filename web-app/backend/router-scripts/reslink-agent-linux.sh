#!/bin/sh
# =============================================================================
# Reslink zero-touch agent — generic Linux (OpenWRT, EdgeOS's bash shell,
# any Debian/Ubuntu-based gateway box)
# =============================================================================
#
# Unlike router-scripts/reslink-agent.rsc (MikroTik RouterOS, untested on
# real hardware), THIS script is plain POSIX shell + curl — it has been
# run for real against a live Reslink backend in development (see
# "TESTED" below), just not against a real captive-portal daemon, because
# none was available to install here either. Read "WHAT ISN'T PROVEN"
# before trusting it on a production router.
#
# WHAT THIS ASSUMES
#   This box already runs a captive-portal / hotspot daemon that manages
#   its OWN user database — this script does not create your hotspot
#   network. It ships wired up to CoovaChilli (the most common open-
#   source captive portal paired with OpenWRT and EdgeOS boxes) via
#   `chilli_query`, but the actual user-management calls are isolated in
#   ONE function (apply_command, near the bottom) specifically so you can
#   swap in whatever your box actually runs (a RADIUS user table via
#   `radclient`, OpenNDS, a custom API) without touching anything else.
#
# WHAT THIS COVERS vs. router-scripts/reslink-agent.rsc
#   MikroTik has RouterOS's own built-in hotspot user database, so that
#   script needs no external hotspot daemon. Most other router platforms
#   (OpenWRT, EdgeOS, generic Linux) don't have an equivalent built in —
#   they're normally paired with a SEPARATE captive-portal daemon like
#   CoovaChilli. So "universal" here means: universal TRANSPORT (this one
#   script's registration/check-in/ack logic works on any POSIX shell with
#   curl and cron, which covers the vast majority of Linux-based router
#   platforms including OpenWRT and EdgeOS), with a pluggable, per-
#   platform COMMAND layer (because there's no universal hotspot-user API
#   to target). A handful of closed, non-scriptable consumer firmwares
#   (stock Netgear/stock TP-Link firmware with no shell access at all)
#   are still out of reach — there's no shell to run a script in.
#
# TESTED: registration, check-in, and ack against a live Reslink backend
# in this repo's dev environment — genuinely exercised, not simulated.
# NOT TESTED: the default chilli_query command-execution branch below,
# since no CoovaChilli install was available to test against either —
# review it against your actual chilli_query version before relying on it.
#
# USAGE
#   1. Edit RESLINK_API_URL below if not using the default domain.
#   2. From the reseller dashboard, generate a pairing code (Routers ->
#      "Pair a router") — it's the only thing typed in by hand.
#   3. Run once, interactively:  ./reslink-agent-linux.sh register PAIRCODE
#   4. Add to cron (runs every 30s via two offset minutely entries, since
#      standard cron has no sub-minute granularity):
#        * * * * *          /path/to/reslink-agent-linux.sh checkin
#        * * * * * sleep 30; /path/to/reslink-agent-linux.sh checkin
# =============================================================================

set -eu

RESLINK_API_URL="https://api.reslink.io"
CRED_FILE="/etc/reslink/credentials"

log() { echo "[reslink-agent] $*" >&2; }

# --- registration: run once, by hand, with the pairing code -----------------
do_register() {
  code="${1:?Usage: $0 register PAIRING_CODE}"
  model="$(command -v ubnt-hal >/dev/null 2>&1 && echo 'Ubiquiti EdgeOS' || (uname -o 2>/dev/null || uname -s))"
  firmware="$(uname -r)"
  identity="$(hostname)"

  response=$(curl -s -X POST "$RESLINK_API_URL/api/agent/register" \
    --data-urlencode "code=$code" \
    --data-urlencode "model=$model" \
    --data-urlencode "firmware=$firmware" \
    --data-urlencode "identity=$identity")

  if ! echo "$response" | grep -q "^STATUS OK"; then
    log "registration failed:"
    echo "$response" >&2
    exit 1
  fi

  router_id=$(echo "$response" | sed -n 's/^ROUTER_ID //p')
  api_key=$(echo "$response" | sed -n 's/^API_KEY //p')

  mkdir -p "$(dirname "$CRED_FILE")"
  printf '%s\n%s\n' "$router_id" "$api_key" > "$CRED_FILE"
  chmod 600 "$CRED_FILE"

  log "paired successfully as $router_id — credentials saved to $CRED_FILE"
  log "now add the cron entries from this script's header comment to start checking in every 30s"
}

# --- one check-in cycle: fetch pending commands, execute, ack ---------------
do_checkin() {
  if [ ! -f "$CRED_FILE" ]; then
    log "not paired yet — run: $0 register PAIRING_CODE"
    exit 1
  fi
  router_id=$(sed -n '1p' "$CRED_FILE")
  api_key=$(sed -n '2p' "$CRED_FILE")

  response=$(curl -s -X POST "$RESLINK_API_URL/api/agent/checkin" \
    --data-urlencode "router_id=$router_id" \
    --data-urlencode "api_key=$api_key")

  if ! echo "$response" | grep -q "^STATUS OK"; then
    log "check-in rejected (will retry next cycle): $response"
    exit 0
  fi

  # One "CMD <id> <type> <username> <password> <deviceLimit> <bandwidthMbps>"
  # line per pending command, "-" for fields that don't apply.
  echo "$response" | grep "^CMD " | while read -r _ cmd_id cmd_type username password device_limit bandwidth; do
    if apply_command "$cmd_type" "$username" "$password" "$device_limit" "$bandwidth"; then
      exec_status="executed"; detail=""
    else
      exec_status="failed"; detail="apply_command returned non-zero for $cmd_type"
    fi
    curl -s -X POST "$RESLINK_API_URL/api/agent/commands/$cmd_id/ack" \
      --data-urlencode "router_id=$router_id" \
      --data-urlencode "api_key=$api_key" \
      --data-urlencode "status=$exec_status" \
      --data-urlencode "detail=$detail" >/dev/null \
      || log "could not ack $cmd_id — will be re-sent next check-in if still pending"
  done
}

# --- THE ONE FUNCTION TO SWAP OUT for your actual hotspot backend ----------
# Default implementation targets CoovaChilli via chilli_query. Return 0 on
# success, non-zero on failure (gets reported back as status=failed).
apply_command() {
  cmd_type="$1"; username="$2"; password="$3"; device_limit="$4"; bandwidth="$5"

  case "$cmd_type" in
    create_user)
      # chilli_query's exact user-provisioning invocation varies by
      # version/config (some deployments manage users via a RADIUS
      # backend instead of chilli_query directly) — this is the part
      # flagged untested above; verify against your install.
      chilli_query authorize "$username" "$password" \
        ${bandwidth:+"maxbw-down=${bandwidth}000000" "maxbw-up=${bandwidth}000000"}
      ;;
    enable_user)
      chilli_query authorize "$username"
      ;;
    disable_user)
      chilli_query deauthorize "$username"
      ;;
    delete_user)
      chilli_query deauthorize "$username"
      ;;
    *)
      log "unknown command type: $cmd_type"
      return 1
      ;;
  esac
}

case "${1:-}" in
  register) shift; do_register "$@" ;;
  checkin) do_checkin ;;
  *) echo "Usage: $0 {register PAIRING_CODE|checkin}" >&2; exit 1 ;;
esac
