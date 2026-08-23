"use strict";

/**
 * Standalone test harness for LAN router pairing's two most
 * hardware-dependent pieces — run directly on your own machine
 * (there's no route from Claude's sandbox to your LAN, which is why
 * this needs to run locally). These are the EXACT SAME files used by
 * the real desktop app (desktop-app/src/native/), copied verbatim,
 * not rewritten for this test — so a pass/fail here says something
 * real about the actual app, not just about this script.
 *
 * Two steps:
 *   1. Gateway detection (gatewayLocator.js) — finds your PC's
 *      default gateway IP. Works regardless of router brand. This is
 *      the part that's never been tested on Windows before now — it
 *      shells out to `wmic` on Windows specifically, a different code
 *      path than Linux/macOS, and the sandbox this was built in
 *      couldn't test it at all.
 *   2. RouterOS probe (routerOsClient.js) — optional, connects to
 *      that gateway over HTTPS and checks whether it speaks RouterOS's
 *      REST API. Since you said your router is a different brand,
 *      THIS STEP IS EXPECTED TO FAIL — either the connection won't
 *      complete at all (your router likely isn't listening on 443, or
 *      is but isn't RouterOS), or it'll connect and correctly report
 *      "doesn't look like RouterOS". Either outcome is success for
 *      this test: it means the code fails cleanly instead of hanging,
 *      crashing, or (worst case) doing something to a router it
 *      doesn't actually recognize.
 */

const readline = require("node:readline");
const { locateGateway } = require("./gatewayLocator.js");
const { RouterOsClient } = require("./routerOsClient.js");

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer); }));
}

async function main() {
  console.log("=== Step 1: gateway detection ===\n");

  const gateway = await locateGateway();
  if (gateway.error) {
    console.log("FAILED:", gateway.error);
    console.log("\nThis means gatewayLocator.js could not find your default gateway.");
    console.log("Common cause on Windows: 'wmic' is deprecated in newer Windows builds");
    console.log("(Windows 11 24H2+ removed it by default) - if that's what happened here,");
    console.log("that's a genuinely useful finding, not a false alarm.");
    process.exit(1);
  }

  console.log("SUCCESS: found gateway at", gateway.gatewayIp);
  console.log("\nDouble check: does that match your router's actual LAN IP");
  console.log("(printed on the router, or visible in its admin panel)?");

  const proceed = await ask(
    "\n=== Step 2 (optional): probe this address for a RouterOS REST API ===\n" +
    "Since your router isn't MikroTik, this is EXPECTED to fail - that's the\n" +
    "correct, safe outcome, not a bug. Try it anyway? [y/N] "
  );

  if (!/^y(es)?$/i.test(proceed.trim())) {
    console.log("\nSkipped. Gateway detection is the part that mattered most for a");
    console.log("first Windows test - that part passed.");
    return;
  }

  const adminUser = (await ask("Router admin username (default 'admin', just for this local test - never sent anywhere but your own router): ")) || "admin";
  const adminPass = await ask("Router admin password (shown in plain text - this is your own terminal, nothing is logged or transmitted elsewhere): ");

  console.log("\nConnecting to", gateway.gatewayIp, "over HTTPS (port 443)...");
  const client = new RouterOsClient(gateway.gatewayIp);
  const result = await client.probe(adminUser, adminPass);

  console.log("\n=== Result ===");
  console.log(JSON.stringify(result, null, 2));

  if (result.type === "Success") {
    console.log("\nUnexpected - this actually looked like a RouterOS device.");
    console.log("Fingerprint captured:", client.pinnedFingerprint);
  } else if (result.type === "NetworkError") {
    console.log("\nExpected outcome: couldn't establish a matching HTTPS connection.");
    console.log("This confirms the client fails cleanly instead of hanging or crashing.");
  } else if (result.type === "HttpError") {
    console.log("\nExpected outcome: connected, but what answered didn't look like");
    console.log("RouterOS's REST API (almost certainly your router's own admin login");
    console.log("page instead). This confirms the 'doesn't look like RouterOS' check works.");
  }
}

main().catch((e) => {
  console.error("\nUnexpected crash (this WOULD be a real bug, please share this output):");
  console.error(e);
  process.exit(1);
});
