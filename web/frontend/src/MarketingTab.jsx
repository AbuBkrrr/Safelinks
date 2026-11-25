// Super admin "Marketing" tab: tracking links + QR codes, same-device vs
// shared detection, where opens come from, leads, bulk follow-up.
import React, { useEffect, useState, useCallback } from "react";
import { T, Panel, Btn, Field, inputStyle, StatCard, Badge, EmptyRow, Loading, timeAgo } from "./ui.jsx";
import { http, getToken } from "./api.js";
import { Megaphone, Eye, Smartphone, Repeat, UserPlus, CheckCircle2, Download, Copy, QrCode, Send, Globe } from "lucide-react";

const BASE = import.meta.env.VITE_API_URL || "";
const PUBLIC = (import.meta.env.VITE_PUBLIC_URL || (typeof window !== "undefined" ? window.location.origin : "")).replace(/\/$/, "");
const linkUrl = (slug) => `${PUBLIC}/go/${slug}`;
const flag = (cc) => (cc && /^[A-Z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc].map((c) => 127397 + c.charCodeAt(0))) : "🌐");
const COUNTRY = (() => { try { return new Intl.DisplayNames(["en"], { type: "region" }); } catch (_) { return null; } })();
const cname = (cc) => { try { return (cc && COUNTRY?.of(cc)) || cc || "Unknown"; } catch (_) { return cc; } };

function useLoad(path) {
  const [s, set] = useState({ loading: true, data: null, error: null });
  const reload = useCallback(() => { http.get(path).then((d) => set({ loading: false, data: d, error: null })).catch((e) => set({ loading: false, data: null, error: e.message })); }, [path]);
  useEffect(reload, [reload]);
  return [s, reload];
}

function Bars({ rows, fmt = (k) => k, max = 8 }) {
  if (!rows?.length) return <EmptyRow text="No data yet" />;
  const top = Math.max(1, ...rows.map((r) => r.n));
  return rows.slice(0, max).map((r) => (
    <div key={r.key} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, margin: "5px 0" }}>
      <div style={{ width: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{fmt(r.key)}</div>
      <div style={{ flex: 1, background: T.bg, borderRadius: 6, height: 10 }}><div style={{ width: `${(r.n / top) * 100}%`, background: T.primary, height: 10, borderRadius: 6 }} /></div>
      <div style={{ width: 34, textAlign: "right", fontWeight: 600 }}>{r.n}</div>
    </div>
  ));
}

const SHARE_TEXT = "Start your own WiFi business. Turn a MikroTik router into a paid hotspot; customers pay by transfer or card and get online instantly. Free 7-day trial:";
function share(kind, url) {
  const t = encodeURIComponent(SHARE_TEXT), u = encodeURIComponent(url), both = encodeURIComponent(`${SHARE_TEXT} ${url}`);
  return { whatsapp: `https://wa.me/?text=${both}`, facebook: `https://www.facebook.com/sharer/sharer.php?u=${u}`, x: `https://twitter.com/intent/tweet?text=${t}&url=${u}`,
    linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${u}`, telegram: `https://t.me/share/url?url=${u}&text=${t}`,
    email: `mailto:?subject=${encodeURIComponent("Start your own WiFi business")}&body=${both}`, sms: `sms:?body=${both}` }[kind];
}

async function download(what) {
  const r = await fetch(`${BASE}/api/admin/marketing/export/${what}`, { headers: { Authorization: `Bearer ${getToken()}` } });
  const blob = await r.blob(); const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = `safelinks-${what}.csv`; a.click();
}

export default function MarketingTab({ showToast = () => {} }) {
  const [days, setDays] = useState(30);
  const [view, setView] = useState("overview");
  const [ov, reloadOv] = useLoad(`/api/admin/marketing/overview?days=${days}`);
  const [opensSlug, setOpensSlug] = useState("");
  const [opens, reloadOpens] = useLoad(`/api/admin/marketing/opens${opensSlug ? `?slug=${encodeURIComponent(opensSlug)}` : ""}`);
  const [leads, reloadLeads] = useLoad("/api/admin/marketing/leads");
  const [settings] = useLoad("/api/admin/marketing/settings");
  const [nl, setNl] = useState({ label: "", channel: "whatsapp", campaign: "" });
  const [qr, setQr] = useState(null);
  const [bulk, setBulk] = useState({ message: "", status: "new" });
  const [px, setPx] = useState(null);
  const reloadAll = () => { reloadOv(); reloadOpens(); reloadLeads(); };

  useEffect(() => { const t = setInterval(reloadAll, 20000); return () => clearInterval(t); }, [days, opensSlug]);
  useEffect(() => { if (settings.data && px === null) setPx(settings.data); }, [settings.data]);

  const d = ov.data, tot = d?.totals || {};
  async function createLink() {
    try { const r = await http.post("/api/admin/marketing/links", nl); setNl({ ...nl, label: "", campaign: "" }); reloadOv(); setQr(r.slug); showToast("Tracking link created"); }
    catch (e) { showToast(e.message, "error"); }
  }
  const copy = (txt) => { navigator.clipboard?.writeText(txt); showToast("Copied"); };
  const tabBtn = (k, label) => <Btn key={k} size="sm" variant={view === k ? "solid" : "outline"} onClick={() => setView(k)}>{label}</Btn>;

  return (
    <div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
        {tabBtn("overview", "Overview")}{tabBtn("links", "Links & QR")}{tabBtn("opens", "Recent opens")}{tabBtn("audience", "Audience")}{tabBtn("leads", `Leads${leads.data?.leads?.length ? ` (${leads.data.leads.length})` : ""}`)}{tabBtn("settings", "Ads tracking")}
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ ...inputStyle, width: "auto", marginLeft: "auto" }}>
          {[1, 7, 30, 90, 365].map((n) => <option key={n} value={n}>Last {n === 1 ? "24 hours" : `${n} days`}</option>)}
        </select>
      </div>

      {ov.loading && !d ? <Loading /> : ov.error ? <EmptyRow text={ov.error} /> : (<>
        {(view === "overview") && (<>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 12, marginBottom: 14 }}>
            <StatCard icon={Eye} label="Opens" value={tot.opens} sub={`${tot.devices} different devices · ${tot.repeatOpens} repeat opens (same device)`} />
            <StatCard icon={Smartphone} label="Different devices" value={tot.devices} tone={T.primary} />
            <StatCard icon={Repeat} label="Repeat opens (same device)" value={tot.repeatOpens} tone={T.warning} />
            <StatCard icon={Megaphone} label="Leads (demo form)" value={tot.leads} />
            <StatCard icon={UserPlus} label="Signups" value={tot.signups} sub={tot.devices ? `${Math.round((tot.signups / tot.devices) * 1000) / 10}% of devices` : null} tone={T.success} />
            <StatCard icon={CheckCircle2} label="Paying resellers" value={tot.paid} tone={T.success} />
          </div>
          <Panel title="Same device or shared?">
            <div style={{ fontSize: 12.5, color: T.sub, marginBottom: 8 }}>For each link: how many times it was opened, by how many different devices. One device opening many times is someone coming back; many devices means the link or QR is being passed around.</div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead><tr style={{ textAlign: "left", color: T.sub }}>{["Link", "Opens", "Different devices", "Repeat opens (same device)", "Verdict", "Leads", "Signups", "Paid"].map((h) => <th key={h} style={{ padding: "6px 8px" }}>{h}</th>)}</tr></thead>
                <tbody>
                  {d.links.length === 0 && <tr><td colSpan={8}><EmptyRow text="Create a link in 'Links & QR' and share it" /></td></tr>}
                  {d.links.map((l) => (
                    <tr key={l.slug || "none"} data-testid={`row-${l.slug || "none"}`} style={{ borderTop: `1px solid ${T.border}` }}>
                      <td style={{ padding: "8px" }}><b>{l.label}</b>{l.channel && <div style={{ fontSize: 11.5, color: T.sub }}>{l.channel}</div>}</td>
                      <td style={{ padding: 8 }}>{l.opens}</td><td style={{ padding: 8 }}>{l.devices}</td><td style={{ padding: 8 }}>{l.repeatOpens}</td>
                      <td style={{ padding: 8 }}><Badge tone={l.devices > 1 ? (T.success) : l.opens ? (T.warning) : T.sub}>{l.verdict}</Badge></td>
                      <td style={{ padding: 8 }}>{l.leads}</td><td style={{ padding: 8 }}>{l.signups}</td><td style={{ padding: 8 }}>{l.paid}</td>
                    </tr>))}
                </tbody>
              </table>
            </div>
            <div style={{ fontSize: 11.5, color: T.sub, marginTop: 10, lineHeight: 1.5 }}>
              How devices are told apart: the page stores a random ID in that browser (no personal data) and sends it with every open; if storage is blocked we fall back to a rough signature (phone model, screen size, timezone, language).
              A private window, cleared browser data, or switching browsers (e.g. opening in WhatsApp's built-in browser, then in Chrome) looks like a new device, so "Shared" is a strong hint, not proof.
            </div>
          </Panel>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: 12, marginTop: 12 }}>
            <Panel title="Top countries"><Bars rows={d.countries} fmt={(k) => `${flag(k)} ${cname(k)}`} /></Panel>
            <Panel title="Where it was opened from"><Bars rows={d.sources} /></Panel>
          </div>
        </>)}

        {view === "links" && (<>
          <Panel title="New tracking link">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 10, alignItems: "end" }}>
              <Field label="Name (where you'll share it)"><input style={inputStyle} placeholder="e.g. Lagos flyers" value={nl.label} onChange={(e) => setNl({ ...nl, label: e.target.value })} /></Field>
              <Field label="Channel"><select style={inputStyle} value={nl.channel} onChange={(e) => setNl({ ...nl, channel: e.target.value })}>
                {["whatsapp", "facebook", "instagram", "tiktok", "x", "linkedin", "telegram", "flyer/QR", "email", "sms", "google ads", "influencer", "event", "other"].map((c) => <option key={c}>{c}</option>)}</select></Field>
              <Field label="Campaign (optional)"><input style={inputStyle} placeholder="e.g. December promo" value={nl.campaign} onChange={(e) => setNl({ ...nl, campaign: e.target.value })} /></Field>
              <Btn onClick={createLink}>Create link</Btn>
            </div>
            <div style={{ fontSize: 12, color: T.sub, marginTop: 8 }}>Tip: make one link per place you advertise (each WhatsApp group, flyer batch, influencer, ad) so you can see which one brings resellers.</div>
          </Panel>
          {qr && (
            <Panel title="QR code" style={{ marginTop: 12 }}>
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
                <img alt="QR code" width={180} height={180} src={`https://api.qrserver.com/v1/create-qr-code/?size=360x360&margin=10&data=${encodeURIComponent(linkUrl(qr))}`} />
                <div><div style={{ fontWeight: 700 }}>{linkUrl(qr)}</div>
                  <div style={{ fontSize: 12.5, color: T.sub, margin: "6px 0 10px" }}>Print it on flyers, posters, stickers or business cards. Every scan is counted here.</div>
                  <a href={`https://api.qrserver.com/v1/create-qr-code/?size=1000x1000&margin=20&format=png&data=${encodeURIComponent(linkUrl(qr))}`} target="_blank" rel="noreferrer"><Btn size="sm" variant="outline"><Download size={13} /> Print-size PNG</Btn></a></div>
              </div>
            </Panel>)}
          <Panel title="Your links" style={{ marginTop: 12 }}>
            {d.links.filter((l) => l.slug).length === 0 && <EmptyRow text="No links yet" />}
            {d.links.filter((l) => l.slug).map((l) => (
              <div key={l.slug} style={{ borderTop: `1px solid ${T.border}`, padding: "10px 0" }}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                  <b>{l.label}</b><Badge>{l.channel}</Badge><span style={{ fontSize: 12.5, color: T.sub }}>{l.opens} opens · {l.devices} devices · {l.signups} signups</span>
                  <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                    <Btn size="sm" variant="outline" onClick={() => copy(linkUrl(l.slug))}><Copy size={12} /> Copy</Btn>
                    <Btn size="sm" variant="outline" onClick={() => setQr(l.slug)}><QrCode size={12} /> QR</Btn>
                    <Btn size="sm" variant="outline" onClick={() => { setOpensSlug(l.slug); setView("opens"); }}>Opens</Btn>
                    <Btn size="sm" variant="ghost" tone={T.danger} onClick={async () => { await http.del(`/api/admin/marketing/links/${l.slug}`); reloadOv(); }}>Archive</Btn>
                  </span>
                </div>
                <div style={{ fontSize: 12.5, color: T.sub, margin: "4px 0 6px", wordBreak: "break-all" }}>{linkUrl(l.slug)}</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {[["whatsapp", "WhatsApp"], ["facebook", "Facebook"], ["x", "X"], ["linkedin", "LinkedIn"], ["telegram", "Telegram"], ["email", "Email"], ["sms", "SMS"]].map(([k, n]) => (
                    <a key={k} href={share(k, linkUrl(l.slug))} target="_blank" rel="noreferrer" style={{ fontSize: 12, padding: "4px 10px", border: `1px solid ${T.border}`, borderRadius: 999, color: T.ink, textDecoration: "none" }}>{n}</a>))}
                </div>
              </div>))}
          </Panel>
        </>)}

        {view === "opens" && (
          <Panel title="Recent opens" action={<div style={{ display: "flex", gap: 6 }}>
            <select value={opensSlug} onChange={(e) => setOpensSlug(e.target.value)} style={{ ...inputStyle, width: "auto" }}>
              <option value="">All links</option>{d.links.map((l) => <option key={l.slug || "none"} value={l.slug || "(no label)"}>{l.label}</option>)}</select>
            <Btn size="sm" variant="outline" onClick={() => download("opens")}><Download size={12} /> CSV</Btn></div>}>
            {opens.loading ? <Loading /> : (opens.data?.opens || []).length === 0 ? <EmptyRow text="No opens yet" /> : (
              <div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead><tr style={{ textAlign: "left", color: T.sub }}>{["When", "Link", "Device", "Same or new?", "Location", "Phone / browser", "Language", "Came from"].map((h) => <th key={h} style={{ padding: "6px 8px" }}>{h}</th>)}</tr></thead>
                <tbody>{opens.data.opens.map((o, i) => (
                  <tr key={i} style={{ borderTop: `1px solid ${T.border}` }}>
                    <td style={{ padding: 8, whiteSpace: "nowrap" }}>{timeAgo(o.at)}</td>
                    <td style={{ padding: 8 }}>{o.label}</td>
                    <td style={{ padding: 8 }}><span style={{ display: "inline-block", minWidth: 26, textAlign: "center", borderRadius: 999, background: T.bg, fontWeight: 700, padding: "2px 6px" }}>#{o.deviceNo}</span></td>
                    <td style={{ padding: 8 }}><Badge tone={o.newDevice ? (T.success) : (T.warning)}>{o.tag}</Badge></td>
                    <td style={{ padding: 8 }}>{flag(o.country)} {[o.city, cname(o.country)].filter(Boolean).join(", ")}<div style={{ fontSize: 11, color: T.sub }}>{o.timezone}</div></td>
                    <td style={{ padding: 8 }}>{o.device}<div style={{ fontSize: 11, color: T.sub }}>{[o.browser, o.type, o.screen].filter(Boolean).join(" · ")}</div></td>
                    <td style={{ padding: 8 }}>{o.lang}</td><td style={{ padding: 8 }}>{o.source || "Direct / QR"}</td>
                  </tr>))}</tbody></table></div>)}
          </Panel>)}

        {view === "audience" && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: 12 }}>
            <Panel title="Countries"><Bars rows={d.countries} max={15} fmt={(k) => `${flag(k)} ${cname(k)}`} /></Panel>
            <Panel title="Cities"><Bars rows={d.cities} max={15} /></Panel>
            <Panel title="Phones & devices"><Bars rows={d.devices} /></Panel>
            <Panel title="Operating system"><Bars rows={d.os} /></Panel>
            <Panel title="Browser / app"><Bars rows={d.browsers} /></Panel>
            <Panel title="Languages (write ads in these)"><Bars rows={d.languages} /></Panel>
            <Panel title="Best hours to post (WAT)">
              <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 90 }}>
                {d.byHour.map((h) => { const m = Math.max(1, ...d.byHour.map((x) => x.n)); return <div key={h.hour} title={`${h.hour}:00 · ${h.n}`} style={{ flex: 1, background: T.primary, opacity: h.n ? 1 : 0.15, height: `${Math.max(4, (h.n / m) * 100)}%`, borderRadius: 2 }} />; })}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: T.sub }}><span>0h</span><span>6h</span><span>12h</span><span>18h</span><span>23h</span></div>
            </Panel>
            <Panel title="Opens per day"><Bars rows={[...d.byDay].reverse()} max={14} /></Panel>
          </div>)}

        {view === "leads" && (<>
          <Panel title="Leads from the demo form" action={<Btn size="sm" variant="outline" onClick={() => download("leads")}><Download size={12} /> CSV</Btn>}>
            {(leads.data?.leads || []).length === 0 ? <EmptyRow text="No leads yet" /> : (
              <div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead><tr style={{ textAlign: "left", color: T.sub }}>{["When", "Name", "Contact", "Where", "Link", "This device opened the page", "Status", ""].map((h) => <th key={h} style={{ padding: "6px 8px" }}>{h}</th>)}</tr></thead>
                <tbody>{leads.data.leads.map((l) => (
                  <tr key={l.id} style={{ borderTop: `1px solid ${T.border}` }}>
                    <td style={{ padding: 8, whiteSpace: "nowrap" }}>{timeAgo(Number(l.created_at))}</td>
                    <td style={{ padding: 8 }}><b>{l.name}</b><div style={{ fontSize: 11.5, color: T.sub }}>{l.company}</div>{l.message && <div style={{ fontSize: 11.5, color: T.sub, maxWidth: 220 }}>"{l.message}"</div>}</td>
                    <td style={{ padding: 8 }}>{l.phone}<div style={{ fontSize: 11.5, color: T.sub }}>{l.email}</div></td>
                    <td style={{ padding: 8 }}>{flag(l.country)} {[l.city, cname(l.country)].filter(Boolean).join(", ")}</td>
                    <td style={{ padding: 8 }}>{l.label || (l.slug || "(no label)")}</td>
                    <td style={{ padding: 8 }}><b>{Number(l.device_opens) || 0}×</b></td>
                    <td style={{ padding: 8 }}><select value={l.status} style={{ ...inputStyle, width: "auto", padding: "4px 6px" }} onChange={async (e) => { await http.put(`/api/admin/marketing/leads/${l.id}`, { status: e.target.value }); reloadLeads(); }}>
                      {["new", "contacted", "demo booked", "converted", "lost"].map((s) => <option key={s}>{s}</option>)}</select></td>
                    <td style={{ padding: 8, whiteSpace: "nowrap" }}>
                      {l.phone && <a href={`https://wa.me/${String(l.phone).replace(/\D/g, "")}?text=${encodeURIComponent(`Hi ${l.name}, thanks for your interest in SAFE_Links. When is a good time for a quick demo?`)}`} target="_blank" rel="noreferrer" style={{ marginRight: 8 }}>WhatsApp</a>}
                      {l.phone && <a href={`tel:${l.phone}`} style={{ marginRight: 8 }}>Call</a>}
                      {l.email && <a href={`mailto:${l.email}?subject=SAFE_Links demo`}>Email</a>}
                    </td>
                  </tr>))}</tbody></table></div>)}
          </Panel>
          <Panel title="Message leads (SMS / WhatsApp)" style={{ marginTop: 12 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 180px auto", gap: 10, alignItems: "end" }}>
              <Field label="Message"><input style={inputStyle} value={bulk.message} placeholder="Your 7-day free trial is waiting: …" onChange={(e) => setBulk({ ...bulk, message: e.target.value })} /></Field>
              <Field label="Send to"><select style={inputStyle} value={bulk.status} onChange={(e) => setBulk({ ...bulk, status: e.target.value })}>{["all", "new", "contacted", "demo booked", "lost"].map((s) => <option key={s}>{s}</option>)}</select></Field>
              <Btn onClick={async () => { try { const r = await http.post("/api/admin/marketing/leads/message", bulk); showToast(`Sent to ${r.sent} of ${r.recipients}`); } catch (e) { showToast(e.message, "error"); } }}><Send size={13} /> Send</Btn>
            </div>
          </Panel>
        </>)}

        {view === "settings" && px && (
          <Panel title="Ads tracking (retarget visitors)">
            <div style={{ fontSize: 13, color: T.sub, marginBottom: 10 }}>Add your Meta (Facebook/Instagram) Pixel and Google Analytics IDs. The pitch page then reports visits, demo requests and trial starts so you can retarget people who opened your link and build lookalike audiences in any country.</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 10, alignItems: "end" }}>
              <Field label="Meta Pixel ID"><input style={inputStyle} value={px.metaPixelId} onChange={(e) => setPx({ ...px, metaPixelId: e.target.value })} placeholder="123456789012345" /></Field>
              <Field label="Google Analytics ID"><input style={inputStyle} value={px.gaId} onChange={(e) => setPx({ ...px, gaId: e.target.value })} placeholder="G-XXXXXXX" /></Field>
              <Btn onClick={async () => { try { await http.put("/api/admin/marketing/settings", px); showToast("Saved"); } catch (e) { showToast(e.message, "error"); } }}>Save</Btn>
            </div>
            <div style={{ fontSize: 12, color: T.sub, marginTop: 12 }}><Globe size={12} /> Pitch page: <a href={`${PUBLIC}/go`} target="_blank" rel="noreferrer">{PUBLIC}/go</a> · auto-translates (English, French, Portuguese, Swahili) and shows prices in the visitor's currency.</div>
          </Panel>)}
      </>)}
    </div>
  );
}
