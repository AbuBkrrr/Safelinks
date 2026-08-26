# =============================================================================
# Reslink zero-touch agent — MikroTik RouterOS 7.x
# =============================================================================
#
# WHAT THIS DOES
#   Installs two named scripts on the router:
#     reslink-register  — run ONCE, by hand, using a short pairing code
#                          generated from the reseller's dashboard
#                          (installer wizard -> "Pair a router"). This is
#                          the ONLY thing typed in by hand anywhere in
#                          this flow — the router reports its own model
#                          and RouterOS version itself.
#     reslink-checkin    — installed as a /system scheduler job that runs
#                          every 30s once pairing succeeds. Polls
#                          POST /api/agent/checkin, and executes whatever
#                          voucher commands (create/enable/disable/delete
#                          hotspot user) Reslink has queued.
#
# WHAT THIS ASSUMES
#   A working /ip hotspot server already exists on this router (interface,
#   IP pool, DNS, walled garden — the normal MikroTik "Hotspot Setup"
#   wizard, done once per site). This script does NOT create or modify
#   your hotspot network setup — guessing at your interface/IP ranges
#   would be more likely to break an install than help one. It only
#   manages /ip hotspot user entries (the vouchers) once a hotspot
#   already exists.
#
# BEFORE YOU RUN THIS
#   1. Edit RESLINK_API_URL below if you're not using the default domain.
#   2. From the reseller dashboard, go to Routers -> "Pair a new router",
#      copy the 6-character code shown (expires in 15 minutes).
#   3. Import this file: /import file=reslink-agent.rsc
#   4. Run once: /system script run reslink-register
#      It will prompt for the pairing code via :environment or you can
#      set it directly — see the "SET YOUR PAIRING CODE HERE" line below.
#
# ⚠ VALIDATION STATUS
#   This script was written against documented RouterOS 7 scripting
#   syntax (/tool fetch ... as-value output=user, :do/on-error blocks,
#   /ip hotspot user management) but has NOT been run against a physical
#   router or a Cloud Hosted Router (CHR) instance in this environment —
#   there was no RouterOS available to test against. Validate on a spare
#   device or a CHR VM before rolling this out to production routers.
# =============================================================================

:global resLinkApiUrl "https://api.reslink.io"
:global resLinkCredFile "reslink-credentials.txt"

# ---------------------------------------------------------------------------
# reslink-register — run this ONE TIME by hand
# ---------------------------------------------------------------------------
/system script
:if ([:len [/system script find name="reslink-register"]] > 0) do={ remove [find name="reslink-register"] }
add name="reslink-register" source={
  :global resLinkApiUrl
  :global resLinkCredFile

  # === SET YOUR PAIRING CODE HERE (the 6-character code from the dashboard) ===
  :local pairingCode "PASTE-CODE-HERE"

  :if ($pairingCode = "PASTE-CODE-HERE") do={
    :log warning "reslink-register: edit this script and set \$pairingCode to the code from your dashboard before running it."
    :error "reslink-register: pairing code not set"
  }

  :local routerIdentity [/system identity get name]
  :local routerModel [/system routerboard get model]
  :local routerFirmware ("RouterOS " . [/system package get [find name="routeros"] version])

  :local postData ("code=" . $pairingCode . "&model=" . $routerModel . "&firmware=" . $routerFirmware . "&identity=" . $routerIdentity)

  :local result ""
  :do {
    :local fetchResult [/tool fetch url=($resLinkApiUrl . "/api/agent/register") http-method=post http-data=$postData as-value output=user]
    :set result ($fetchResult->"data")
  } on-error={
    :log error "reslink-register: could not reach Reslink — check RESLINK_API_URL and internet connectivity"
    :error "reslink-register: fetch failed"
  }

  :if ([:find $result "STATUS OK"] = nil) do={
    :log error ("reslink-register: registration failed — " . $result)
    :error "reslink-register: server rejected registration (see log)"
  }

  # Pull ROUTER_ID and API_KEY out of the plain-text response. Each is on
  # its own line as "ROUTER_ID <value>" / "API_KEY <value>" — find the
  # line, then take everything after the first space.
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
    :log error "reslink-register: could not parse ROUTER_ID/API_KEY from response"
    :error "reslink-register: parse failure (see log)"
  }

  # Persist to a file so reslink-checkin.rsc survives a reboot — a
  # :global variable set here does NOT survive a router restart, but a
  # file does.
  :local credContents ($routerId . "\n" . $apiKey . "\n")
  :if ([:len [/file find name=$resLinkCredFile]] > 0) do={ /file remove [find name=$resLinkCredFile] }
  /file add name=$resLinkCredFile contents=$credContents

  :log info ("reslink-register: paired successfully as " . $routerId)
  :put ("Paired. Router ID: " . $routerId . " — starting check-in scheduler.")

  # Enable the recurring check-in now that we have credentials.
  /system scheduler enable [find name="reslink-checkin"]
}

# ---------------------------------------------------------------------------
# reslink-checkin — runs every 30s via the scheduler below, once paired
# ---------------------------------------------------------------------------
/system script
:if ([:len [/system script find name="reslink-checkin"]] > 0) do={ remove [find name="reslink-checkin"] }
add name="reslink-checkin" source={
  :global resLinkApiUrl
  :global resLinkCredFile

  :if ([:len [/file find name=$resLinkCredFile]] = 0) do={
    :log warning "reslink-checkin: not paired yet — run reslink-register first"
    :error "reslink-checkin: no credentials file"
  }

  :local credContents [/file get [find name=$resLinkCredFile] contents]
  :local nl1 [:find $credContents "\n"]
  :local routerId [:pick $credContents 0 $nl1]
  :local rest [:pick $credContents ($nl1 + 1) [:len $credContents]]
  :local nl2 [:find $rest "\n"]
  :local apiKey [:pick $rest 0 $nl2]

  :local postData ("router_id=" . $routerId . "&api_key=" . $apiKey)
  :local result ""
  :do {
    :local fetchResult [/tool fetch url=($resLinkApiUrl . "/api/agent/checkin") http-method=post http-data=$postData as-value output=user]
    :set result ($fetchResult->"data")
  } on-error={
    :log warning "reslink-checkin: could not reach Reslink this cycle — will retry next scheduled run"
    :error "reslink-checkin: fetch failed"
  }

  :if ([:find $result "STATUS OK"] = nil) do={
    :log warning ("reslink-checkin: server rejected check-in — " . $result)
    :error "reslink-checkin: bad response"
  }

  # Walk the response line by line. Fixed field order, space-separated:
  #   CMD <id> <type> <username> <password> <deviceLimit> <bandwidthMbps>
  # "-" means "field not applicable to this command type".
  :local pos 0
  :while ($pos < [:len $result]) do={
    :local nl [:find $result "\n" $pos]
    :if ($nl = nil) do={ :set nl [:len $result] }
    :local line [:pick $result $pos $nl]
    :set pos ($nl + 1)
    :if ([:pick $line 0 4] = "CMD ") do={
      :local rest2 [:pick $line 4 [:len $line]]
      # Split rest2 on spaces into up to 6 fields.
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
        :set execDetail ("RouterOS command threw an error executing " . $cmdType . " for " . $cmdUser)
      }

      :local ackData ("router_id=" . $routerId . "&api_key=" . $apiKey . "&status=" . $execStatus . "&detail=" . $execDetail)
      :do {
        /tool fetch url=($resLinkApiUrl . "/api/agent/commands/" . $cmdId . "/ack") http-method=post http-data=$ackData output=none
      } on-error={
        :log warning ("reslink-checkin: could not ack command " . $cmdId . " — it will be re-sent next check-in if still pending")
      }
    }
  }
}

# ---------------------------------------------------------------------------
# Scheduler — starts disabled; reslink-register enables it on success
# ---------------------------------------------------------------------------
/system scheduler
:if ([:len [/system scheduler find name="reslink-checkin"]] > 0) do={ remove [find name="reslink-checkin"] }
add name="reslink-checkin" interval=30s on-event="/system script run reslink-checkin" disabled=yes

:put "Reslink agent scripts installed. Now edit reslink-register (set your pairing code) and run: /system script run reslink-register"
