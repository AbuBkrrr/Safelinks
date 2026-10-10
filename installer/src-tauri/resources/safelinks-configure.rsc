# safelinks-configure.rsc - configures WAN, LAN bridge, WiFi, Hotspot and pairs agent.
# Runs as a single script - globals are set by the installer before execution.

:global SL_WAN_MODE
:global SL_WAN_USER
:global SL_WAN_PASS
:global SL_LAN_IP
:global SL_SSID
:global SL_WIFI_PASS
:global SL_PAIR_CODE
:global SL_API_URL

:if ([:typeof $SL_WAN_MODE] = "nothing") do={ :set SL_WAN_MODE "dhcp" }
:if ([:typeof $SL_LAN_IP] = "nothing") do={ :set SL_LAN_IP "192.168.88.1" }
:if ([:typeof $SL_SSID] = "nothing") do={ :set SL_SSID "SafeLinks-WiFi" }
:if ([:typeof $SL_API_URL] = "nothing") do={ :set SL_API_URL "https://backend-services-production-78d8.up.railway.app" }

:log info "safelinks-configure: starting"

# --- 1. WAN (ether1, unchanged) ---
:if ($SL_WAN_MODE = "dhcp") do={
    /ip dhcp-client remove [find interface="ether1"]
    /ip dhcp-client add interface="ether1" disabled=no comment="SafeLinks WAN"
    :log info "WAN: DHCP"
}
:if ($SL_WAN_MODE = "pppoe") do={
    /interface pppoe-client remove [find name="safelinks-pppoe"]
    /interface pppoe-client add name="safelinks-pppoe" interface="ether1" user=$SL_WAN_USER password=$SL_WAN_PASS disabled=no add-default-route=yes use-peer-dns=yes
    :log info "WAN: PPPoE"
}

# --- 2. LAN bridge (all LAN ports + WiFi share the hotspot) ---
/interface bridge port remove [find bridge="safelinks-bridge"]
/interface bridge remove [find name="safelinks-bridge"]
/interface bridge add name="safelinks-bridge" comment="SafeLinks bridge"

# Add each LAN port that exists (ether2..ether5 on RB750GL and similar)
:foreach iface in={"ether2";"ether3";"ether4";"ether5"} do={
    :if ([:len [/interface ethernet find name=$iface]] > 0) do={
        /interface bridge port add bridge="safelinks-bridge" interface=$iface comment="SafeLinks LAN"
    }
}

# Add WiFi to bridge if present (both new 'wifi' and legacy 'wireless')
:foreach iface in=[/interface wifi find] do={
    :local ifname [/interface wifi get $iface name]
    /interface bridge port add bridge="safelinks-bridge" interface=$ifname comment="SafeLinks WiFi"
}
:foreach iface in=[/interface wireless find] do={
    :local ifname [/interface wireless get $iface name]
    /interface bridge port add bridge="safelinks-bridge" interface=$ifname comment="SafeLinks Wireless"
}

# --- 3. LAN IP on the bridge ---
/ip address remove [find interface="ether2"]
/ip address remove [find interface="safelinks-bridge"]
/ip address add address=($SL_LAN_IP . "/24") interface="safelinks-bridge" comment="SafeLinks LAN"

# --- 4. DHCP pool + server ---
/ip pool remove [find name="safelinks-pool"]
/ip pool add name="safelinks-pool" ranges=("192.168.88.10-192.168.88.254")

/ip dhcp-server remove [find name="safelinks-dhcp"]
/ip dhcp-server add name="safelinks-dhcp" interface="safelinks-bridge" address-pool="safelinks-pool" disabled=no

/ip dns set servers=1.1.1.1,8.8.8.8 allow-remote-requests=yes

/ip firewall nat remove [find comment="SafeLinks NAT"]
/ip firewall nat add chain=srcnat out-interface="ether1" action=masquerade comment="SafeLinks NAT"

# --- 5. WiFi security + SSID (silently skipped on wired-only routers) ---
:if ([:len [/interface wifi find]] > 0) do={
    /interface wifi security remove [find name="safelinks-sec"]
    /interface wifi security add name="safelinks-sec" authentication-types=wpa2-psk,wpa3-psk passphrase=$SL_WIFI_PASS
    /interface wifi set [find] ssid=$SL_SSID security="safelinks-sec" disabled=no
    :log info ("WiFi (wifi): " . $SL_SSID)
}
:if ([:len [/interface wireless find]] > 0) do={
    /interface wireless security-profiles remove [find name="safelinks-sec"]
    /interface wireless security-profiles add name="safelinks-sec" mode=dynamic-keys authentication-types=wpa2-psk wpa2-pre-shared-key=$SL_WIFI_PASS
    /interface wireless set [find] ssid=$SL_SSID security-profile="safelinks-sec" disabled=no
    :log info ("WiFi (wireless): " . $SL_SSID)
}

# --- 6. Hotspot on the bridge (covers wired + wireless) ---
/ip hotspot remove [find name="safelinks-hotspot"]
/ip hotspot profile remove [find name="safelinks-profile"]
/ip hotspot profile add name="safelinks-profile" hotspot-address=$SL_LAN_IP dns-name="www.safelinks.name.ng" html-directory=hotspot
/ip hotspot add name="safelinks-hotspot" interface="safelinks-bridge" address-pool="safelinks-pool" profile="safelinks-profile" disabled=no

# --- 7. Walled garden (pre-auth allowed destinations) ---
/ip hotspot walled-garden remove [find comment="SafeLinks portal"]
/ip hotspot walled-garden add dst-host="backend-services-production-78d8.up.railway.app" action=allow comment="SafeLinks portal"
/ip hotspot walled-garden add dst-host="*.safelinks.name.ng" action=allow comment="SafeLinks portal"
/ip hotspot walled-garden add dst-host="accounts.google.com" action=allow comment="SafeLinks portal"
/ip hotspot walled-garden add dst-host="checkout.flutterwave.com" action=allow comment="SafeLinks portal"

# --- 8. Pairing code ---
:if ([:typeof $SL_PAIR_CODE] != "nothing") do={
    :if ([:len [/file find name="safelinks-pair.txt"]] > 0) do={ /file remove [find name="safelinks-pair.txt"] }
    /file add name="safelinks-pair.txt" contents=$SL_PAIR_CODE
    :log info "Pairing code saved"
}

:log info "safelinks-configure: done"
:put "STATUS OK"