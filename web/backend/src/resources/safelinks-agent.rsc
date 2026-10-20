:global safelinksApiUrl "https://backend-services-production-78d8.up.railway.app"
:global safelinksCredFile "SAFELINKS-credentials.txt"

/system script
:if ([:len [/system script find name="safelinks-register"]] > 0) do={ remove [find name="safelinks-register"] }
add name="safelinks-register" source={
  :global safelinksApiUrl
  :global safelinksCredFile
  :local pairingCode "PASTE-CODE-HERE"
  :if ($pairingCode = "PASTE-CODE-HERE") do={ :error "no code" }
  :local postData ("code=" . $pairingCode . "&model=RouterOS&firmware=7&identity=SAFELINKS")
  :local result ""
  :do {
    :local f [/tool fetch url=($safelinksApiUrl . "/api/agent/register") http-method=post http-data=$postData as-value output=user]
    :set result ($f->"data")
  } on-error={ :error "fetch failed" }
  :if ([:find $result "STATUS OK"] = nil) do={ :error "rejected" }
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
  :local credContents ($routerId . "\n" . $apiKey . "\n")
  :if ([:len [/file find name=$safelinksCredFile]] > 0) do={ /file remove [find name=$safelinksCredFile] }
  /file add name=$safelinksCredFile contents=$credContents
  /system scheduler enable [find name="safelinks-checkin"]
}

/system script
:if ([:len [/system script find name="safelinks-checkin"]] > 0) do={ remove [find name="safelinks-checkin"] }
add name="safelinks-checkin" source={
  :global safelinksApiUrl
  :global safelinksCredFile
  :if ([:len [/file find name=$safelinksCredFile]] = 0) do={ :error "no creds" }
  :local credContents [/file get [find name=$safelinksCredFile] contents]
  :local nl1 [:find $credContents "\n"]
  :local routerId [:pick $credContents 0 $nl1]
  :local rest [:pick $credContents ($nl1 + 1) [:len $credContents]]
  :local nl2 [:find $rest "\n"]
  :local apiKey [:pick $rest 0 $nl2]
  :local postData ("router_id=" . $routerId . "&api_key=" . $apiKey)
  :local result ""
  :do {
    :local f [/tool fetch url=($safelinksApiUrl . "/api/agent/checkin") http-method=post http-data=$postData as-value output=user]
    :set result ($f->"data")
  } on-error={ :error "fetch failed" }
  :if ([:find $result "STATUS OK"] = nil) do={ :error "bad response" }
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
      :local cmdUptime ($fields->6)
      :if ($cmdUptime = nil or $cmdUptime = "-") do={ :set cmdUptime "1d" }
      :do {
        :if ($cmdType = "create_user") do={
          /ip hotspot user remove [find name=$cmdUser]
          /ip hotspot user add name=$cmdUser password=$cmdPass mac-address=$cmdUser limit-uptime=$cmdUptime
        } else={ :if ($cmdType = "disconnect_user") do={
          /ip hotspot active remove [find mac-address=$cmdUser]
        }}
      } on-error={}
      :do {
        /tool fetch url=($safelinksApiUrl . "/api/agent/commands/" . $cmdId . "/ack") http-method=post http-data="status=completed" output=none
      } on-error={}
    }
  }
  :local sessArr []
  :do {
    :foreach a in=[/ip hotspot active find] do={
      :local mac [/ip hotspot active get $a mac-address]
      :local ip [/ip hotspot active get $a address]
      :local user [/ip hotspot active get $a user]
      :local bi [/ip hotspot active get $a bytes-in]
      :local bo [/ip hotspot active get $a bytes-out]
      :set sessArr ($sessArr, ("{\"mac\":\"" . $mac . "\",\"ip\":\"" . $ip . "\",\"user\":\"" . $user . "\",\"bytes_in\":" . $bi . ",\"bytes_out\":" . $bo . "}"))
    }
  } on-error={}
  :local postBody ("router_id=" . $routerId . "&api_key=" . $apiKey . "&sessions=" . [:pick $sessArr 1 [:len $sessArr]])
  :do {
    /tool fetch url=($safelinksApiUrl . "/api/agent/report") http-method=post http-data=$postBody output=none
  } on-error={}
}

/system scheduler
:if ([:len [/system scheduler find name="safelinks-checkin"]] > 0) do={ remove [find name="safelinks-checkin"] }
add name="safelinks-checkin" interval=30s on-event="/system script run safelinks-checkin" disabled=yes