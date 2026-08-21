import { randomBytes, createHash } from "node:crypto";
import { db, id, genCode } from "../db.js";
import { hashPassword, verifyPassword, signToken, hashAnswer, verifyAnswer } from "../auth.js";
import { json } from "../http.js";
import { rateLimitByIp, rateLimitByKey } from "../rateLimit.js";

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
// comparing. This is a heuristic, not a guarantee: it does nothing
// for someone using a genuinely different email/provider for a second
// account, which this system has no way to detect without real
// identity verification. It's one real check, not a complete
// anti-fraud system — flagged referrals still get recorded (so Super
// Admin can see the pattern) but never auto-progress to a payable
// state.
function normalizeEmailForSelfReferralCheck(email) {
  const [local, domain] = String(email || "").trim().toLowerCase().split("@");
  if (!domain) return String(email || "").trim().toLowerCase();
  return `${local.split("+")[0].replace(/\./g, "")}@${domain}`;
}

export function registerAuthRoutes(router) {
  // POST /api/auth/login — checks super_admins first, then resellers.
  // Real deployments would separate these by intent (subdomain, app),
  // but one endpoint is fine for a demo backend serving both roles.
  router.post("/api/auth/login", async (req, res, { body }) => {
    // 10 attempts / 15 min / IP — generous enough for someone who
    // mistypes their password a few times, tight enough to make
    // credential stuffing impractical.
    if (await rateLimitByIp(req, res, "login", { max: 10, windowMs: 15 * 60000 })) return;
    const { email, password } = body;
    if (!email || !password) return json(res, 400, { error: "email and password are required" });

    const admin = await db.prepare("SELECT * FROM super_admins WHERE email = ?").get(email);
    if (admin && verifyPassword(password, admin.password_hash)) {
      const token = signToken({ sub: admin.id, role: "super_admin" });
      return json(res, 200, { token, role: "super_admin", user: { id: admin.id, email: admin.email } });
    }

    const reseller = await db.prepare("SELECT * FROM resellers WHERE email = ?").get(email);
    if (reseller && verifyPassword(password, reseller.password_hash)) {
      const token = signToken({ sub: reseller.id, role: "reseller", resellerId: reseller.id });
      return json(res, 200, {
        token, role: "reseller",
        user: { id: reseller.id, email: reseller.email, companyName: reseller.company_name, status: reseller.status },
      });
    }

    return json(res, 401, { error: "Invalid email or password" });
  });

  // POST /api/auth/signup — self-serve reseller onboarding. Creates the
  // account AND logs them straight in (same response shape as login),
  // so signing up and landing in a working dashboard is one step, not
  // "submit a request and wait." The account starts 'pending' with an
  // already-elapsed subscription_expiry — same as any other
  // not-yet-paid reseller — so the dashboard prompts them to submit a
  // license payment (existing flow, see /api/reseller/license/renew)
  // rather than treating signup itself as activation.
  router.post("/api/auth/signup", async (req, res, { body }) => {
    // 5 accounts / hour / IP — self-serve signup is exactly the kind of
    // endpoint spam/bot tooling loves; a real person signing up once
    // never notices this limit.
    if (await rateLimitByIp(req, res, "signup", { max: 5, windowMs: 60 * 60000 })) return;
    const { email, password, companyName, securityQuestion, securityAnswer } = body;
    if (!email || !password || !companyName) {
      return json(res, 400, { error: "email, password, and companyName are required" });
    }
    if (!/^\S+@\S+\.\S+$/.test(email)) return json(res, 400, { error: "That doesn't look like a valid email address" });
    if (password.length < 8) return json(res, 400, { error: "Password must be at least 8 characters" });
    // Required, not optional — a security question set up front is the
    // ONLY account-recovery path in this system (see
    // /password-reset/question below; there's no email link anymore).
    // Skipping it at signup would mean permanently locking themselves
    // out the moment they forget their password.
    if (!securityQuestion || !securityQuestion.trim()) return json(res, 400, { error: "Choose or write a security question" });
    if (!securityAnswer || !securityAnswer.trim()) return json(res, 400, { error: "An answer to your security question is required" });
    if (securityAnswer.trim().length < 2) return json(res, 400, { error: "That answer is too short to be useful for recovery" });

    const existing = await db.prepare("SELECT id FROM resellers WHERE email = ?").get(email);
    if (existing) return json(res, 409, { error: "An account with that email already exists" });

    const now = Date.now();
    const resellerId = id("r");

    // license_key isn't security-sensitive (it's shown on-screen, not a
    // credential), so a short retry-on-collision loop is enough rather
    // than anything fancier.
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

    // This reseller's OWN referral code, generated the same way for
    // everyone regardless of whether they arrived via someone else's
    // referral — every reseller can refer others from day one. Same
    // short retry-on-collision loop as the license key above.
    let referralCode;
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = genCode(8).toUpperCase();
      if (!(await db.prepare("SELECT id FROM resellers WHERE referral_code = ?").get(candidate))) {
        referralCode = candidate;
        break;
      }
    }
    if (!referralCode) return json(res, 500, { error: "Could not generate a unique referral code — try again" });

    // Optional inbound referral — { referralCode } in the signup body
    // is someone ELSE's code, entered by this new reseller (from the
    // "Referral code" field on Signup.jsx). A bad/unknown code never
    // blocks signup — it's just silently not credited, same as a typo
    // in a coupon field anywhere else.
    let referrer = null;
    if (body.referralCode && body.referralCode.trim()) {
      referrer = await db.prepare("SELECT id, company_name, email, contact_whatsapp FROM resellers WHERE referral_code = ?").get(body.referralCode.trim().toUpperCase());
    }

    await db.prepare(`INSERT INTO resellers
      (id,email,password_hash,company_name,license_key,status,subscription_plan,subscription_expiry,ssid,portal_title,color,security_question,security_answer_hash,referral_code,referred_by,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(resellerId, email, hashPassword(password), companyName, licenseKey, "pending", "basic", now, `${ssidBase}-WiFi`, `Welcome to ${companyName}`, color, securityQuestion.trim(), hashAnswer(securityAnswer), referralCode, referrer?.id || null, now);

    if (referrer) {
      const bonusRow = await db.prepare("SELECT referral_bonus_amount, platform_currency FROM integration_settings WHERE id = 'singleton'").get();
      const bonusAmount = Number(bonusRow?.referral_bonus_amount ?? 10);
      const bonusCurrency = bonusRow?.platform_currency || "USD";
      // Prefer crediting an existing 'invited' referral this new
      // signup matches by email (the referrer specifically invited
      // THIS person) over creating a fresh row — that keeps one
      // invite from silently duplicating into two rows if the
      // referred person signs up with the exact email they were
      // invited at, which is the common case.
      const invite = await db.prepare(
        "SELECT id, phone FROM referrals WHERE referrer_reseller_id = ? AND status = 'invited' AND lower(email) = lower(?) LIMIT 1"
      ).get(referrer.id, email);

      // Self-referral heuristic: either the invite's own phone matches
      // the referrer's own WhatsApp contact number (they invited
      // "someone" using their own number), or the signup email
      // normalizes to the same address as the referrer's own account
      // email (the Gmail dots/+tag trick — see
      // normalizeEmailForSelfReferralCheck above). Either signal alone
      // is enough to flag; this never blocks the signup itself, only
      // whether the referral counts toward a bonus.
      const looksLikeSelfReferral =
        (invite?.phone && referrer.contact_whatsapp && invite.phone.replace(/\D/g, "") === referrer.contact_whatsapp.replace(/\D/g, "")) ||
        normalizeEmailForSelfReferralCheck(email) === normalizeEmailForSelfReferralCheck(referrer.email);

      const newStatus = looksLikeSelfReferral ? "flagged" : "signed_up";
      if (invite) {
        await db.prepare("UPDATE referrals SET status = ?, referred_reseller_id = ?, converted_at = ? WHERE id = ?")
          .run(newStatus, resellerId, now, invite.id);
      } else {
        await db.prepare(`INSERT INTO referrals
          (id,referrer_reseller_id,name,email,phone,status,bonus_amount,referred_reseller_id,created_at,converted_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`)
          .run(id("ref"), referrer.id, companyName, email, null, newStatus, bonusAmount, resellerId, now, now);
      }

      // No "you earned a bonus" notification for a flagged referral —
      // no reason to advertise a payout that isn't going to happen.
      if (!looksLikeSelfReferral) {
        await db.prepare("INSERT INTO notifications (id,scope,type,title,message,time,read,action_tab) VALUES (?,?,?,?,?,?,?,?)")
          .run(id("n"), `reseller:${referrer.id}`, "referral", "Your referral signed up!",
            `${companyName} just created an account using your referral code — a ${bonusAmount} ${bonusCurrency} bonus is now pending Super Admin approval.`, now, 0, "referrals");
      }
    }

    await db.prepare("INSERT INTO notifications (id,scope,type,title,message,time,read,action_tab) VALUES (?,?,?,?,?,?,?,?)")
      .run(id("n"), "super_admin", "install", "New reseller signed up",
        `${companyName} (${email}) created an account and is awaiting their first license payment.${referrer ? ` Referred by ${referrer.company_name}.` : ""}`, now, 0, "resellers");

    const token = signToken({ sub: resellerId, role: "reseller", resellerId });
    json(res, 201, {
      token, role: "reseller",
      user: { id: resellerId, email, companyName, status: "pending", referralCode },
    });
  });

  // POST /api/auth/password-reset/question — { email }. First step of
  // account recovery: look up the security question the reseller chose
  // at signup. To avoid leaking which emails are registered, an
  // unrecognized email still gets a 200 with a plausible-looking
  // (but unanswerable) generic question rather than a 404/error —
  // the real leak-prevention then happens at the answer-verification
  // step below, which fails identically either way.
  const FALLBACK_QUESTION = "What city were you born in?";
  router.post("/api/auth/password-reset/question", async (req, res, { body }) => {
    if (await rateLimitByIp(req, res, "password-reset-ip", { max: 10, windowMs: 60 * 60000 })) return;
    const { email } = body;
    if (!email) return json(res, 400, { error: "email is required" });
    if (await rateLimitByKey(res, `password-reset-email:${email.toLowerCase()}`, { max: 5, windowMs: 60 * 60000 })) return;

    const reseller = await db.prepare("SELECT security_question FROM resellers WHERE email = ?").get(email);
    json(res, 200, { question: reseller?.security_question || FALLBACK_QUESTION });
  });

  // POST /api/auth/password-reset/verify-answer — { email, answer }.
  // On a correct answer, issues a short-lived (15 min) reset token
  // directly in the response — no email involved anywhere in this
  // flow, since a correct secret-question answer IS the identity
  // proof. The token still goes through the same
  // password_reset_tokens table/hash-at-rest pattern as before, and
  // still gets redeemed via the same /confirm endpoint.
  router.post("/api/auth/password-reset/verify-answer", async (req, res, { body }) => {
    if (await rateLimitByIp(req, res, "password-reset-answer-ip", { max: 10, windowMs: 60 * 60000 })) return;
    const { email, answer } = body;
    if (!email || !answer) return json(res, 400, { error: "email and answer are required" });
    // Answers are guessable in a way passwords aren't (birthplaces,
    // pet names) — a tighter, per-account limit than login's matters
    // here specifically.
    if (await rateLimitByKey(res, `password-reset-answer:${email.toLowerCase()}`, { max: 5, windowMs: 60 * 60000 })) return;

    const reseller = await db.prepare("SELECT id, security_answer_hash FROM resellers WHERE email = ?").get(email);
    if (!reseller || !reseller.security_answer_hash || !verifyAnswer(answer, reseller.security_answer_hash)) {
      return json(res, 401, { error: "That answer doesn't match our records" });
    }

    const rawToken = randomBytes(32).toString("hex");
    const now = Date.now();
    await db.prepare("INSERT INTO password_reset_tokens (id,reseller_id,token_hash,expires_at,created_at) VALUES (?,?,?,?,?)")
      .run(id("prt"), reseller.id, hashToken(rawToken), now + 15 * 60000, now);

    json(res, 200, { resetToken: rawToken });
  });

  // POST /api/auth/password-reset/confirm — { token, newPassword }.
  // Unchanged in shape from the old email-link flow — only where the
  // token comes from changed (verify-answer above, instead of an
  // emailed link) — so this stays the single place a password
  // actually gets updated.
  router.post("/api/auth/password-reset/confirm", async (req, res, { body }) => {
    const { token, newPassword } = body;
    if (!token || !newPassword) return json(res, 400, { error: "token and newPassword are required" });
    if (newPassword.length < 8) return json(res, 400, { error: "Password must be at least 8 characters" });

    const now = Date.now();
    const row = await db.prepare("SELECT * FROM password_reset_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?")
      .get(hashToken(token), now);
    if (!row) return json(res, 400, { error: "That reset session has expired — start over and answer your security question again" });

    await db.prepare("UPDATE resellers SET password_hash = ? WHERE id = ?").run(hashPassword(newPassword), row.reseller_id);
    // Invalidate this token AND any other outstanding ones for the same
    // account — a successful reset should burn every in-flight token,
    // not just the one used.
    await db.prepare("UPDATE password_reset_tokens SET used_at = ? WHERE reseller_id = ? AND used_at IS NULL").run(now, row.reseller_id);

    json(res, 200, { ok: true, message: "Password updated — you can log in with your new password now." });
  });
}
