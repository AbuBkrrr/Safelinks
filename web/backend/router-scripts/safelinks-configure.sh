#!/bin/sh
# safelinks-configure.sh — WAN + LAN + WiFi + Hotspot for OpenWRT/EdgeOS.
# Reads config from env vars, applies uci changes, reloads services.

set -eu
: "${SL_WAN_MODE:=dhcp}"
: "${SL_WAN_USER:=}"
: "${SL_WAN_PASS:=}"
: "${SL_LAN_IP:=192.168.88.1}"
: "${SL_SSID:=SafeLinks-WiFi}"
: "${SL_WIFI_PASS:=changeme123}"

log() { echo "[safelinks-configure] $*" >&2; }

# --- WAN ---
case "$SL_WAN_MODE" in
  dhcp)  uci set network.wan.proto='dhcp' ;;
  pppoe) uci set network.wan.proto='pppoe'
         uci set network.wan.username="$SL_WAN_USER"
         uci set network.wan.password="$SL_WAN_PASS" ;;
esac
uci commit network

# --- LAN ---
uci set network.lan.ipaddr="$SL_LAN_IP"
uci set network.lan.netmask="255.255.255.0"
uci set dhcp.lan.ignore='0'
uci set dhcp.lan.start='10'
uci set dhcp.lan.limit='240'
uci commit network
uci commit dhcp

# --- WiFi ---
uci set wireless.@wifi-device[0].disabled='0'
uci set wireless.@wifi-iface[0].mode='ap'
uci set wireless.@wifi-iface[0].ssid="$SL_SSID"
uci set wireless.@wifi-iface[0].encryption='psk2'
uci set wireless.@wifi-iface[0].key="$SL_WIFI_PASS"
uci set wireless.@wifi-iface[0].network='lan'
uci commit wireless

# --- Hotspot (OpenNDS) ---
if command -v opkg >/dev/null 2>&1; then
    opkg update >/dev/null 2>&1 || true
    opkg install opennds >/dev/null 2>&1 || true
fi
uci set opennds.@opennds[0].enabled='1' 2>/dev/null || true
uci set opennds.@opennds[0].gatewayinterface='br-lan' 2>/dev/null || true
uci commit opennds 2>/dev/null || true

# --- Apply ---
wifi reload 2>/dev/null || true
/etc/init.d/network restart
[ -x /etc/init.d/opennds ] && /etc/init.d/opennds restart 2>/dev/null || true

log "configuration complete"
echo "STATUS OK"
