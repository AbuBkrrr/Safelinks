"use strict";

/**
 * The router setup script lives only on the SAFE_Links backend
 * (GET /api/setup/<CODE>.rsc). Every installer, this app included, runs the
 * same one line on the router, so a copy of this app downloaded or shared
 * long ago still applies today's script.
 */

const PAIRING_CODE_RE = /^[A-Z0-9]{4,10}$/;

class InvalidPairingCodeError extends Error {
  constructor(code) {
    super(`Pairing code "${code}" is not valid - expected 4-10 letters/digits from your dashboard.`);
    this.name = "InvalidPairingCodeError";
  }
}

function trimTrailingSlash(s) {
  return String(s || "").replace(/\/+$/, "");
}

function buildSetupCommand(pairingCode, apiBaseUrl) {
  const code = String(pairingCode || "").trim().toUpperCase();
  if (!PAIRING_CODE_RE.test(code)) throw new InvalidPairingCodeError(pairingCode);
  const api = trimTrailingSlash(apiBaseUrl);
  return `/tool fetch url="${api}/api/setup/${code}.rsc" dst-path=safelinks-setup.rsc check-certificate=no; :delay 2s; /import safelinks-setup.rsc`;
}

module.exports = { buildSetupCommand, InvalidPairingCodeError };
