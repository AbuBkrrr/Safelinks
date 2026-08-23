"use strict";

/**
 * Finds the LAN default gateway IP, cross-platform.
 *
 * Deliberately NOT hand-parsing `route print` (Windows) / `netstat`
 * (macOS) / `ip route` (Linux) output directly — that's exactly the
 * kind of platform-specific text-parsing that's easy to get subtly
 * wrong and hard to verify without access to all three real OSes to
 * test against, which this environment doesn't have. `default-gateway`
 * (https://github.com/silverwind/default-gateway) is a small, widely
 * used package that already does this correctly per-platform; adding
 * it as a dependency here is the more responsible choice than
 * reinventing it uncertainly.
 *
 * Unlike the Android/Kotlin GatewayLocator, this does NOT report
 * whether the connection is WiFi vs. something else. That check
 * existed on Android specifically to stop LAN pairing from being
 * attempted over cellular data. A desktop machine doesn't have a
 * cellular modem in the typical case, and being on Ethernet instead
 * of WiFi is an equally legitimate way to be on the same LAN as a
 * router — so there's nothing meaningful to gate on here, and this
 * intentionally doesn't fake an "isWifi" flag via an unreliable
 * heuristic (e.g. guessing from interface name conventions, which
 * differ across Windows/macOS/Linux and aren't something this module
 * could verify against real hardware in this environment either).
 */

async function locateGateway() {
  let defaultGateway;
  try {
    // Lazily required so a missing/not-yet-installed dependency only
    // breaks LAN pairing specifically, not the whole app at startup.
    defaultGateway = require("default-gateway");
  } catch (e) {
    return { error: "The 'default-gateway' package isn't installed - run npm install." };
  }

  try {
    // gateway4async() — NOT v4(), which some published docs for older
    // major versions of this package show. Confirmed against the
    // actual installed package (7.2.2) by running it directly: the
    // real export list is gateway4async/gateway4sync/gateway6async/
    // gateway6sync, returning {gateway, version, int}. An earlier pass
    // used defaultGateway.v4() based on a search result for an older
    // version's API and it genuinely failed at runtime ("v4 is not a
    // function") - caught by actually executing this against the
    // installed package rather than trusting the docs found.
    const result = await defaultGateway.gateway4async();
    if (!result || !result.gateway) {
      return { error: "Could not determine the LAN gateway." };
    }
    return { gatewayIp: result.gateway };
  } catch (e) {
    return { error: `Could not determine the LAN gateway: ${e.message}` };
  }
}

module.exports = { locateGateway };
