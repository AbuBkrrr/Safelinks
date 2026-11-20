# =============================================================================
# SAFE_Links router setup - the ONE script every installer path runs.
# Served filled-in by GET /api/setup/<PAIRING-CODE>.rsc. Run on the router:
#   /tool fetch url="<API>/api/setup/<CODE>.rsc" dst-path=safelinks-setup.rsc check-certificate=no; /import safelinks-setup.rsc
# Idempotent: safe to run again on an already-configured router.
# Targets RouterOS 7.x and 6.45+. Commands that exist on only some routers
# (wireless vs wifi packages, routerboard) are compiled at run time with
# :parse or wrapped in on-error, so one missing menu never aborts the import.
# =============================================================================
:global slApi "__API__"
:global slPortal "__PORTAL__"
:global slRid "__RID__"
:global slCode "__CODE__"
:global slSsid "__SSID__"
:global slWifiPass "__WIFIPASS__"
:global slWanMode "__WANMODE__"
:global slWanIf "__WANIF__"
:global slWanUser "__WANUSER__"
:global slWanPass "__WANPASS__"
:global slAdminMac "__ADMINMAC__"
:global slHosts "__HOSTS__"
:local lanIp "192.168.88.1"
:log info "safelinks: setup start"

# --- 1. WAN --------------------------------------------------------------
:do { /interface bridge port remove [find interface=$slWanIf] } on-error={}
:if ($slWanMode = "pppoe") do={
    :do { /interface pppoe-client remove [find name="safelinks-pppoe"] } on-error={}
    /interface pppoe-client add name="safelinks-pppoe" interface=$slWanIf user=$slWanUser password=$slWanPass add-default-route=yes use-peer-dns=yes disabled=no
} else={
    :if ([:len [/ip dhcp-client find interface=$slWanIf]] = 0) do={
        /ip dhcp-client add interface=$slWanIf disabled=no comment="SafeLinks WAN"
    } else={
        /ip dhcp-client enable [find interface=$slWanIf]
    }
}

# --- 2. LAN bridge (reuse factory "bridge" so its IP + MAC survive) ------
:if ([:len [/interface bridge find name="safelinks-bridge"]] = 0) do={
    :if ([:len [/interface bridge find name="bridge"]] > 0) do={
        /interface bridge set [find name="bridge"] name="safelinks-bridge"
    } else={
        /interface bridge add name="safelinks-bridge" comment="SafeLinks LAN"
    }
}
:foreach i in=[/interface ethernet find] do={
    :local n [/interface ethernet get $i name]
    :if ($n != $slWanIf && [:len [/interface bridge port find interface=$n]] = 0) do={
        :do { /interface bridge port add bridge="safelinks-bridge" interface=$n } on-error={}
    }
}

# --- 3. WiFi: SSID + WPA2 + bridge membership, legacy and new packages ---
:do {
    [:parse ":global slSsid; :global slWifiPass; :foreach w in=[/interface wireless find] do={ :local n [/interface wireless get \$w name]; :if ([:len [/interface bridge port find interface=\$n]] = 0) do={ /interface bridge port add bridge=safelinks-bridge interface=\$n } }; :if ([:len [/interface wireless find]] > 0) do={ :do { /interface wireless security-profiles remove [find name=safelinks-sec] } on-error={}; :if ([:len \$slWifiPass] >= 8) do={ /interface wireless security-profiles add name=safelinks-sec mode=dynamic-keys authentication-types=wpa2-psk wpa2-pre-shared-key=\$slWifiPass } else={ /interface wireless security-profiles add name=safelinks-sec mode=none }; /interface wireless set [find] ssid=\$slSsid security-profile=safelinks-sec mode=ap-bridge disabled=no }"]
} on-error={ :log info "safelinks: no legacy wireless package" }
:do {
    [:parse ":global slSsid; :global slWifiPass; :foreach w in=[/interface wifi find] do={ :local n [/interface wifi get \$w name]; :if ([:len [/interface bridge port find interface=\$n]] = 0) do={ /interface bridge port add bridge=safelinks-bridge interface=\$n } }; :if ([:len [/interface wifi find]] > 0) do={ :do { /interface wifi security remove [find name=safelinks-sec] } on-error={}; :if ([:len \$slWifiPass] >= 8) do={ /interface wifi security add name=safelinks-sec authentication-types=wpa2-psk,wpa3-psk passphrase=\$slWifiPass } else={ /interface wifi security add name=safelinks-sec }; /interface wifi set [find] configuration.ssid=\$slSsid security=safelinks-sec disabled=no }"]
} on-error={ :log info "safelinks: no wifi package" }

# --- 4. LAN IP, DHCP, DNS, NAT (added only when missing) ------------------
:if ([:len [/ip address find interface="safelinks-bridge"]] = 0) do={
    /ip address add address=($lanIp . "/24") interface="safelinks-bridge" comment="SafeLinks LAN"
}
:do { /ip pool remove [find name="safelinks-pool"] } on-error={}
/ip pool add name="safelinks-pool" ranges=192.168.88.10-192.168.88.254
:do { /ip dhcp-server remove [find interface="safelinks-bridge"] } on-error={}
/ip dhcp-server add name="safelinks-dhcp" interface="safelinks-bridge" address-pool="safelinks-pool" lease-time=1h disabled=no
:if ([:len [/ip dhcp-server network find address="192.168.88.0/24"]] = 0) do={
    /ip dhcp-server network add address=192.168.88.0/24 gateway=$lanIp dns-server=$lanIp comment="SafeLinks LAN"
}
/ip dns set allow-remote-requests=yes servers=1.1.1.1,8.8.8.8
:if ([:len [/ip firewall nat find chain=srcnat action=masquerade]] = 0) do={
    /ip firewall nat add chain=srcnat out-interface=$slWanIf action=masquerade comment="SafeLinks NAT"
}
:if ($slWanMode = "pppoe" && [:len [/ip firewall nat find out-interface="safelinks-pppoe"]] = 0) do={
    /ip firewall nat add chain=srcnat out-interface="safelinks-pppoe" action=masquerade comment="SafeLinks NAT"
}

# --- 5. Hotspot -----------------------------------------------------------
# Customers log in with their voucher (http-pap from the portal's redirect,
# chap from the router page, cookie to re-connect). No MAC login: a MAC is
# visible to everyone on the WLAN. "login.wifi" instead of *.local, which
# iOS/Android captive-portal detection treats specially.
:local html "hotspot"
:if ([:len [/file find name="flash"]] > 0) do={ :set html "flash/hotspot" }
:do { /ip hotspot remove [find interface="safelinks-bridge"] } on-error={}
:do { /ip hotspot remove [find name="safelinks-hotspot"] } on-error={}
:do { /ip hotspot profile remove [find name="safelinks-profile"] } on-error={}
/ip hotspot profile add name="safelinks-profile" hotspot-address=$lanIp dns-name="login.wifi" html-directory=$html login-by=cookie,http-chap,http-pap http-cookie-lifetime=1d
/ip hotspot add name="safelinks-hotspot" interface="safelinks-bridge" address-pool="safelinks-pool" profile="safelinks-profile" disabled=no
:delay 2s
# Pages come from the backend: works on v6 (no /file add) and keeps the
# portal URL in one place. Each page just hands off to the SAFE_Links portal.
:foreach p in={"login.html";"alogin.html";"status.html";"logout.html"} do={
    :do {
        /tool fetch url=($slApi . "/api/setup/page/" . $p . "?rid=" . $slRid) dst-path=($html . "/" . $p) check-certificate=no
    } on-error={ :log error ("safelinks: could not fetch hotspot page " . $p) }
}

# --- 6. Pre-login access: portal + payment hosts only ---------------------
:if ([:len $slAdminMac] > 0) do={
    :do { /ip hotspot ip-binding remove [find comment="SafeLinks admin bypass"] } on-error={}
    /ip hotspot ip-binding add mac-address=$slAdminMac type=bypassed comment="SafeLinks admin bypass"
}
:do { /ip hotspot walled-garden remove [find comment="SafeLinks"] } on-error={}
:do { /ip hotspot walled-garden ip remove [find comment~"SafeLinks"] } on-error={}
:do { /ip firewall address-list remove [find list="safelinks-portal"] } on-error={}
:foreach h in=[:toarray $slHosts] do={
    /ip hotspot walled-garden add dst-host=$h action=allow comment="SafeLinks"
    :do { /ip firewall address-list add list="safelinks-portal" address=$h comment="SafeLinks" } on-error={}
}
/ip hotspot walled-garden ip add action=accept dst-address-list="safelinks-portal" comment="SafeLinks portal"
/ip hotspot walled-garden ip add action=accept dst-address=$lanIp protocol=tcp dst-port=22 comment="SafeLinks admin ssh"
/ip hotspot walled-garden ip add action=accept dst-address=$lanIp protocol=tcp dst-port=8291 comment="SafeLinks admin winbox"

# --- 7. Agent: pairing, 15s check-in, commands, metrics -------------------
:do { /system scheduler remove [find name~"^safelinks"] } on-error={}
:do { /system script remove [find name~"^safelinks"] } on-error={}

/system script add name="safelinks-register" policy=read,write,policy,test,reboot source={
    :global slApi
    :global slCode
    :local hw ""
    :do { :set hw [/system routerboard get serial-number] } on-error={}
    :if ([:len $hw] = 0) do={ :do { :set hw [/system license get system-id] } on-error={} }
    :if ([:len $hw] = 0) do={ :do { :set hw [/system license get software-id] } on-error={} }
    :local model "x86"
    :do { :set model [/system routerboard get model] } on-error={}
    :local data ("code=" . $slCode . "&model=" . $model . "&firmware=" . [/system resource get version] . "&identity=" . [/system identity get name] . "&hw=" . $hw)
    :local r ([/tool fetch url=($slApi . "/api/agent/register") http-method=post http-data=$data check-certificate=no as-value output=user]->"data")
    :if ([:typeof [:find $r "STATUS OK"]] = "nil") do={ :log error ("safelinks: register failed " . $r); :error "register failed" }
    :local rid ""
    :local key ""
    :local a [:find $r "ROUTER_ID "]
    :if ([:typeof $a] != "nil") do={ :local e [:find $r "\n" $a]; :set rid [:pick $r ($a + 10) $e] }
    :local b [:find $r "API_KEY "]
    :if ([:typeof $b] != "nil") do={ :local e [:find $r "\n" $b]; :set key [:pick $r ($b + 8) $e] }
    :if ([:len $rid] = 0 || [:len $key] = 0) do={ :error "register: bad response" }
    :do { /system script remove [find name="safelinks-cred"] } on-error={}
    /system script add name="safelinks-cred" policy=read,write,test source=(":global slRouterId \"" . $rid . "\"; :global slKey \"" . $key . "\"")
    /system script run safelinks-cred
    :log info ("safelinks: paired as " . $rid)
    :put ("Paired as " . $rid)
}

/system script add name="safelinks-checkin" policy=read,write,policy,test,reboot source={
    :global slApi
    :global slRouterId
    :global slKey
    :if ([:len [/system script job find script="safelinks-checkin"]] > 1) do={ :error "busy" }
    :if ([:len $slRouterId] = 0) do={ :do { /system script run safelinks-cred } on-error={ :error "not paired" } }
    :local auth ("router_id=" . $slRouterId . "&api_key=" . $slKey)
    :local r ""
    :do {
        :set r ([/tool fetch url=($slApi . "/api/agent/checkin") http-method=post http-data=$auth check-certificate=no as-value output=user]->"data")
    } on-error={ :log warning "safelinks: check-in failed" }
    :local doReboot false
    :local pos 0
    :while ($pos < [:len $r]) do={
        :local nl [:find $r "\n" ($pos - 1)]
        :if ([:typeof $nl] = "nil") do={ :set nl [:len $r] }
        :local line [:pick $r $pos $nl]
        :set pos ($nl + 1)
        :if ([:pick $line 0 2] = "C,") do={
            :local s [:pick $line 2 [:len $line]]
            :local f [:toarray ""]
            :local q 0
            :while ($q <= [:len $s]) do={
                :local c [:find $s "," ($q - 1)]
                :if ([:typeof $c] = "nil") do={ :set c [:len $s] }
                :set f ($f, [:pick $s $q $c])
                :set q ($c + 1)
            }
            :local cid ($f->0)
            :local t ($f->1)
            :local u ($f->2)
            :local st "executed"
            :do {
                :if ($t = "extend_user" && [:len [/ip hotspot user find name=$u]] > 0) do={
                    /ip hotspot user set [find name=$u] limit-uptime=($f->6) disabled=no
                    :do { /ip hotspot user reset-counters [find name=$u] } on-error={}
                    :set t "done"
                }
                :if ($t = "create_user" || $t = "extend_user") do={
                    :local prof ("sl-" . ($f->5) . "M-" . ($f->4) . "u")
                    :if ([:len [/ip hotspot user profile find name=$prof]] = 0) do={
                        /ip hotspot user profile add name=$prof rate-limit=(($f->5) . "M/" . ($f->5) . "M") shared-users=[:tonum ($f->4)] add-mac-cookie=yes
                    }
                    :do { /ip hotspot user remove [find name=$u] } on-error={}
                    /ip hotspot user add name=$u password=($f->3) profile=$prof limit-uptime=($f->6) server=all comment="SafeLinks"
                    :if ([:tonum ($f->7)] > 0) do={ /ip hotspot user set [find name=$u] limit-bytes-total=([:tonum ($f->7)] * 1048576) }
                }
                :if ($t = "disable_user") do={
                    :do { /ip hotspot user disable [find name=$u] } on-error={}
                    :do { /ip hotspot active remove [find user=$u] } on-error={}
                    :do { /ip hotspot cookie remove [find user=$u] } on-error={}
                }
                :if ($t = "enable_user") do={ /ip hotspot user enable [find name=$u] }
                :if ($t = "delete_user") do={
                    :do { /ip hotspot active remove [find user=$u] } on-error={}
                    :do { /ip hotspot user remove [find name=$u] } on-error={}
                }
                :if ($t = "kick_user") do={ :do { /ip hotspot active remove [find user=$u] } on-error={} }
                :if ($t = "disconnect_user") do={ :do { /ip hotspot active remove [find mac-address=$u] } on-error={} }
                :if ($t = "bind_mac") do={
                    :do { /ip hotspot ip-binding remove [find mac-address=$u comment!="SafeLinks admin bypass"] } on-error={}
                    /ip hotspot ip-binding add mac-address=$u type=bypassed comment="SafeLinks device"
                }
                :if ($t = "unbind_mac") do={
                    :do { /ip hotspot active remove [find mac-address=$u] } on-error={}
                    :do { /ip hotspot ip-binding remove [find mac-address=$u comment!="SafeLinks admin bypass"] } on-error={}
                }
                :if ($t = "set_ssid") do={
                    :do { [:parse (":foreach w in=[/interface wireless find] do={ /interface wireless set \$w ssid=\"" . $u . "\" }")] } on-error={}
                    :do { [:parse (":foreach w in=[/interface wifi find] do={ /interface wifi set \$w configuration.ssid=\"" . $u . "\" }")] } on-error={}
                }
                :if ($t = "reboot") do={ :set doReboot true }
            } on-error={ :set st "failed" }
            :do {
                /tool fetch url=($slApi . "/api/agent/commands/" . $cid . "/ack") http-method=post http-data=($auth . "&status=" . $st) check-certificate=no output=none
            } on-error={}
        }
    }
    :local sess ""
    :foreach a in=[/ip hotspot active find] do={
        :local u [/ip hotspot active get $a user]
        :local tb 0
        :do { :local uid [/ip hotspot user find name=$u]; :set tb ([/ip hotspot user get $uid bytes-in] + [/ip hotspot user get $uid bytes-out]) } on-error={}
        :set sess ($sess . [/ip hotspot active get $a mac-address] . "," . [/ip hotspot active get $a address] . "," . $u . "," . [/ip hotspot active get $a bytes-in] . "," . [/ip hotspot active get $a bytes-out] . "," . [/ip hotspot active get $a uptime] . "," . $tb . ";")
    }
    :local tot [/system resource get total-memory]
    :local used ($tot - [/system resource get free-memory])
    :do {
        /tool fetch url=($slApi . "/api/agent/report") http-method=post http-data=($auth . "&cpu=" . [/system resource get cpu-load] . "&ramUsed=" . $used . "&ramTotal=" . $tot . "&uptime=" . [/system resource get uptime] . "&sessions=" . $sess) check-certificate=no output=none
    } on-error={}
    :if ($doReboot) do={ :log warning "safelinks: reboot requested"; :delay 2s; /system reboot }
}

:local paired false
:do { /system script run safelinks-register; :set paired true } on-error={ :log error "safelinks: pairing failed" }
/system scheduler add name="safelinks-checkin" interval=15s start-time=startup on-event="/system script run safelinks-checkin" policy=read,write,policy,test,reboot
:do { /system script run safelinks-checkin } on-error={}
:if ($paired) do={ :put "SAFE_Links: STATUS OK" } else={ :put "SAFE_Links: STATUS PAIRING-FAILED (hotspot configured; check internet and pairing code)" }
:log info "safelinks: setup done"
