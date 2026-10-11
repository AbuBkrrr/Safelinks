# safelinks-configure.rsc - configures WAN, LAN bridge, WiFi (if present), Hotspot.
# Guards wireless paths so the script runs on wired-only routers too.

:global slWanMode
:global slWanUser
:global slWanPass
:global slLanIp
:global slSsid
:global slWifiPass
:global slPairCode
:global slApiUrl

:if ([:typeof $slWanMode] = "nothing") do={ :set slWanMode "dhcp" }
:if ([:typeof $slLanIp] = "nothing") do={ :set slLanIp "192.168.88.1" }
:if ([:typeof $slSsid] = "nothing") do={ :set slSsid "SafeLinks-WiFi" }
:if ([:typeof $slApiUrl] = "nothing") do={ :set slApiUrl "https://backend-services-production-78d8.up.railway.app" }

:log info "safelinks-configure: starting"

# --- 1. WAN (ether1) ---
:if ($slWanMode = "dhcp") do={
    /ip dhcp-client remove [find interface="ether1"]
    /ip dhcp-client add interface="ether1" disabled=no comment="SafeLinks WAN"
    :log info "WAN: DHCP"
}
:if ($slWanMode = "pppoe") do={
    /interface pppoe-client remove [find name="safelinks-pppoe"]
    /interface pppoe-client add name="safelinks-pppoe" interface="ether1" user=$slWanUser password=$slWanPass disabled=no add-default-route=yes use-peer-dns=yes
    :log info "WAN: PPPoE"
}

# --- 2. LAN bridge (all LAN ports share the hotspot) ---
# Detach every interface we manage from ANY bridge it currently belongs to.
# Factory-default RB750GL ships with ether2-5 in the default "bridge".
:foreach iface in={"ether2";"ether3";"ether4";"ether5"} do={
    :if ([:len [/interface ethernet find name=$iface]] > 0) do={
        /interface bridge port remove [find interface=$iface]
    }
}
/interface bridge port remove [find bridge="safelinks-bridge"]
/interface bridge remove [find name="safelinks-bridge"]
/interface bridge add name="safelinks-bridge" comment="SafeLinks bridge"

:foreach iface in={"ether2";"ether3";"ether4";"ether5"} do={
    :if ([:len [/interface ethernet find name=$iface]] > 0) do={
        /interface bridge port add bridge="safelinks-bridge" interface=$iface comment="SafeLinks LAN"
    }
}
# --- 3. Add wireless to bridge IF the package is installed ---
:do {
    :foreach iface in=[/interface wireless find] do={
        :local ifname [/interface wireless get $iface name]
        :if ([:len [/interface bridge port find interface=$ifname bridge="safelinks-bridge"]] = 0) do={
            /interface bridge port add bridge="safelinks-bridge" interface=$ifname comment="SafeLinks Wireless"
        }
    }
} on-error={ :log info "no wireless package - skipping" }

:do {
    :foreach iface in=[/interface wifi find] do={
        :local ifname [/interface wifi get $iface name]
        :if ([:len [/interface bridge port find interface=$ifname bridge="safelinks-bridge"]] = 0) do={
            /interface bridge port add bridge="safelinks-bridge" interface=$ifname comment="SafeLinks WiFi"
        }
    }
} on-error={ :log info "no wifi package - skipping" }

# --- 4. LAN IP on the bridge ---
# Remove LAN IP from ANY interface it might currently be on. Factory RB750GL
# ships 192.168.88.1/24 on the default "bridge" - if we leave it there, two
# interfaces claim the same IP and Winbox/SSH time out.
/ip address remove [find interface="ether2"]
/ip address remove [find interface="safelinks-bridge"]
/ip address remove [find interface="bridge"]
/ip address add address=($slLanIp . "/24") interface="safelinks-bridge" comment="SafeLinks LAN"

# Disable the factory-default bridge + its DHCP server so only
# safelinks-bridge is live and answering.
/interface bridge disable [find name="bridge"]
/ip dhcp-server disable [find name="defconf"]

# --- 5. DHCP pool + server ---
/ip pool remove [find name="safelinks-pool"]
/ip pool add name="safelinks-pool" ranges=("192.168.88.10-192.168.88.254")

/ip dhcp-server remove [find name="safelinks-dhcp"]
/ip dhcp-server add name="safelinks-dhcp" interface="safelinks-bridge" address-pool="safelinks-pool" disabled=no

/ip dns set servers=1.1.1.1,8.8.8.8 allow-remote-requests=yes

/ip firewall nat remove [find comment="SafeLinks NAT"]
/ip firewall nat add chain=srcnat out-interface="ether1" action=masquerade comment="SafeLinks NAT"

# --- 6. WiFi security + SSID (guarded - only runs if wireless present) ---
:do {
    :if ([:len [/interface wireless find]] > 0) do={
        /interface wireless security-profiles remove [find name="safelinks-sec"]
        /interface wireless security-profiles add name="safelinks-sec" mode=dynamic-keys authentication-types=wpa2-psk wpa2-pre-shared-key=$slWifiPass
        /interface wireless set [find] ssid=$slSsid security-profile="safelinks-sec" disabled=no
        :log info ("WiFi (wireless): " . $slSsid)
    }
} on-error={ :log info "no wireless package" }

:do {
    :if ([:len [/interface wifi find]] > 0) do={
        /interface wifi security remove [find name="safelinks-sec"]
        /interface wifi security add name="safelinks-sec" authentication-types=wpa2-psk passphrase=$slWifiPass
        /interface wifi set [find] ssid=$slSsid security="safelinks-sec" disabled=no
        :log info ("WiFi (wifi): " . $slSsid)
    }
} on-error={ :log info "no wifi package" }

# --- 7. Hotspot on the bridge (wired + wireless both land here) ---
/ip hotspot remove [find name="safelinks-hotspot"]
/ip hotspot profile remove [find name="safelinks-profile"]
/ip hotspot profile add name="safelinks-profile" hotspot-address=$slLanIp dns-name="www.safelinks.name.ng" html-directory=hotspot
/ip hotspot add name="safelinks-hotspot" interface="safelinks-bridge" address-pool="safelinks-pool" profile="safelinks-profile" disabled=no

# --- 8. Walled garden (pre-auth allowed) ---
# Two mechanisms needed:
#   1) HTTP (port 80): host-based walled-garden matches on the Host header.
#   2) HTTPS (port 443): Host header is encrypted, so we must match by IP.
#      We use /ip firewall address-list with a DNS hostname entry. RouterOS
#      resolves the name and updates the list periodically, so the portal's
#      Railway IP is always allowed even if it changes.

# Step 8a. HTTP host-based entries (browser hits these pre-HSTS)
/ip hotspot walled-garden remove [find comment="SafeLinks portal"]
/ip hotspot walled-garden add dst-host="safelinks.name.ng" action=allow comment="SafeLinks portal"
/ip hotspot walled-garden add dst-host="www.safelinks.name.ng" action=allow comment="SafeLinks portal"
/ip hotspot walled-garden add dst-host="backend-services-production-78d8.up.railway.app" action=allow comment="SafeLinks portal"
/ip hotspot walled-garden add dst-host="accounts.google.com" action=allow comment="SafeLinks portal"
/ip hotspot walled-garden add dst-host="checkout.flutterwave.com" action=allow comment="SafeLinks portal"

# Step 8b. Address-list with hostnames (RouterOS auto-resolves these to IPs
# and keeps the list current). This is what makes HTTPS work.
/ip firewall address-list remove [find list="safelinks-portal"]
/ip firewall address-list add list="safelinks-portal" address="safelinks.name.ng" comment="SafeLinks portal host"
/ip firewall address-list add list="safelinks-portal" address="www.safelinks.name.ng" comment="SafeLinks portal host"
/ip firewall address-list add list="safelinks-portal" address="backend-services-production-78d8.up.railway.app" comment="SafeLinks backend"
/ip firewall address-list add list="safelinks-portal" address="accounts.google.com" comment="SafeLinks OAuth"
/ip firewall address-list add list="safelinks-portal" address="checkout.flutterwave.com" comment="SafeLinks payments"

# Step 8c. IP walled-garden: allow the whole portal address-list through HTTPS
/ip hotspot walled-garden ip remove [find comment~"SafeLinks"]
/ip hotspot walled-garden ip add action=accept dst-address-list="safelinks-portal" comment="SafeLinks portal IPs"
/ip hotspot walled-garden ip add action=accept dst-address=1.1.1.1 comment="SafeLinks DNS"
/ip hotspot walled-garden ip add action=accept dst-address=8.8.8.8 comment="SafeLinks DNS"
/ip hotspot walled-garden ip add action=accept dst-address=8.8.4.4 comment="SafeLinks DNS"
/ip hotspot walled-garden ip add action=accept dst-port=8291 protocol=tcp comment="SafeLinks admin winbox"
/ip hotspot walled-garden ip add action=accept dst-port=22 protocol=tcp comment="SafeLinks admin ssh"

# Step 8d. Also allow QUIC (UDP 443) so browsers don't stall before fallback
/ip hotspot walled-garden ip add action=accept dst-port=443 protocol=udp comment="SafeLinks quic"

# --- 9. Pairing code ---
:if ([:typeof $slPairCode] != "nothing") do={
    :if ([:len [/file find name="safelinks-pair.txt"]] > 0) do={ /file remove [find name="safelinks-pair.txt"] }
    /file add name="safelinks-pair.txt" contents=$slPairCode
    :log info "Pairing code saved"
}

:log info "safelinks-configure: done"
:put "STATUS OK"