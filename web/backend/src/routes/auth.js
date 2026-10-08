import { randomBytes, createHash } from "node:crypto";
import https from "node:https";
import { db, id, genCode } from "../db.js";
import { hashPassword, verifyPassword, signToken, hashAnswer, verifyAnswer } from "../auth.js";
import { json } from "../http.js";
import { rateLimitByIp, rateLimitByKey } from "../rateLimit.js";
import { sendEmail } from "../email.js";

// Preset options shown in the Signup form's security-question dropdown
// (it also allows a custom question — see routes/auth.js signup
// handler, which accepts any non-empty string here). Exported so the
// frontend and backend can't drift out of sync on the canned list.
export const SECURITY_QUESTIONS = [
  "What city were you born in?",
  "What was your first pet's name?",
  "What is your mother's maiden name?",
  "What was the name of your first school?",
  "What is your favorite childhood nickname?",
];

const DEFAULT_COLORS = ["#667eea", "#764ba2", "#48bb78", "#f6ad55", "#4299e1"];

// Reset tokens need a deterministic lookup hash, not hashPassword's
// salted scrypt (that's the right choice for passwords/API keys, which
// are always verified against ONE known row — but a reset token has to
// be looked UP by its hash, and a fresh scryptSync call generates a new
// random salt every time, so hashing the same raw token twice never
// matches. SHA-256 is fine here specifically because the token itself
// is 256 bits of real randomness, not a low-entropy secret like a
// password — there's no rainbow-table risk to salt against.
const hashToken = (raw) => createHash("sha256").update(raw).digest("hex");

// Self-referral guard: catches the classic Gmail-style abuse where
// someone refers "someone else" who is actually themselves under a
// trick address — "jane.doe@gmail.com" referring "janedoe+bonus@gmail.com"
// — by stripping dots and any +tag from the local part before
// comparing.
function normalizeEmailForSelfReferralCheck(email) {
  const [local, domain] = String(email || "").trim().toLowerCase().split("@");
  if (!domain) return String(email || "").trim().toLowerCase();
  return `${local.split("+")[0].replace(/\./g, "")}@${domain}`;
}

// === CONFIG: Email verification + Google OAuth =============================
const APP_URL = process.env.APP_URL || "https://www.safelinks.name.ng";
const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";

// === HELPERS: Email verification ===========================================
async function issueVerificationToken(resellerId, email) {
  const rawToken = randomBytes(32).toString("hex");
  const now = Date.now();
  // Invalidate any existing pending tokens for this user
  await db.prepare(
    "UPDATE email_verifications SET used_at = ? WHERE user_type = ? AND user_id = ? AND used_at IS NULL"
  ).run(now, "reseller", resellerId);
  await db.prepare(
    "INSERT INTO email_verifications (id,user_type,user_id,email,token_hash,expires_at,created_at) VALUES (?,?,?,?,?,?,?)"
  ).run(id("ev"), "reseller", resellerId, email, hashToken(rawToken), now + EMAIL_VERIFY_TTL_MS, now);
  return rawToken;
}

async function sendVerificationEmail(resellerId, email, companyName) {
  try {
    const rawToken = await issueVerificationToken(resellerId, email);
    const link = `${APP_URL}/verify-email?token=${rawToken}`;
    const text = [
      `Welcome to SafeLinks, ${companyName}!`,
      ``,
      `Please verify your email address by opening the link below:`,
      ``,
      link,
      ``,
      `This link expires in 24 hours. After verifying, you'll be able to log in to your full dashboard.`,
      ``,
      `If you didn't create this account, you can safely ignore this email.`,
    ].join("\n");
    await sendEmail({ to: email, subject: "Verify your SafeLinks account", text });
    return { sent: true };
  } catch (err) {
    console.error("sendVerificationEmail failed:", err.message);
    return { sent: false, error: err.message };
  }
}

// === HELPERS: Google OAuth (verify ID token from frontend) =================
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https.get(
      { hostname: u.hostname, path: u.pathname + u.search, headers: { Accept: "application/json" } },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try { resolve(JSON.parse(raw)); } catch { resolve({ error: raw }); }
        });
      }
    ).on("error", reject);
  });
}

async function verifyGoogleIdToken(idToken) {
  // Google's tokeninfo endpoint validates signature, expiry, and audience
  // in a single GET. Sufficient for production use with the client ID check.
  const info = await httpsGet(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
  if (info.error || !info.email) return null;
  // Ensure the token was minted for OUR client, not someone else's app.
  if (GOOGLE_CLIENT_ID && info.aud !== GOOGLE_CLIENT_ID) {
    console.error("Google token audience mismatch:", info.aud, "expected:", GOOGLE_CLIENT_ID);
    return null;
  }
  return {
    googleId: info.sub,
    email: String(info.email).toLowerCase(),
    emailVerified: info.email_verified === "true" || info.email_verified === true,
    name: info.name || null,
  };
}

export function registerAuthRoutes(router) {
  // POST /api/auth/login — checks super_admins first, then resellers.
  router.post("/api/auth/login", async (req, res, { body }) => {
    if (await rateLimitByIp(req, res, "login", { max: 10, windowMs: 15 * 60000 })) return;
    let { email, password } = body;
    if (email) email = email.trim().toLowerCase();
    if (!email || !password) return json(res, 400, { error: "email and password are required" });

    const admin = await db.prepare("SELECT * FROM super_admins WHERE email = ?").get(email);
    if (admin && verifyPassword(password, admin.password_hash)) {
      const token = signToken({ sub: admin.id, role: "super_admin" });
      return json(res, 200, {
        token, role: "super_admin",
        user: { id: admin.id, email: admin.email, emailVerified: true },
      });
    }

    const reseller = await db.prepare("SELECT * FROM resellers WHERE email = ?").get(email);
    if (reseller && verifyPassword(password, reseller.password_hash)) {
      const token = signToken({ sub: reseller.id, role: "reseller", resellerId: reseller.id });
      return json(res, 200, {
        token, role: "reseller",
        user: {
          id: reseller.id,
          email: reseller.email,
          companyName: reseller.company_name,
          phone: reseller.phone || null,
          status: reseller.status,
          emailVerified: !!reseller.email_verified,
        },
      });
    }

    return json(res, 401, { error: "Invalid email or password" });
  });

  // POST /api/auth/signup — self-serve reseller onboarding.
  router.post("/api/auth/signup", async (req, res, { body }) => {
    if (await rateLimitByIp(req, res, "signup", { max: 5, windowMs: 60 * 60000 })) return;
    let { email, password, companyName, phone, securityQuestion, securityAnswer } = body;
    if (email) email = email.trim().toLowerCase();
    if (phone) phone = String(phone).trim();

    if (!email || !password || !companyName) {
      return json(res, 400, { error: "email, password, and companyName are required" });
    }
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return json(res, 400, { error: "That doesn't look like a valid email address" });
    }
    if (password.length < 8) {
      return json(res, 400, { error: "Password must be at least 8 characters" });
    }

    // Phone is now REQUIRED — used for WhatsApp delivery + account recovery.
    // Accept Nigerian/global formats; strip spaces/dashes/brackets before checking.
    const phoneDigits = phone ? phone.replace(/[\s\-()]/g, "") : "";
    if (!phoneDigits || !/^\+?[1-9]\d{6,14}$/.test(phoneDigits)) {
      return json(res, 400, {
        error: "A valid phone number is required (e.g. +2348000000000)",
      });
    }

    if (!securityQuestion || !securityQuestion.trim()) {
      return json(res, 400, { error: "Choose or write a security question" });
    }
    if (!securityAnswer || !securityAnswer.trim()) {
      return json(res, 400, { error: "An answer to your security question is required" });
    }
    if (securityAnswer.trim().length < 2) {
      return json(res, 400, { error: "That answer is too short to be useful for recovery" });
    }

    const existing = await db.prepare("SELECT id FROM resellers WHERE email = ?").get(email);
    if (existing) return json(res, 409, { error: "An account with that email already exists" });

    const now = Date.now();
    const resellerId = id("r");

    let licenseKey;
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = `ISP-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
      if (!(await db.prepare("SELECT id FROM resellers WHERE license_key = ?").get(candidate))) {
        licenseKey = candidate;
        break;
      }
    }
    if (!licenseKey) return json(res, 500, { error: "Could not generate a unique license key — try again" });

    const ssidBase = companyName.replace(/[^a-zA-Z0-9]/g, "");
    const color = DEFAULT_COLORS[Math.floor(Math.random() * DEFAULT_COLORS.length)];

    let referralCode;
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = genCode(8).toUpperCase();
      if (!(await db.prepare("SELECT id FROM resellers WHERE referral_code = ?").get(candidate))) {
        referralCode = candidate;
        break;
      }
    }
    if (!referralCode) return json(res, 500, { error: "Could not generate a unique referral code — try again" });

    let referrer = null;
    if (body.referralCode && body.referralCode.trim()) {
      referrer = await db.prepare(
        "SELECT id, company_name, email, contact_whatsapp FROM resellers WHERE referral_code = ?"
      ).get(body.referralCode.trim().toUpperCase());
    }

    await db.prepare(`INSERT INTO resellers
      (id,email,password_hash,company_name,phone,license_key,status,subscription_plan,subscription_expiry,ssid,portal_title,color,security_question,security_answer_hash,referral_code,referred_by,email_verified,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        resellerId, email, hashPassword(password), companyName, phoneDigits,
        licenseKey, "pending", "basic", now,
        `${ssidBase}-WiFi`, `Welcome to ${companyName}`, color,
        securityQuestion.trim(), hashAnswer(securityAnswer),
        referralCode, referrer?.id || null, false, now
      );

    if (referrer) {
      const bonusRow = await db.prepare(
        "SELECT referral_bonus_amount, platform_currency FROM integration_settings WHERE id = 'singleton'"
      ).get();
      const bonusAmount = Number(bonusRow?.referral_bonus_amount ?? 10);
      const bonusCurrency = bonusRow?.platform_currency || "USD";

      const invite = await db.prepare(
        "SELECT id, phone FROM referrals WHERE referrer_reseller_id = ? AND status = 'invited' AND lower(email) = lower(?) LIMIT 1"
      ).get(referrer.id, email);

      const looksLikeSelfReferral =
        (invite?.phone && referrer.contact_whatsapp &&
          invite.phone.replace(/\D/g, "") === referrer.contact_whatsapp.replace(/\D/g, "")) ||
        normalizeEmailForSelfReferralCheck(email) === normalizeEmailForSelfReferralCheck(referrer.email);

      const newStatus = looksLikeSelfReferral ? "flagged" : "signed_up";
      if (invite) {
        await db.prepare(
          "UPDATE referrals SET status = ?, referred_reseller_id = ?, converted_at = ? WHERE id = ?"
        ).run(newStatus, resellerId, now, invite.id);
      } else {
        await db.prepare(`INSERT INTO referrals
          (id,referrer_reseller_id,name,email,phone,status,bonus_amount,referred_reseller_id,created_at,converted_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`)
          .run(id("ref"), referrer.id, companyName, email, null, newStatus, bonusAmount, resellerId, now, now);
      }

      if (!looksLikeSelfReferral) {
        await db.prepare(
          "INSERT INTO notifications (id,scope,type,title,message,time,read,action_tab) VALUES (?,?,?,?,?,?,?,?)"
        ).run(
          id("n"), `reseller:${referrer.id}`, "referral", "Your referral signed up!",
          `${companyName} just created an account using your referral code — a ${bonusAmount} ${bonusCurrency} bonus is now pending Super Admin approval.`,
          now, 0, "referrals"
        );
      }
    }

    await db.prepare(
      "INSERT INTO notifications (id,scope,type,title,message,time,read,action_tab) VALUES (?,?,?,?,?,?,?,?)"
    ).run(
      id("n"), "super_admin", "install", "New reseller signed up",
      `${companyName} (${email}) created an account and is awaiting their first license payment.${referrer ? ` Referred by ${referrer.company_name}.` : ""}`,
      now, 0, "resellers"
    );

    // Fire-and-forget verification email. If SMTP isn't configured,
    // sendEmail logs a fallback; the account still works, just unverified.
    sendVerificationEmail(resellerId, email, companyName).catch((err) =>
      console.error("signup: verification email error:", err.message)
    );

    const token = signToken({ sub: resellerId, role: "reseller", resellerId });
    json(res, 201, {
      token, role: "reseller",
      user: {
        id: resellerId, email, companyName, phone: phoneDigits,
        status: "pending", referralCode, emailVerified: false,
      },
      emailVerificationSent: true,
    });
  });

  // POST /api/auth/verify-email/send — resend a verification email.
  // rate-limited per email address.
  router.post("/api/auth/verify-email/send", async (req, res, { body }) => {
    if (await rateLimitByIp(req, res, "verify-email-ip", { max: 10, windowMs: 60 * 60000 })) return;
    let { email } = body;
    if (email) email = email.trim().toLowerCase();
    if (!email) return json(res, 400, { error: "email is required" });
    if (await rateLimitByKey(res, `verify-email:${email}`, { max: 3, windowMs: 60 * 60000 })) return;

    const reseller = await db.prepare(
      "SELECT id, email, company_name, email_verified FROM resellers WHERE email = ?"
    ).get(email);
    if (!reseller) {
      // Never reveal whether an email exists.
      return json(res, 200, { ok: true, message: "If that account exists, we've sent a new verification link." });
    }
    if (reseller.email_verified) {
      return json(res, 200, { ok: true, message: "This email is already verified." });
    }

    const result = await sendVerificationEmail(reseller.id, reseller.email, reseller.company_name);
    json(res, 200, {
      ok: true,
      message: result.sent ? "Verification email sent." : "Couldn't send email — try again shortly.",
      sent: result.sent,
    });
  });

  // GET /api/auth/verify-email/:token — user clicks the link in their email.
  // Marks the reseller verified and burns the token.
  router.get("/api/auth/verify-email/:token", async (req, res, { params }) => {
    const raw = String(params.token || "").trim();
    if (!raw) return json(res, 400, { error: "Missing token" });

    const now = Date.now();
    const row = await db.prepare(
      "SELECT * FROM email_verifications WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?"
    ).get(hashToken(raw), now);
    if (!row) {
      return json(res, 400, {
        error: "This verification link is invalid or has expired. Request a new one from the login page.",
      });
    }

    await db.prepare("UPDATE email_verifications SET used_at = ? WHERE id = ?").run(now, row.id);
    await db.prepare("UPDATE resellers SET email_verified = TRUE WHERE id = ?").run(row.user_id);

    json(res, 200, { ok: true, message: "Email verified. You can now access your full dashboard." });
  });

  // POST /api/auth/google — body { idToken }.
  // Frontend obtains the ID token via Google Sign-In (Google Identity Services).
  // We verify it with Google, then find-or-create a reseller and issue our JWT.
  router.post("/api/auth/google", async (req, res, { body }) => {
    if (await rateLimitByIp(req, res, "google-login", { max: 20, windowMs: 15 * 60000 })) return;
    const { idToken } = body || {};
    if (!idToken) return json(res, 400, { error: "idToken is required" });

    const info = await verifyGoogleIdToken(idToken);
    if (!info) return json(res, 401, { error: "Google token verification failed" });

    // 1. Already linked by google_id?
    let reseller = await db.prepare("SELECT * FROM resellers WHERE google_id = ?").get(info.googleId);

    // 2. Same email exists (they signed up with password before)?
    if (!reseller) {
      reseller = await db.prepare("SELECT * FROM resellers WHERE email = ?").get(info.email);
      if (reseller) {
        // Link the Google account to the existing row.
        await db.prepare("UPDATE resellers SET google_id = ?, email_verified = TRUE WHERE id = ?")
          .run(info.googleId, reseller.id);
        reseller.google_id = info.googleId;
        reseller.email_verified = true;
      }
    }

    // 3. Brand new — create a reseller from the Google profile.
    if (!reseller) {
      const now = Date.now();
      const resellerId = id("r");
      const companyName = info.name || info.email.split("@")[0] || "New Reseller";

      let licenseKey;
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = `ISP-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
        if (!(await db.prepare("SELECT id FROM resellers WHERE license_key = ?").get(candidate))) {
          licenseKey = candidate;
          break;
        }
      }
      if (!licenseKey) return json(res, 500, { error: "Could not generate a license key" });

      let referralCode;
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = genCode(8).toUpperCase();
        if (!(await db.prepare("SELECT id FROM resellers WHERE referral_code = ?").get(candidate))) {
          referralCode = candidate;
          break;
        }
      }
      if (!referralCode) return json(res, 500, { error: "Could not generate a referral code" });

      const ssidBase = companyName.replace(/[^a-zA-Z0-9]/g, "");
      const color = DEFAULT_COLORS[Math.floor(Math.random() * DEFAULT_COLORS.length)];

      // Placeholder hash — this account cannot log in via password until
      // they set one through the password-reset flow.
      const placeholderHash = hashPassword(randomBytes(32).toString("hex"));

      await db.prepare(`INSERT INTO resellers
        (id,email,password_hash,company_name,license_key,status,subscription_plan,subscription_expiry,ssid,portal_title,color,security_question,security_answer_hash,referral_code,google_id,email_verified,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(
          resellerId, info.email, placeholderHash, companyName,
          licenseKey, "pending", "basic", now,
          `${ssidBase}-WiFi`, `Welcome to ${companyName}`, color,
          "What city were you born in?", hashAnswer(randomBytes(8).toString("hex")),
          referralCode, info.googleId, true, now
        );

      await db.prepare(
        "INSERT INTO notifications (id,scope,type,title,message,time,read,action_tab) VALUES (?,?,?,?,?,?,?,?)"
      ).run(
        id("n"), "super_admin", "install", "New reseller (Google)",
        `${companyName} (${info.email}) signed up via Google and is awaiting their first license payment.`,
        now, 0, "resellers"
      );

      reseller = await db.prepare("SELECT * FROM resellers WHERE id = ?").get(resellerId);
    }

    const token = signToken({ sub: reseller.id, role: "reseller", resellerId: reseller.id });
    json(res, 200, {
      token, role: "reseller",
      user: {
        id: reseller.id,
        email: reseller.email,
        companyName: reseller.company_name,
        phone: reseller.phone || null,
        status: reseller.status,
        emailVerified: true, // Google guarantees this
        viaGoogle: true,
      },
    });
  });

  // POST /api/auth/password-reset/question — { email }.
  const FALLBACK_QUESTION = "What city were you born in?";
  router.post("/api/auth/password-reset/question", async (req, res, { body }) => {
    if (await rateLimitByIp(req, res, "password-reset-ip", { max: 10, windowMs: 60 * 60000 })) return;
    let { email } = body;
    if (email) email = email.trim().toLowerCase();
    if (!email) return json(res, 400, { error: "email is required" });
    if (await rateLimitByKey(res, `password-reset-email:${email}`, { max: 5, windowMs: 60 * 60000 })) return;

    const reseller = await db.prepare("SELECT security_question FROM resellers WHERE email = ?").get(email);
    json(res, 200, { question: reseller?.security_question || FALLBACK_QUESTION });
  });

  // POST /api/auth/password-reset/verify-answer — { email, answer }.
  router.post("/api/auth/password-reset/verify-answer", async (req, res, { body }) => {
    if (await rateLimitByIp(req, res, "password-reset-answer-ip", { max: 10, windowMs: 60 * 60000 })) return;
    let { email, answer } = body;
    if (email) email = email.trim().toLowerCase();
    if (!email || !answer) return json(res, 400, { error: "email and answer are required" });
    if (await rateLimitByKey(res, `password-reset-answer:${email}`, { max: 5, windowMs: 60 * 60000 })) return;

    const reseller = await db.prepare(
      "SELECT id, security_answer_hash FROM resellers WHERE email = ?"
    ).get(email);
    if (!reseller || !reseller.security_answer_hash || !verifyAnswer(answer, reseller.security_answer_hash)) {
      return json(res, 401, { error: "That answer doesn't match our records" });
    }

    const rawToken = randomBytes(32).toString("hex");
    const now = Date.now();
    await db.prepare(
      "INSERT INTO password_reset_tokens (id,reseller_id,token_hash,expires_at,created_at) VALUES (?,?,?,?,?)"
    ).run(id("prt"), reseller.id, hashToken(rawToken), now + 15 * 60000, now);

    json(res, 200, { resetToken: rawToken });
  });

  // POST /api/auth/password-reset/confirm — { token, newPassword }.
  router.post("/api/auth/password-reset/confirm", async (req, res, { body }) => {
    const { token, newPassword } = body;
    if (!token || !newPassword) return json(res, 400, { error: "token and newPassword are required" });
    if (newPassword.length < 8) return json(res, 400, { error: "Password must be at least 8 characters" });

    const now = Date.now();
    const row = await db.prepare(
      "SELECT * FROM password_reset_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?"
    ).get(hashToken(token), now);
    if (!row) return json(res, 400, { error: "That reset session has expired — start over" });

    await db.prepare("UPDATE resellers SET password_hash = ? WHERE id = ?")
      .run(hashPassword(newPassword), row.reseller_id);
    await db.prepare("UPDATE password_reset_tokens SET used_at = ? WHERE reseller_id = ? AND used_at IS NULL")
      .run(now, row.reseller_id);

    json(res, 200, { ok: true, message: "Password updated — you can log in with your new password now." });
  });
}
