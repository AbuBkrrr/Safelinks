# Router agent scripts

Real, device-side scripts that make router provisioning zero-touch —
no reseller ever types in a router's model, firmware, or IP by hand.
Both speak the same vendor-agnostic wire protocol
(`POST /api/agent/register`, `/checkin`, `/commands/:id/ack` — plain
`KEY value`-per-line text, documented in `src/routes/agent.js`); only
the script that speaks it differs per platform.

## MikroTik RouterOS (`reslink-agent.rsc`)

**Status: written against documented RouterOS 7 scripting syntax, not
yet run against real hardware.** There was no RouterOS available to
test against in the environment this was built in — validate on a
spare device or a Cloud Hosted Router (CHR) VM before rolling it out to
production routers. It manages `/ip hotspot user` directly — RouterOS
has its own built-in hotspot user database, so no separate
captive-portal daemon is needed.

## Generic Linux — OpenWRT, EdgeOS, any Debian/Ubuntu gateway (`reslink-agent-linux.sh`)

**Status: registration and check-in genuinely tested end-to-end**
against a live Reslink backend — real HTTP calls, real credential
persistence to disk, real command dispatch and ack, not simulated.
**The default command-execution backend (CoovaChilli via
`chilli_query`) has NOT been tested** — no CoovaChilli install was
available either, so that one function was verified with a stand-in
script that just logged its arguments, confirming the *shape* of the
calls is right but not that a real `chilli_query` accepts them exactly
as written. Review `apply_command()` against your actual install.

Unlike MikroTik, most Linux-based router platforms don't have a
built-in hotspot user database — they're normally paired with a
separate captive-portal daemon (CoovaChilli is the most common
open-source one). So the script is split into two parts on purpose:
generic transport logic (registration, check-in, ack — works
identically regardless of what's managing your hotspot) and one
isolated `apply_command()` function you swap out for whatever your box
actually runs (a different `chilli_query` version, a RADIUS user table
via `radclient`, OpenNDS, etc).

**Usage:**
```sh
# 1. Generate a pairing code from the reseller dashboard (Routers -> "Pair a router")
# 2. Edit RESLINK_API_URL in the script if not using the default domain
./reslink-agent-linux.sh register PAIRING_CODE

# 3. Add to cron for 30-second check-ins (cron has no sub-minute
#    granularity, so two offset entries get you there):
#   * * * * *          /path/to/reslink-agent-linux.sh checkin
#   * * * * * sleep 30; /path/to/reslink-agent-linux.sh checkin
```

## What "universal" actually means here

Between the two scripts: MikroTik natively, plus any Linux-based
router platform that can run a POSIX shell script and cron (OpenWRT,
EdgeOS's underlying shell, generic Linux gateways) — which covers the
large majority of routers capable of running custom firmware at all.
What's still genuinely out of reach: closed consumer firmware with no
shell/scripting access whatsoever (stock Netgear/TP-Link firmware,
for example) — there's no code to run on those at all without
flashing different firmware first, which is a hardware decision, not
a software gap this project can close.
