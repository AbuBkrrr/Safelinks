# =============================================================================
# SAFELINKS zero-touch agent
# =============================================================================

:global safelinksApiUrl "https://backend-services-production-78d8.up.railway.app"
:global safelinksCredFile "SAFELINKS-credentials.txt"

# ---------------------------------------------------------------------------
# safelinks-register
# ---------------------------------------------------------------------------
/system script
:if ([:len [/system script find name="safelinks-register"]] > 0) do={ remove [find name="safelinks-register"] }
add name="safelinks-register" source={
  :global safelinksApiUrl
  :global safelinksCredFile
  :local pairingCode "PASTE-CODE-HERE"
  :if ($pairingCode = "PASTE-CODE-HERE") do={
    :log warning "safelinks-register: edit this script and set pairingCode"
    :error "safelinks-register: pairing code not set"
  }
  :local routerIdentity [/system identity get name]
  :local routerModel [/system routerboard get model]
  :local routerFirmware ("RouterOS " . [/system package get [find name="routeros"] version])
  :local postData ("code=" . $pairingCode . "&model=" . $routerModel . "&firmware=" . $routerFirmware . "&identity=" . $routerIdentity)
  :local result ""
  :do {
    :local fetchResult [/tool fetch url=($safelinksApiUrl . "/api/agent/register") http-method=post http-data=$postData as-value output=user]
    :set result ($fetchResult->"data")
  } on-error={
    :log error "safelinks-register: could not reach SAFELINKS"
    :error "safelinks-register: fetch failed"
  }
  :if ([:find $result "STATUS OK"] = nil) do={
    :log error ("safelinks-register: registration failed — " . $result)
    :error "safelinks-register: server rejected registration"
  }
  :local routerId ""
  :local apiKey ""
  :local pos 0
  :while ($pos < [:len $result]) do={
    :local nl [:find $result "\n" $pos]
    :if ($nl = nil) do={ :set nl [:len $result] }
    :local line [:pick $result $pos $nl]
    :if ([:pick $line 0 10] = "ROUTER_ID ") do={ :set routerId [:pick $line 10 [:len $line]] }
    :if ([:pick $line 0 8] = "API_KEY ") do={ :set apiKey [:pick $line 8 [:len $line]] }
    :set pos ($nl + 1)
  }
  :if ($routerId = "" or $apiKey = "") do={
    :log error "safelinks-register: could not parse ROUTER_ID/API_KEY"
    :error "safelinks-register: parse failure"
  }
  :local credContents ($routerId . "\n" . $apiKey . "\n")
  :if ([:len [/file find name=$safelinksCredFile]] > 0) do={ /file remove [find name=$safelinksCredFile] }
  /file add name=$safelinksCredFile contents=$credContents
  :log info ("safelinks-register: paired successfully as " . $routerId)
  :put ("Paired. Router ID: " . $routerId)
  /system scheduler enable [find name="safelinks-checkin"]
}

# ---------------------------------------------------------------------------
# safelinks-checkin
# ---------------------------------------------------------------------------
/system script
:if ([:len [/system script find name="safelinks-checkin"]] > 0) do={ remove [find name="safelinks-checkin"] }
add name="safelinks-checkin" source={
  :global safelinksApiUrl
  :global safelinksCredFile
  :if ([:len [/file find name=$safelinksCredFile]] = 0) do={
    :log warning "safelinks-checkin: not paired yet"
    :error "safelinks-checkin: no credentials file"
  }
  :local credContents [/file get [find name=$safelinksCredFile] contents]
  :local nl1 [:find $credContents "\n"]
  :local routerId [:pick $credContents 0 $nl1]
  :local rest [:pick $credContents ($nl1 + 1) [:len $credContents]]
  :local nl2 [:find $rest "\n"]
  :local apiKey [:pick $rest 0 $nl2]
  :local postData ("router_id=" . $routerId . "&api_key=" . $apiKey)
  :local result ""
  :do {
    :local fetchResult [/tool fetch url=($safelinksApiUrl . "/api/agent/checkin") http-method=post http-data=$postData as-value output=user]
    :set result ($fetchResult->"data")
  } on-error={
    :log warning "safelinks-checkin: could not reach SAFELINKS"
    :error "safelinks-checkin: fetch failed"
  }
  :if ([:find $result "STATUS OK"] = nil) do={
    :log warning ("safelinks-checkin: server rejected check-in — " . $result)
    :error "safelinks-checkin: bad response"
  }
  :local pos 0
  :while ($pos < [:len $result]) do={
    :local nl [:find $result "\n" $pos]
    :if ($nl = nil) do={ :set nl [:len $result] }
    :local line [:pick $result $pos $nl]
    :set pos ($nl + 1)
    :if ([:pick $line 0 4] = "CMD ") do={
      :local rest2 [:pick $line 4 [:len $line]]
      :local fields {}
      :local fpos 0
      :while ($fpos <= [:len $rest2]) do={
        :local sp [:find $rest2 " " $fpos]
        :if ($sp = nil) do={ :set sp [:len $rest2] }
        :set fields ($fields, [:pick $rest2 $fpos $sp])
        :set fpos ($sp + 1)
      }
      :local cmdId ($fields->0)
      :local cmdType ($fields->1)
      :local cmdUser ($fields->2)
      :local cmdPass ($fields->3)
      :local cmdDeviceLimit ($fields->4)
      :local cmdBandwidth ($fields->5)
      :local cmdUptime ($fields->6)
      
      :if ($cmdUptime = nil or $cmdUptime = "-") do={ :set cmdUptime "1d" }
      
      :local execStatus "executed"
      :local execDetail ""
      :do {
        :if ($cmdType = "create_user") do={
          :local rateLimit ($cmdBandwidth . "M/" . $cmdBandwidth . "M")
          /ip hotspot user remove [find name=$cmdUser]
          /ip hotspot user add name=$cmdUser password=$cmdPass mac-address=$cmdUser limit-uptime=$cmdUptime rate-limit=$rateLimit
        } else={ :if ($cmdType = "bind_mac") do={
          /ip hotspot ip-binding remove [find mac-address=$cmdUser]
          /ip hotspot ip-binding add mac-address=$cmdUser type=bypassed comment="SAFELinks auto"
        } else={ :if ($cmdType = "disconnect_user") do={
          /ip hotspot active remove [find mac-address=$cmdUser]
        } else={
          :set execStatus "failed"
          :set execDetail ("unknown cmd: " . $cmdType)
        }}}
      } on-error={
        :set execStatus "failed"
        :set execDetail ("RouterOS error on " . $cmdType)
      }
      :local ackData ("router_id=" . $routerId . "&api_key=" . $apiKey . "&status=" . $execStatus . "&detail=" . $execDetail)
      :do {
        /tool fetch url=($safelinksApiUrl . "/api/agent/commands/" . $cmdId . "/ack") http-method=post http-data=$ackData output=none
      } on-error={}
    }
  }
  
  # --- REPORT ACTIVE SESSIONS ---
  :local sessArr []
  :do {
    :foreach a in=[/ip hotspot active find] do={
      :local mac [/ip hotspot active get $a mac-address]
      :local ip [/ip hotspot active get $a address]
      :local user [/ip hotspot active get $a user]
      :local up [/ip hotspot active get $a uptime]
      :local bi [/ip hotspot active get $a bytes-in]
      :local bo [/ip hotspot active get $a bytes-out]
      :set sessArr ($sessArr, ("{\"mac\":\"" . $mac . "\",\"ip\":\"" . $ip . "\",\"user\":\"" . $user . "\",\"uptime\":\"" . $up . "\",\"bytes_in\":" . $bi . ",\"bytes_out\":" . $bo . "}"))
    }
  } on-error={}
  :local postBody ("router_id=" . $routerId . "&api_key=" . $apiKey . "&sessions=" . [:pick $sessArr 1 [:len $sessArr]])
  :do {
    /tool fetch url=($safelinksApiUrl . "/api/agent/report") http-method=post http-data=$postBody output=none
  } on-error={}
}

# ---------------------------------------------------------------------------
# Scheduler
# ---------------------------------------------------------------------------
/system scheduler
:if ([:len [/system scheduler find name="safelinks-checkin"]] > 0) do={ remove [find name="safelinks-checkin"] }
add name="safelinks-checkin" interval=30s on-event="/system script run safelinks-checkin" disabled=yes

:put "SAFELINKS agent scripts installed. Run: /system script run safelinks-register"