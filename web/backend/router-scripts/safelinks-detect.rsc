# safelinks-detect.rsc — reports current router state as KEY=VALUE lines.
# Used by the SafeLinks installer to decide auto / manual / skip.

:local wanType "none"
:if ([:len [/ip dhcp-client find]] > 0) do={ :set wanType "dhcp" }
:if ([:len [/interface pppoe-client find]] > 0) do={ :set wanType "pppoe" }
:if ([:len [/ip address find interface="ether1"]] > 0) do={ :set wanType "static" }

:local wanIp "-"
:if ([:len [/ip address find interface="ether1"]] > 0) do={
    :set wanIp [/ip address get [find interface="ether1"] address]
}

:local lanIp "-"
:if ([:len [/ip address find interface="ether2"]] > 0) do={
    :set lanIp [/ip address get [find interface="ether2"] address]
}

:local ssid "-"
:if ([:len [/interface wifi find]] > 0) do={
    :set ssid [/interface wifi get [find] ssid]
} else={
    :if ([:len [/interface wireless find]] > 0) do={
        :set ssid [/interface wireless get [find] ssid]
    }
}

:local hasHotspot "no"
:if ([:len [/ip hotspot find]] > 0) do={ :set hasHotspot "yes" }

:put ("WAN_TYPE=" . $wanType)
:put ("WAN_IP=" . $wanIp)
:put ("LAN_IP=" . $lanIp)
:put ("WIFI_SSID=" . $ssid)
:put ("HAS_HOTSPOT=" . $hasHotspot)
:put ("STATUS OK")
