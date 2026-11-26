// Public pitch page for recruiting resellers: /go/<tracking-link>.
// Records each open (device ID kept in this browser, no personal data),
// shows local-currency prices, and sends people to signup or the demo form.
// Optional Meta Pixel / Google Analytics for ad retargeting (super admin
// sets the IDs in Marketing > Settings).
import React, { useEffect, useMemo, useState } from "react";

const BASE = import.meta.env.VITE_API_URL || "";
const CUR = { NG: "NGN", KE: "KES", GH: "GHS", ZA: "ZAR", UG: "UGX", TZ: "TZS", RW: "RWF", ZM: "ZMW", EG: "EGP", MA: "MAD", GB: "GBP",
  CM: "XAF", GA: "XAF", CG: "XAF", TD: "XAF", CF: "XAF", GQ: "XAF", SN: "XOF", CI: "XOF", BJ: "XOF", TG: "XOF", ML: "XOF", BF: "XOF", NE: "XOF",
  FR: "EUR", DE: "EUR", ES: "EUR", IT: "EUR", PT: "EUR", NL: "EUR", BE: "EUR", IE: "EUR" };

const TX = {
  en: { tag: "Your own WiFi business, in a day", h1: "Sell internet under your own brand", sub: "Turn any MikroTik router into a paid WiFi hotspot. Customers pay by transfer, card or USSD and get online instantly; the money goes straight to your bank.",
    cta: "Start free 7-day trial", demo: "Request a demo", how: "How it works",
    steps: ["Create your account (2 minutes, no card)", "Paste one line into your router: hotspot, WiFi and payments are set up for you", "Customers connect, pay and browse. You get paid the same day"],
    feats: [["Instant payments", "Bank transfer, card and USSD. Customers are online seconds after paying."], ["Same-day payouts", "Your share goes straight to your bank account, automatically."], ["Any MikroTik router", "One line sets up hotspot, WiFi, speed limits and devices per plan."], ["Grow on autopilot", "Expiry reminders, auto-renew wallet, free trials, referrals and promo codes."], ["See your money", "Daily earnings on WhatsApp, revenue by plan, hour and router."], ["Your brand", "Your name, colours and prices on every customer screen."]],
    price: "Simple monthly license", per: "/month", clients: "clients", form: "Talk to us", name: "Your name", phone: "Phone / WhatsApp", email: "Email", company: "Business name (optional)", msg: "Where will you sell WiFi? (optional)", send: "Send", sent: "Thanks! We'll contact you shortly.", trust: "Built for cafés, hostels, estates, schools, churches and offices.", footer: "SAFE_Links by A I Brains Ventures" },
  fr: { tag: "Votre entreprise WiFi, en un jour", h1: "Vendez Internet sous votre propre marque", sub: "Transformez n'importe quel routeur MikroTik en hotspot WiFi payant. Les clients paient par virement, carte ou USSD et sont connectés immédiatement ; l'argent arrive directement sur votre compte.",
    cta: "Essai gratuit de 7 jours", demo: "Demander une démo", how: "Comment ça marche",
    steps: ["Créez votre compte (2 minutes, sans carte)", "Collez une ligne dans votre routeur : hotspot, WiFi et paiements configurés", "Les clients se connectent, paient et naviguent. Vous êtes payé le jour même"],
    feats: [["Paiements instantanés", "Virement, carte et USSD. Le client est en ligne quelques secondes après avoir payé."], ["Versements le jour même", "Votre part arrive automatiquement sur votre compte bancaire."], ["Tout routeur MikroTik", "Une ligne configure hotspot, WiFi, débit et appareils par forfait."], ["Croissance automatique", "Rappels d'expiration, renouvellement automatique, essais gratuits, parrainage."], ["Suivez vos revenus", "Gains du jour sur WhatsApp, revenus par forfait, heure et routeur."], ["Votre marque", "Votre nom, vos couleurs et vos prix sur chaque écran client."]],
    price: "Licence mensuelle simple", per: "/mois", clients: "clients", form: "Parlez-nous", name: "Votre nom", phone: "Téléphone / WhatsApp", email: "E-mail", company: "Entreprise (facultatif)", msg: "Où vendrez-vous le WiFi ? (facultatif)", send: "Envoyer", sent: "Merci ! Nous vous contacterons bientôt.", trust: "Pour cafés, auberges, résidences, écoles, églises et bureaux.", footer: "SAFE_Links par A I Brains Ventures" },
  pt: { tag: "O seu negócio de WiFi, num dia", h1: "Venda internet com a sua própria marca", sub: "Transforme qualquer router MikroTik num hotspot WiFi pago. Os clientes pagam por transferência, cartão ou USSD e ficam online na hora; o dinheiro vai direto para a sua conta.",
    cta: "Teste grátis de 7 dias", demo: "Pedir demonstração", how: "Como funciona",
    steps: ["Crie a sua conta (2 minutos, sem cartão)", "Cole uma linha no router: hotspot, WiFi e pagamentos configurados", "Os clientes ligam-se, pagam e navegam. Recebe no mesmo dia"],
    feats: [["Pagamentos instantâneos", "Transferência, cartão e USSD. Online segundos após pagar."], ["Pagamentos no mesmo dia", "A sua parte vai automaticamente para a sua conta bancária."], ["Qualquer router MikroTik", "Uma linha configura hotspot, WiFi, velocidade e dispositivos por plano."], ["Crescimento automático", "Lembretes de expiração, renovação automática, testes grátis, indicações."], ["Veja o seu dinheiro", "Ganhos diários no WhatsApp, receita por plano, hora e router."], ["A sua marca", "O seu nome, cores e preços em cada ecrã do cliente."]],
    price: "Licença mensal simples", per: "/mês", clients: "clientes", form: "Fale connosco", name: "O seu nome", phone: "Telefone / WhatsApp", email: "E-mail", company: "Empresa (opcional)", msg: "Onde vai vender WiFi? (opcional)", send: "Enviar", sent: "Obrigado! Entraremos em contacto em breve.", trust: "Para cafés, hostels, condomínios, escolas, igrejas e escritórios.", footer: "SAFE_Links por A I Brains Ventures" },
  sw: { tag: "Biashara yako ya WiFi, kwa siku moja", h1: "Uza intaneti kwa chapa yako mwenyewe", sub: "Geuza router yoyote ya MikroTik kuwa hotspot ya WiFi ya kulipia. Wateja hulipa kwa uhamisho, kadi au USSD na kuunganishwa papo hapo; pesa huingia moja kwa moja benki kwako.",
    cta: "Jaribu bure siku 7", demo: "Omba onyesho", how: "Inavyofanya kazi",
    steps: ["Fungua akaunti (dakika 2, bila kadi)", "Bandika mstari mmoja kwenye router: hotspot, WiFi na malipo vinawekwa", "Wateja wanaunganisha, wanalipa na kutumia. Unalipwa siku hiyo hiyo"],
    feats: [["Malipo ya papo hapo", "Uhamisho, kadi na USSD. Mteja yuko mtandaoni sekunde chache baada ya kulipa."], ["Malipo siku hiyo hiyo", "Sehemu yako huingia benki kwako moja kwa moja."], ["Router yoyote ya MikroTik", "Mstari mmoja huweka hotspot, WiFi, kasi na vifaa kwa kila kifurushi."], ["Kukua bila juhudi", "Vikumbusho, usasishaji wa moja kwa moja, majaribio ya bure, rufaa."], ["Ona mapato yako", "Mapato ya kila siku kwenye WhatsApp, kwa kifurushi, saa na router."], ["Chapa yako", "Jina lako, rangi na bei kwenye kila skrini ya mteja."]],
    price: "Leseni rahisi ya mwezi", per: "/mwezi", clients: "wateja", form: "Wasiliana nasi", name: "Jina lako", phone: "Simu / WhatsApp", email: "Barua pepe", company: "Biashara (hiari)", msg: "Utauza WiFi wapi? (hiari)", send: "Tuma", sent: "Asante! Tutawasiliana nawe hivi karibuni.", trust: "Kwa mikahawa, hosteli, makazi, shule, makanisa na ofisi.", footer: "SAFE_Links na A I Brains Ventures" },
};

function deviceId() {
  try {
    let d = localStorage.getItem("sl_did");
    if (!d) { d = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()).replace(/-/g, ""); localStorage.setItem("sl_did", d); }
    return d;
  } catch (_) { return ""; }
}

function loadPixels(metaPixelId, gaId) {
  if (metaPixelId && !window.fbq) {
    /* Meta Pixel */
    !function (f, b, e, v, n, t, s) { if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); }; if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = "2.0"; n.queue = []; t = b.createElement(e); t.async = !0; t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s); }(window, document, "script", "https://connect.facebook.net/en_US/fbevents.js");
    window.fbq("init", metaPixelId); window.fbq("track", "PageView");
  }
  if (gaId && !window.gtag) {
    const s = document.createElement("script"); s.async = true; s.src = `https://www.googletagmanager.com/gtag/js?id=${gaId}`; document.head.appendChild(s);
    window.dataLayer = window.dataLayer || []; window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag("js", new Date()); window.gtag("config", gaId);
  }
}
const track = (ev) => { try { window.fbq && window.fbq("track", ev); window.gtag && window.gtag("event", ev); } catch (_) {} };

export default function PitchPage({ slug = "" }) {
  const [lang, setLang] = useState(() => { const l = (navigator.language || "en").slice(0, 2); return TX[l] ? l : "en"; });
  const t = TX[lang];
  const [visit, setVisit] = useState(null);
  const [plans, setPlans] = useState([]);
  const [form, setForm] = useState({ name: "", phone: "", email: "", company: "", message: "" });
  const [state, setState] = useState({ busy: false, sent: false, err: null });
  const did = useMemo(deviceId, []);
  const sig = useMemo(() => ({ screen: `${screen.width}x${screen.height}`, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, lang: navigator.language }), []);

  useEffect(() => {
    if (window.__slVisitSent === slug) return; // React dev double-run
    window.__slVisitSent = slug;
    const q = new URLSearchParams(location.search);
    fetch(`${BASE}/api/mkt/visit`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug, deviceId: did, ...sig, referrer: document.referrer || null,
        utm: { source: q.get("utm_source"), medium: q.get("utm_medium"), campaign: q.get("utm_campaign") } }) })
      .then((r) => r.json()).then((v) => {
        setVisit(v);
        try { localStorage.setItem("sl_mkt", JSON.stringify({ slug, deviceKey: v.deviceKey, at: Date.now() })); } catch (_) {}
        loadPixels(v.metaPixelId, v.gaId);
        const cur = CUR[v.country] || "USD";
        return fetch(`${BASE}/api/plans/public?currency=${cur}`).then((r) => r.json()).then((p) => setPlans(p.plans || []));
      }).catch(() => {});
  }, [slug]);

  async function sendLead(e) {
    e.preventDefault();
    setState({ busy: true, sent: false, err: null });
    try {
      const r = await fetch(`${BASE}/api/mkt/lead`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...form, slug, deviceId: did, ...sig }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not send");
      track("Lead"); setState({ busy: false, sent: true, err: null });
    } catch (err) { setState({ busy: false, sent: false, err: err.message }); }
  }
  const start = () => { track("InitiateCheckout"); location.href = "/?signup=1"; };
  const money = (p) => { try { return new Intl.NumberFormat(undefined, { style: "currency", currency: p.currency || "USD", maximumFractionDigits: 0 }).format(p.price); } catch (_) { return `${p.currency} ${p.price}`; } };

  const C = { ink: "#0f172a", sub: "#475569", brand: "#4f46e5", soft: "#eef2ff", line: "#e2e8f0" };
  const input = { width: "100%", padding: "12px 14px", border: `1px solid ${C.line}`, borderRadius: 10, fontSize: 15, boxSizing: "border-box", marginBottom: 10 };
  return (
    <div style={{ fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", color: C.ink, background: "#fff", minHeight: "100vh" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 18px", maxWidth: 1080, margin: "0 auto" }}>
        <b style={{ fontSize: 18 }}>📶 SAFE_Links</b>
        <select value={lang} onChange={(e) => setLang(e.target.value)} aria-label="Language" style={{ border: `1px solid ${C.line}`, borderRadius: 8, padding: "6px 8px" }}>
          <option value="en">English</option><option value="fr">Français</option><option value="pt">Português</option><option value="sw">Kiswahili</option>
        </select>
      </header>

      <section style={{ background: "linear-gradient(135deg,#4f46e5,#7c3aed)", color: "#fff", padding: "48px 18px 56px" }}>
        <div style={{ maxWidth: 820, margin: "0 auto", textAlign: "center" }}>
          <div style={{ display: "inline-block", background: "rgba(255,255,255,.18)", borderRadius: 999, padding: "6px 14px", fontSize: 13, marginBottom: 14 }}>{t.tag}</div>
          <h1 style={{ fontSize: "clamp(30px,6vw,48px)", lineHeight: 1.1, margin: "0 0 14px" }}>{t.h1}</h1>
          <p style={{ fontSize: 17, opacity: 0.92, lineHeight: 1.55, margin: "0 0 24px" }}>{t.sub}</p>
          <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
            <button onClick={start} style={{ background: "#fff", color: C.brand, border: 0, borderRadius: 12, padding: "14px 22px", fontSize: 16, fontWeight: 700, cursor: "pointer" }}>{t.cta} →</button>
            <a href="#demo" onClick={() => track("Contact")} style={{ color: "#fff", border: "1.5px solid rgba(255,255,255,.7)", borderRadius: 12, padding: "13px 20px", fontSize: 16, fontWeight: 600, textDecoration: "none" }}>{t.demo}</a>
          </div>
          <div style={{ fontSize: 13, opacity: 0.85, marginTop: 16 }}>{t.trust}</div>
        </div>
      </section>

      <section style={{ maxWidth: 1080, margin: "0 auto", padding: "40px 18px 10px" }}>
        <h2 style={{ fontSize: 24, margin: "0 0 16px" }}>{t.how}</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", gap: 12 }}>
          {t.steps.map((s, i) => (
            <div key={i} style={{ background: C.soft, borderRadius: 14, padding: 16, display: "flex", gap: 12 }}>
              <div style={{ minWidth: 30, height: 30, borderRadius: 999, background: C.brand, color: "#fff", display: "grid", placeItems: "center", fontWeight: 700 }}>{i + 1}</div>
              <div style={{ fontSize: 15, lineHeight: 1.45 }}>{s}</div>
            </div>
          ))}
        </div>
      </section>

      <section style={{ maxWidth: 1080, margin: "0 auto", padding: "26px 18px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))", gap: 12 }}>
          {t.feats.map(([h, d]) => (
            <div key={h} style={{ border: `1px solid ${C.line}`, borderRadius: 14, padding: 16 }}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>✓ {h}</div>
              <div style={{ color: C.sub, fontSize: 14.5, lineHeight: 1.5 }}>{d}</div>
            </div>
          ))}
        </div>
      </section>

      {plans.length > 0 && (
        <section style={{ maxWidth: 1080, margin: "0 auto", padding: "16px 18px 26px" }}>
          <h2 style={{ fontSize: 24, margin: "0 0 16px" }}>{t.price}</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 12 }}>
            {plans.map((p) => (
              <div key={p.id} style={{ border: `1.5px solid ${p.id === "professional" ? C.brand : C.line}`, borderRadius: 14, padding: 18 }}>
                <div style={{ fontWeight: 700 }}>{p.name}</div>
                <div style={{ fontSize: 28, fontWeight: 800, color: C.brand, margin: "6px 0" }}>{money(p)}<span style={{ fontSize: 13, color: C.sub, fontWeight: 500 }}>{t.per}</span></div>
                <div style={{ color: C.sub, fontSize: 14 }}>{p.max_clients || p.maxClients} {t.clients}</div>
                <button onClick={start} style={{ marginTop: 12, width: "100%", background: C.brand, color: "#fff", border: 0, borderRadius: 10, padding: "11px 0", fontWeight: 700, cursor: "pointer" }}>{t.cta}</button>
              </div>
            ))}
          </div>
        </section>
      )}

      <section id="demo" style={{ background: "#f8fafc", padding: "34px 18px 40px" }}>
        <div style={{ maxWidth: 520, margin: "0 auto" }}>
          <h2 style={{ fontSize: 24, margin: "0 0 14px" }}>{t.form}</h2>
          {state.sent ? <div style={{ background: "#ecfdf5", border: "1px solid #a7f3d0", borderRadius: 12, padding: 16, fontWeight: 600 }}>{t.sent}</div> : (
            <form onSubmit={sendLead}>
              <input style={input} placeholder={t.name} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
              <input style={input} placeholder={t.phone} inputMode="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              <input style={input} placeholder={t.email} type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              <input style={input} placeholder={t.company} value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} />
              <textarea style={{ ...input, minHeight: 80 }} placeholder={t.msg} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} />
              {state.err && <div style={{ color: "#dc2626", fontSize: 13, marginBottom: 8 }}>{state.err}</div>}
              <button disabled={state.busy} style={{ width: "100%", background: C.brand, color: "#fff", border: 0, borderRadius: 12, padding: "14px 0", fontSize: 16, fontWeight: 700, cursor: "pointer" }}>{state.busy ? "…" : t.send}</button>
            </form>
          )}
        </div>
      </section>
      <footer style={{ textAlign: "center", color: C.sub, fontSize: 13, padding: 18 }}>{t.footer}</footer>
    </div>
  );
}
