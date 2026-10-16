# safelinks-bootstrap.rsc — RouterOS 7.x compatible. No multiline source blocks.
:global safelinksApiBase "https://www.safelinks.name.ng"
:local slCode "PASTE-CODE-HERE"

:local slId [/system identity get name]
:local slModel [/system routerboard get model]
:local slFw [/system package get [find name=routeros] version]

:local slPost ("code=" . $slCode . "&model=" . $slModel . "&firmware=" . $slFw . "&identity=" . $slId)
:local slRes ""
:do {
  :set slRes [/tool fetch url=($safelinksApiBase . "/api/agent/register") http-method=post http-data=$slPost as-value output=user]
} on-error={
  :log error "safelinks-bootstrap: register fetch failed"
  :error "safelinks-bootstrap: network error"
}
:local slBody ($slRes->"data")

:if ([:find $slBody "STATUS OK"] = nil) do={
  :log error ("safelinks-bootstrap: rejected — " . $slBody)
  :error "safelinks-bootstrap: register rejected"
}

:local slRid ""
:local slKey ""
:local slPR [:find $slBody "ROUTER_ID "]
:local slPK [:find $slBody "API_KEY "]
:if ($slPR != nil) do={
  :local slStart ($slPR + 10)
  :local slEnd [:find $slBody "\n" $slStart]
  :if ($slEnd = nil) do={ :set slEnd [:len $slBody] }
  :set slRid [:pick $slBody $slStart $slEnd]
}
:if ($slPK != nil) do={
  :local slStart ($slPK + 8)
  :local slEnd [:find $slBody "\n" $slStart]
  :if ($slEnd = nil) do={ :set slEnd [:len $slBody] }
  :set slKey [:pick $slBody $slStart $slEnd]
}

:if (($slRid = "") or ($slKey = "")) do={
  :log error "safelinks-bootstrap: missing creds"
  :error "safelinks-bootstrap: parse error"
}

:local slCreds ($slRid . "\n" . $slKey)
/file remove [find name="safelinks-credentials.txt"]
/file add name="safelinks-credentials.txt" contents=$slCreds

:local slCkUrl ($safelinksApiBase . "/api/agent/heartbeat.rsc?rid=" . $slRid . "&key=" . $slKey)
:local slHbBody ("/tool fetch url=\"" . $slCkUrl . "\" dst-path=safelinks-cmd.rsc check-certificate=no\n/import file=safelinks-cmd.rsc\n")

/file remove [find name="safelinks-heartbeat.rsc"]
/file add name="safelinks-heartbeat.rsc" contents=$slHbBody

/system scheduler remove [find name="safelinks-checkin"]
/system scheduler add name="safelinks-checkin" interval=30s on-event="/import file=safelinks-heartbeat.rsc"

:put ("safelinks-bootstrap: OK rid=" . $slRid)
:log info ("safelinks-bootstrap: paired as " . $slRid)
