"use strict";

/**
 * Node port of RouterOsScripts (see the Kotlin/Java versions for the
 * fuller design writeup). Faithfully ports the LOGIC of
 * reslink-backend/router-scripts/reslink-agent.rsc — same HTTP calls,
 * same response parsing, same hotspot-user command handling, same
 * credential persistence — verified by actually diffing this
 * function's generated output against that file directly, not just
 * asserted. It is NOT a byte-identical copy: the one-shot
 * registration step runs inline via /rest/execute here instead of
 * being installed as a separate persisted script object (that
 * restructuring is deliberate — a script that only ever runs once
 * doesn't need to persist as a named router object), and log message
 * wording is paraphrased rather than copied verbatim. Neither
 * difference changes what the router actually does. That source
 * file's own header says it was written against documented RouterOS 7
 * syntax, not validated against physical hardware — this generator
 * inherits that same status. Test against a spare device or a Cloud
 * Hosted Router before relying on this in the field.
 *
 * No escaping tricks needed here unlike the Kotlin port — RouterOS's
 * own `$variable` syntax never collides with JS template literal
 * interpolation (`${...}`), since RouterOS doesn't use braces.
 */

const PAIRING_CODE_RE = /^[A-Z0-9]{4,10}$/;

class InvalidPairingCodeError extends Error {
  constructor(code) {
    super(`Pairing code has an unexpected format: ${code}`);
    this.name = "InvalidPairingCodeError";
  }
}

function trimTrailingSlash(s) {
  return s.replace(/\/+$/, "");
}

/**
 * Step 1 (run once, idempotent): installs the recurring checkin
 * script + a disabled scheduler entry. Safe to re-run.
 *
 * Assumes frontend and backend share an origin (true by default in
 * this project's own docker-compose.yml/Caddy setup). If that ever
 * changes, apiBaseUrl needs its own config field instead of reusing
 * the app's configured server URL.
 */
function buildInstallCheckinScript(apiBaseUrl) {
  const api = trimTrailingSlash(apiBaseUrl);
  return `:global resLinkApiUrl "${api}"
:global resLinkCredFile "reslink-credentials.txt"

/system script
:if ([:len [/system script find name="reslink-checkin"]] > 0) do={ remove [find name="reslink-checkin"] }
add name="reslink-checkin" source={
  :global resLinkApiUrl
  :global resLinkCredFile

  :if ([:len [/file find name=$resLinkCredFile]] = 0) do={
    :log warning "reslink-checkin: not paired yet"
    :error "reslink-checkin: no credentials file"
  }

  :local credContents [/file get [find name=$resLinkCredFile] contents]
  :local nl1 [:find $credContents "\\n"]
  :local routerId [:pick $credContents 0 $nl1]
  :local rest [:pick $credContents ($nl1 + 1) [:len $credContents]]
  :local nl2 [:find $rest "\\n"]
  :local apiKey [:pick $rest 0 $nl2]

  :local postData ("router_id=" . $routerId . "&api_key=" . $apiKey)
  :local result ""
  :do {
    :local fetchResult [/tool fetch url=($resLinkApiUrl . "/api/agent/checkin") http-method=post http-data=$postData as-value output=user]
    :set result ($fetchResult->"data")
  } on-error={
    :log warning "reslink-checkin: could not reach Reslink this cycle"
    :error "reslink-checkin: fetch failed"
  }

  :if ([:find $result "STATUS OK"] = nil) do={
    :log warning ("reslink-checkin: server rejected check-in - " . $result)
    :error "reslink-checkin: bad response"
  }

  :local pos 0
  :while ($pos < [:len $result]) do={
    :local nl [:find $result "\\n" $pos]
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
      :local cmdBandwidth ($fields->5)

      :local execStatus "executed"
      :local execDetail ""
      :do {
        :if ($cmdType = "create_user") do={
          :local rateLimit ($cmdBandwidth . "M/" . $cmdBandwidth . "M")
          :if ([:len [/ip hotspot user find name=$cmdUser]] > 0) do={
            /ip hotspot user set [find name=$cmdUser] password=$cmdPass rate-limit=$rateLimit
          } else={
            /ip hotspot user add name=$cmdUser password=$cmdPass rate-limit=$rateLimit
          }
        } else={ :if ($cmdType = "enable_user") do={
          /ip hotspot user enable [find name=$cmdUser]
        } else={ :if ($cmdType = "disable_user") do={
          /ip hotspot user disable [find name=$cmdUser]
        } else={ :if ($cmdType = "delete_user") do={
          /ip hotspot user remove [find name=$cmdUser]
        } else={
          :set execStatus "failed"
          :set execDetail ("unknown command type: " . $cmdType)
        }}}}
      } on-error={
        :set execStatus "failed"
        :set execDetail ("RouterOS command threw an error executing " . $cmdType)
      }

      :local ackData ("router_id=" . $routerId . "&api_key=" . $apiKey . "&status=" . $execStatus . "&detail=" . $execDetail)
      :do {
        /tool fetch url=($resLinkApiUrl . "/api/agent/commands/" . $cmdId . "/ack") http-method=post http-data=$ackData output=none
      } on-error={
        :log warning ("reslink-checkin: could not ack command " . $cmdId)
      }
    }
  }
}

/system scheduler
:if ([:len [/system scheduler find name="reslink-checkin"]] > 0) do={ remove [find name="reslink-checkin"] }
add name="reslink-checkin" interval=30s on-event="/system script run reslink-checkin" disabled=yes
:put "checkin script installed"
`;
}

/**
 * Step 2 (run once): the equivalent of a human running
 * `/system script run reslink-register` after pasting in the pairing
 * code by hand, except the code is baked in by the app and this runs
 * inline via /rest/execute rather than being saved as a named script.
 */
function buildRegisterScript(pairingCode, apiBaseUrl) {
  if (!PAIRING_CODE_RE.test(pairingCode)) {
    throw new InvalidPairingCodeError(pairingCode);
  }
  const api = trimTrailingSlash(apiBaseUrl);
  return `:global resLinkApiUrl "${api}"
:global resLinkCredFile "reslink-credentials.txt"
:local pairingCode "${pairingCode}"

:local routerIdentity [/system identity get name]
:local routerModel [/system routerboard get model]
:local routerFirmware ("RouterOS " . [/system package get [find name="routeros"] version])

:local postData ("code=" . $pairingCode . "&model=" . $routerModel . "&firmware=" . $routerFirmware . "&identity=" . $routerIdentity)

:local result ""
:do {
  :local fetchResult [/tool fetch url=($resLinkApiUrl . "/api/agent/register") http-method=post http-data=$postData as-value output=user]
  :set result ($fetchResult->"data")
} on-error={
  :log error "reslink-register: could not reach Reslink"
  :error "reslink-register: fetch failed"
}

:if ([:find $result "STATUS OK"] = nil) do={
  :log error ("reslink-register: registration failed - " . $result)
  :error "reslink-register: server rejected registration"
}

:local routerId ""
:local apiKey ""
:local pos 0
:while ($pos < [:len $result]) do={
  :local nl [:find $result "\\n" $pos]
  :if ($nl = nil) do={ :set nl [:len $result] }
  :local line [:pick $result $pos $nl]
  :if ([:pick $line 0 10] = "ROUTER_ID ") do={ :set routerId [:pick $line 10 [:len $line]] }
  :if ([:pick $line 0 8] = "API_KEY ") do={ :set apiKey [:pick $line 8 [:len $line]] }
  :set pos ($nl + 1)
}

:if ($routerId = "" or $apiKey = "") do={
  :log error "reslink-register: could not parse ROUTER_ID/API_KEY"
  :error "reslink-register: parse failure"
}

:local credContents ($routerId . "\\n" . $apiKey . "\\n")
:if ([:len [/file find name=$resLinkCredFile]] > 0) do={ /file remove [find name=$resLinkCredFile] }
/file add name=$resLinkCredFile contents=$credContents

/system scheduler enable [find name="reslink-checkin"]
:put ("ROUTER_ID=" . $routerId)
`;
}

module.exports = { buildInstallCheckinScript, buildRegisterScript, InvalidPairingCodeError };
