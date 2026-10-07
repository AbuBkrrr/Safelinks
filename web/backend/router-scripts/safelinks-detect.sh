#!/bin/sh
# safelinks-detect.sh — reports current router state as KEY=VALUE lines.

wan_type="none"
[ -f /etc/config/network ] && {
    proto=$(uci -q get network.wan.proto)
    [ "$proto" = "dhcp" ] && wan_type="dhcp"
    [ "$proto" = "pppoe" ] && wan_type="pppoe"
    [ "$proto" = "static" ] && wan_type="static"
}

wan_ip=$(ip -4 addr show dev eth1 2>/dev/null | grep -oP 'inet \K[\d.]+' | head -1)
[ -z "$wan_ip" ] && wan_ip="-"

lan_ip=$(uci -q get network.lan.ipaddr)
[ -z "$lan_ip" ] && lan_ip="-"

ssid=$(uci -q get wireless.@wifi-iface[0].ssid)
[ -z "$ssid" ] && ssid="-"

has_hotspot="no"
[ -x /etc/init.d/opennds ] && has_hotspot="yes"
[ -x /etc/init.d/chilli ] && has_hotspot="yes"

echo "WAN_TYPE=$wan_type"
echo "WAN_IP=$wan_ip"
echo "LAN_IP=$lan_ip"
echo "WIFI_SSID=$ssid"
echo "HAS_HOTSPOT=$has_hotspot"
echo "STATUS OK"
