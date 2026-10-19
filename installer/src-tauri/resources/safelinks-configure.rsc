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
:global slResellerId
:global slAdminMac

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

# --- 2. LAN bridge: rename default bridge to safelinks-bridge ---
# Renaming preserves the MAC address so the Winbox/SSH session on
# 192.168.88.1 survives the import (no ARP cache invalidation).
:if ([:len [/interface bridge find name="safelinks-bridge"]] = 0) do={
    :if ([:len [/interface bridge find name="bridge"]] > 0) do={
        /interface bridge set [find name="bridge"] name="safelinks-bridge" comment="SafeLinks bridge"
        :log info "renamed default bridge -> safelinks-bridge (MAC preserved)"
    } else={
        /interface bridge add name="safelinks-bridge" comment="SafeLinks bridge"
        :foreach iface in={"ether2";"ether3";"ether4";"ether5"} do={
            :if ([:len [/interface ethernet find name=$iface]] > 0) do={
                /interface bridge port add bridge="safelinks-bridge" interface=$iface comment="SafeLinks LAN"
            }
        }
        :log info "created safelinks-bridge"
    }
} else={
    :log info "safelinks-bridge already exists"
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

# --- 4. LAN IP: already on the renamed bridge ---
# The rename in section 2 preserved both the MAC and the 192.168.88.1/24 IP.
# Nothing to do here - the address is already on safelinks-bridge.
# --- 5. DHCP pool + server ---
# The factory "defconf" DHCP server was bound to the default bridge. Since we
# renamed that bridge to safelinks-bridge, defconf now sits on safelinks-bridge.
# Remove ANY DHCP server bound to this interface (regardless of name) before
# creating ours, otherwise the add command fails with "server already exists".
/ip pool remove [find name="safelinks-pool"]
/ip pool add name="safelinks-pool" ranges=("192.168.88.10-192.168.88.254")

/ip dhcp-server remove [find interface="safelinks-bridge"]
/ip dhcp-server add name="safelinks-dhcp" interface="safelinks-bridge" address-pool="safelinks-pool" disabled=no
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
/ip hotspot profile add name="safelinks-profile" hotspot-address=$slLanIp dns-name="hotspot.local" html-directory=hotspot
/ip hotspot add name="safelinks-hotspot" interface="safelinks-bridge" address-pool="safelinks-pool" profile="safelinks-profile" disabled=yes

# --- 7b. Replace factory hotspot pages with a redirect to the SAFE_Links portal ---
# RouterOS serves hotspot/login.html when a client hits any HTTP site pre-auth.
# We overwrite it so the browser is bounced straight to the SAFE_Links portal.
# Single-quoted HTML attributes inside the double-quoted string - safe for .rsc.
:do {
    /file remove [find name="hotspot/login.html"]
} on-error={ :log info "no default login.html to remove" }
:do {
    /file remove [find name="hotspot/redirect.html"]
} on-error={ :log info "no default redirect.html to remove" }

/file add name="hotspot/login.html" contents="<html><head><title>SAFE_Links</title><script>/*__macCapture*/(function(){var m='\$(mac)',i='\$(ip)',o='\$(link-orig)',u='\$(username)',e='\$(error)';if(!o||o.length<3)o='http://budgetpro.com.ng/';var rid='$slResellerId';if(u.length>0||e.length>0){location.replace('https://www.safelinks.name.ng/portal/'+rid+'?mac='+encodeURIComponent(m)+'&ip='+encodeURIComponent(i)+'&dst='+encodeURIComponent(o)+'&login_error='+encodeURIComponent(e));}else{location.replace('https://www.safelinks.name.ng/portal/'+rid+'?mac='+encodeURIComponent(m)+'&ip='+encodeURIComponent(i)+'&dst='+encodeURIComponent(o));}})();</script></head><body style='background:#0f172a;color:#e2e8f0;font-family:sans-serif;text-align:center;padding:40px'><p style='font-size:14px'>Redirecting to SAFE_Links portal...</p></body></html>"

/file add name="hotspot/redirect.html" contents="<html><head><meta http-equiv='refresh' content='0;url=https://www.safelinks.name.ng/portal/$slResellerId'></head><body style='background:#0f172a;color:#e2e8f0;font-family:sans-serif;text-align:center;padding:40px'><p>Redirecting...</p></body></html>"

:log info "Hotspot pages replaced with SAFE_Links redirect"

# --- 7c. Admin device bypass - reseller PC keeps internet during setup ---
:if ([:typeof $slAdminMac] != "nothing") do={
    :if ([:len $slAdminMac] > 0) do={
        /ip hotspot ip-binding remove [find comment="SafeLinks admin bypass"]
        /ip hotspot ip-binding add mac-address=$slAdminMac type=bypassed comment="SafeLinks admin bypass"
        :log info ("admin bypass: " . $slAdminMac)
    }
}
# --- 8. Walled garden (pre-auth allowed) ---
# Two mechanisms needed:
#   1) HTTP (port 80): host-based walled-garden matches on the Host header.
#   2) HTTPS (port 443): Host header is encrypted, so we must match by IP.
#      We use /ip firewall address-list with a DNS hostname entry. RouterOS
#      resolves the name and updates the list periodically, so the portal's
#      Railway IP is always allowed even if it changes.

# Step 8a. HTTP host-based entries (browser hits these pre-HSTS)
:do { /ip hotspot walled-garden remove [/ip hotspot walled-garden find comment="SafeLinks portal"] } on-error={ :log info "sl-wg: no entries" }
:do { /ip hotspot walled-garden add dst-host="safelinks.name.ng" action=allow comment="SafeLinks portal" } on-error={}
:do { /ip hotspot walled-garden add dst-host="www.safelinks.name.ng" action=allow comment="SafeLinks portal" } on-error={}
:do { /ip hotspot walled-garden add dst-host="backend-services-production-78d8.up.railway.app" action=allow comment="SafeLinks portal" } on-error={}
:do { /ip hotspot walled-garden add dst-host="accounts.google.com" action=allow comment="SafeLinks portal" } on-error={}
:do { /ip hotspot walled-garden add dst-host="checkout.flutterwave.com" action=allow comment="SafeLinks portal" } on-error={}

# Step 8b. Address-list with hostnames (RouterOS auto-resolves these to IPs
# and keeps the list current). This is what makes HTTPS work.
:do { /ip firewall address-list remove [/ip firewall address-list find list="safelinks-portal"] } on-error={ :log info "sl-al: no entries" }
:do { /ip firewall address-list add list="safelinks-portal" address="safelinks.name.ng" comment="SafeLinks portal host" } on-error={}
:do { /ip firewall address-list add list="safelinks-portal" address="www.safelinks.name.ng" comment="SafeLinks portal host" } on-error={}
:do { /ip firewall address-list add list="safelinks-portal" address="backend-services-production-78d8.up.railway.app" comment="SafeLinks backend" } on-error={}
:do { /ip firewall address-list add list="safelinks-portal" address="accounts.google.com" comment="SafeLinks OAuth" } on-error={}
:do { /ip firewall address-list add list="safelinks-portal" address="checkout.flutterwave.com" comment="SafeLinks payments" } on-error={}

# Step 8c. IP walled-garden: allow the whole portal address-list through HTTPS
:do { /ip hotspot walled-garden ip remove [/ip hotspot walled-garden ip find comment~"SafeLinks"] } on-error={ :log info "sl-wgip: no entries" }
:do { /ip hotspot walled-garden ip add action=accept dst-address-list="safelinks-portal" comment="SafeLinks portal IPs" } on-error={}
:do { /ip hotspot walled-garden ip add action=accept dst-address=1.1.1.1 comment="SafeLinks DNS" } on-error={}
:do { /ip hotspot walled-garden ip add action=accept dst-address=8.8.8.8 comment="SafeLinks DNS" } on-error={}
:do { /ip hotspot walled-garden ip add action=accept dst-address=8.8.4.4 comment="SafeLinks DNS" } on-error={}
:do { /ip hotspot walled-garden ip add action=accept dst-port=8291 protocol=tcp comment="SafeLinks admin winbox" } on-error={}
:do { /ip hotspot walled-garden ip add action=accept dst-port=22 protocol=tcp comment="SafeLinks admin ssh" } on-error={}

# Step 8d. Also allow QUIC (UDP 443) so browsers don't stall before fallback
:do { /ip hotspot walled-garden ip add action=accept dst-port=443 protocol=udp comment="SafeLinks quic" } on-error={}

# --- 10. Enable hotspot ASYNCHRONOUSLY ---
# Enabling the hotspot drops all traffic on the bridge for ~5-10 seconds
# (including our SSH session). Running the enable via :execute forks it into
# a separate RouterOS task so the config gets applied even if we're disconnected.
# The installer will auto-reconnect and run verification below.
:do { /ip hotspot disable safelinks-hotspot } on-error={}
:execute "/ip hotspot enable safelinks-hotspot"
:log info "hotspot enable dispatched (async)"

# --- 9. Pairing code ---
:if ([:typeof $slPairCode] != "nothing") do={
    :if ([:len [/file find name="safelinks-pair.txt"]] > 0) do={ /file remove [find name="safelinks-pair.txt"] }
    /file add name="safelinks-pair.txt" contents=$slPairCode
    :log info "Pairing code saved"
}

# --- 11. Verification: only claim success if hotspot actually exists ---
:local slHsOk false
:do { :if ([:len [/ip hotspot find name="safelinks-hotspot"]] > 0) do={ :set slHsOk true } } on-error={}
:local slBridgeOk false
:do { :if ([:len [/interface bridge find name="safelinks-bridge"]] > 0) do={ :set slBridgeOk true } } on-error={}
:if ($slHsOk = true && $slBridgeOk = true) do={
    :log info "safelinks-configure: done"
    :put "STATUS OK"
} else={
    :log error ("safelinks-configure: incomplete - bridge=" . $slBridgeOk . " hotspot=" . $slHsOk)
    :put ("STATUS FAILED bridge=" . $slBridgeOk . " hotspot=" . $slHsOk)
}
