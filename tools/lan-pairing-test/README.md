# LAN pairing test — run this on your own Windows machine

Claude's sandbox can't reach your router — it's not on your network at
all, no route exists from there to your LAN regardless of network
permissions. This tests the two most hardware-dependent pieces of LAN
router auto-pairing directly on a machine that actually is on your
network: yours.

`gatewayLocator.js` and `routerOsClient.js` here are copied verbatim
from `desktop-app/src/native/` in the main SAFE_Links package — not
rewritten for this test. A pass/fail here says something real about
the actual app.

## Setup (Windows)

1. Install [Node.js](https://nodejs.org) if you don't already have it
   — the LTS version, either works. This installs both `node` and
   `npm`.
2. Open **PowerShell** or **Command Prompt**, and `cd` into this
   folder (wherever you extracted it), e.g.:
   ```
   cd C:\Users\YourName\Downloads\lan-pairing-test
   ```
3. Install the one dependency:
   ```
   npm install
   ```
4. Run it:
   ```
   node test.js
   ```

## What it does

**Step 1 (automatic, no input needed):** finds your PC's default
gateway IP address. This is the part worth actually testing — it's
never been run on Windows before now. On Linux (where this was built
and tested) it shells out to the `ip` command; on Windows it uses a
completely different code path inside the `default-gateway` package
(historically `wmic`, though that's been deprecated and removed on
newer Windows builds — if step 1 fails with something mentioning
`wmic`, that's a real, useful finding, not a false alarm, and worth
telling Claude about so the desktop app's gateway detection can be
fixed for modern Windows before you rely on it).

**Step 2 (optional, asks first):** since your router isn't MikroTik,
this step connecting and getting back "doesn't look like RouterOS" —
or failing to connect at all — **is the correct, expected result**,
not a bug. It's here to confirm the code fails cleanly on a router it
doesn't recognize, rather than hanging, crashing, or doing something
to a device it can't actually identify. You'll be asked for your
router's actual admin username/password if you choose to run this
step — typed directly into your own terminal, sent only to your own
router's IP address, never logged or transmitted anywhere else. Skip
it if you'd rather not, step 1 is the one that actually matters for a
first Windows test.

## What a genuine bug looks like here

Anything under "Unexpected crash" in the output — that's the one
outcome that would mean something is actually broken, as opposed to
the various "expected failure" messages the script itself calls out
along the way. If you see that, copy the full output and share it back
— that's a real finding, not an expected part of this test.
