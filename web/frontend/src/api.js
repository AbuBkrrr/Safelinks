// Real API client for the Reslink backend. Every function here hits a
// live endpoint documented in reslink-backend/README.md — nothing in
// this file is mock data. Auth token lives in localStorage (this is a
// real deployed web app, not a Claude Artifact, so that's fine here).

const BASE_URL = import.meta.env.VITE_API_URL || ""; // "" -> same-origin, works with the Vite dev proxy

const TOKEN_KEY = "reslink_token";
const ROLE_KEY = "reslink_role";
const USER_KEY = "reslink_user";

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}
export function getSession() {
  const token = localStorage.getItem(TOKEN_KEY);
  const role = localStorage.getItem(ROLE_KEY);
  const userRaw = localStorage.getItem(USER_KEY);
  if (!token || !role) return null;
  let user = null;
  try { user = userRaw ? JSON.parse(userRaw) : null; } catch { user = null; }
  return { token, role, user };
}
export function setSession(session) {
  localStorage.setItem(TOKEN_KEY, session.token);
  localStorage.setItem(ROLE_KEY, session.role);
  localStorage.setItem(USER_KEY, JSON.stringify(session.user || null));
}
export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(ROLE_KEY);
  localStorage.removeItem(USER_KEY);
}

class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function request(method, path, body, { auth = true } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (auth) {
    const token = getToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
  }
  let res;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new ApiError("Network error — could not reach the Reslink backend. Is it running?", 0, null);
  }
  let data = null;
  const text = await res.text();
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (!res.ok) {
    if (res.status === 401 && auth) {
      // Token missing/expired/invalid — force back to login.
      clearSession();
    }
    throw new ApiError(data?.error || `Request failed (${res.status})`, res.status, data);
  }
  return data;
}

const get = (path, opts) => request("GET", path, undefined, opts);
const post = (path, body, opts) => request("POST", path, body, opts);
const put = (path, body, opts) => request("PUT", path, body, opts);
const del = (path, opts) => request("DELETE", path, undefined, opts);

export const api = {
  ApiError,

  // --- Auth ---
  login: (email, password) => post("/api/auth/login", { email, password }, { auth: false }),
  signup: (email, password, companyName, securityQuestion, securityAnswer, referralCode) =>
    post("/api/auth/signup", { email, password, companyName, securityQuestion, securityAnswer, referralCode }, { auth: false }),
  getSecurityQuestion: (email) => post("/api/auth/password-reset/question", { email }, { auth: false }),
  verifySecurityAnswer: (email, answer) => post("/api/auth/password-reset/verify-answer", { email, answer }, { auth: false }),
  confirmPasswordReset: (token, newPassword) => post("/api/auth/password-reset/confirm", { token, newPassword }, { auth: false }),

  // --- Public captive portal ---
  portalInfo: (resellerId) => get(`/api/portal/${resellerId}/info`, { auth: false }),
  portalPlans: (resellerId) => get(`/api/portal/${resellerId}/plans`, { auth: false }),
  portalSignup: (resellerId, body) => post(`/api/portal/${resellerId}/signup`, body, { auth: false }),
  portalSupport: (resellerId, body) => post(`/api/portal/${resellerId}/support`, body, { auth: false }),
  portalUploadReceipt: (resellerId, body) => post(`/api/portal/${resellerId}/upload-receipt`, body, { auth: false }),
  portalUploadSupportAttachment: (resellerId, body) => post(`/api/portal/${resellerId}/support/upload`, body, { auth: false }),

  // --- Super Admin ---
  admin: {
    resellers: () => get("/api/admin/resellers"),
    setResellerStatus: (id, status) => put(`/api/admin/resellers/${id}/status`, { status }),
    platformPlans: () => get("/api/admin/platform-plans"),
    updatePlatformPlan: (id, body) => put(`/api/admin/platform-plans/${id}`, body),
    installations: () => get("/api/admin/installations"),
    sessions: () => get("/api/admin/sessions"),
    monitoring: () => get("/api/admin/monitoring"),
    licensePayments: () => get("/api/admin/license-payments"),
    decideLicensePayment: (id, decision) => put(`/api/admin/license-payments/${id}`, { decision }),

    generateProductKeys: (body) => post("/api/admin/product-keys/generate", body),
    productKeySummary: () => get("/api/admin/product-keys/summary"),
    productKeys: ({ status, batchLabel, limit } = {}) => {
      const qs = new URLSearchParams();
      if (status) qs.set("status", status);
      if (batchLabel) qs.set("batchLabel", batchLabel);
      if (limit) qs.set("limit", limit);
      const q = qs.toString();
      return get(`/api/admin/product-keys${q ? `?${q}` : ""}`);
    },
    revokeProductKey: (id) => put(`/api/admin/product-keys/${id}/revoke`, {}),
    revokeProductKeyBatch: (batchLabel) => put("/api/admin/product-keys/revoke-batch", { batchLabel }),
    // Bypasses the JSON-only request() helper — this response is a
    // downloadable text file (Content-Disposition: attachment), not
    // JSON, and a plain <a href> can't carry the Authorization header
    // this endpoint requires, hence fetch + blob + a synthetic click.
    downloadProductKeys: async ({ status = "unused", batchLabel } = {}) => {
      const qs = new URLSearchParams({ status });
      if (batchLabel) qs.set("batchLabel", batchLabel);
      const res = await fetch(`${BASE_URL}/api/admin/product-keys/export?${qs}`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      if (!res.ok) throw new ApiError(`Export failed (${res.status})`, res.status, null);
      const blob = await res.blob();
      const filename = res.headers.get("Content-Disposition")?.match(/filename="(.+)"/)?.[1] || "reslink-keys.txt";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    },

    support: () => get("/api/admin/support"),
    sendSupportMessage: (id, message, attachmentUrl) => post(`/api/admin/support/${id}/messages`, { message, attachmentUrl }),
    uploadSupportAttachment: (body) => post("/api/admin/support/upload", body),
    setSupportStatus: (id, status) => put(`/api/admin/support/${id}/status`, { status }),
    notifications: () => get("/api/admin/notifications"),
    markNotificationsRead: () => put("/api/admin/notifications/read-all", {}),
    markNotificationRead: (id) => put(`/api/admin/notifications/${id}/read`, {}),
    settings: () => get("/api/admin/settings"),
    updateSettings: (body) => put("/api/admin/settings", body),
    referrals: () => get("/api/admin/referrals"),
    updateReferralBonus: (id, bonusAmount) => put(`/api/admin/referrals/${id}`, { bonusAmount }),
    markReferralPaid: (id) => put(`/api/admin/referrals/${id}/mark-paid`, {}),
  },

  // --- Reseller ---
  reseller: {
    vouchers: () => get("/api/reseller/vouchers"),
    setVoucherStatus: (id, status) => put(`/api/reseller/vouchers/${id}/status`, { status }),
    deleteVoucher: (id) => del(`/api/reseller/vouchers/${id}`),

    sessions: () => get("/api/reseller/sessions"),
    disconnectSession: (id) => del(`/api/reseller/sessions/${id}`),

    routers: () => get("/api/reseller/routers"),
    registerRouter: (body) => post("/api/reseller/routers", body),
    createPairingCode: () => post("/api/reseller/pairing-codes", {}),
    pairingCodeStatus: (code) => get(`/api/reseller/pairing-codes/${code}`),
    commands: () => get("/api/reseller/commands"),

    deliveryLogs: () => get("/api/reseller/delivery-logs"),
    retryDelivery: (id) => post(`/api/reseller/delivery-logs/${id}/retry`, {}),

    plans: () => get("/api/reseller/plans"),
    createPlan: (body) => post("/api/reseller/plans", body),
    updatePlan: (id, body) => put(`/api/reseller/plans/${id}`, body),
    deletePlan: (id) => del(`/api/reseller/plans/${id}`),
    platformPlans: () => get("/api/reseller/platform-plans"),

    portalSettings: () => get("/api/reseller/portal-settings"),
    updatePortalSettings: (body) => put("/api/reseller/portal-settings", body),

    pendingActivations: () => get("/api/reseller/pending-activations"),
    decidePendingActivation: (id, decision) => put(`/api/reseller/pending-activations/${id}`, { decision }),

    billing: () => get("/api/reseller/billing"),
    platformBankInfo: () => get("/api/reseller/platform-bank-info"),
    license: () => get("/api/reseller/license"),
    renewLicense: (body) => post("/api/reseller/license/renew", body),
    uploadReceipt: (body) => post("/api/reseller/upload-receipt", body),

    notifications: () => get("/api/reseller/notifications"),
    markNotificationsRead: () => put("/api/reseller/notifications/read-all", {}),
    markNotificationRead: (id) => put(`/api/reseller/notifications/${id}/read`, {}),

    support: () => get("/api/reseller/support"),
    createSupportTicket: (body) => post("/api/reseller/support", body),
    sendSupportMessage: (id, message, attachmentUrl) => post(`/api/reseller/support/${id}/messages`, { message, attachmentUrl }),
    setSupportStatus: (id, status) => put(`/api/reseller/support/${id}/status`, { status }),
    uploadSupportAttachment: (body) => post("/api/reseller/support/upload", body),
    customerSupport: () => get("/api/reseller/customer-support"),
    sendCustomerSupportMessage: (id, message, attachmentUrl) => post(`/api/reseller/customer-support/${id}/messages`, { message, attachmentUrl }),
    setCustomerSupportStatus: (id, status) => put(`/api/reseller/customer-support/${id}/status`, { status }),

    referrals: () => get("/api/reseller/referrals"),
    createReferral: (body) => post("/api/reseller/referrals", body),
    deleteReferral: (id) => del(`/api/reseller/referrals/${id}`),

    redeemProductKey: (key) => post("/api/reseller/product-key/redeem", { key }),
  },
};

// Reads a File into a base64 data: URL, for the upload-receipt
// endpoints (see reslink-backend/src/uploads.js). This backend's
// routes only parse JSON bodies — no multipart/form-data — so a file
// upload is just base64 text inside the normal JSON body. Shared here
// since both CaptivePortal.jsx (customer receipts) and ResellerApp.jsx
// (a reseller's own license-renewal receipt) need it.
export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Couldn't read that file"));
    reader.readAsDataURL(file);
  });
}
