import React, { useEffect, useRef, useState } from "react";
import { Mic, MicOff, HelpCircle, X } from "lucide-react";
import { T } from "./ui.jsx";
import { dt } from "./dashboardI18n.js";

/* Voice control for people who can't easily see the screen or use a
 * mouse/keyboard — a blind reseller navigating by ear, or someone with
 * a motor impairment who finds clicking small buttons difficult. Two
 * halves, deliberately kept independent so each still helps on its own
 * even where the other doesn't work:
 *
 *   1. VOICE INPUT (SpeechRecognition) — say a command, it runs.
 *      Chrome/Edge only as of this writing; Safari and Firefox don't
 *      implement the API, so this half quietly disables itself
 *      (button shows as unavailable, with a plain-text reason) rather
 *      than pretending to listen and doing nothing.
 *
 *   2. SPOKEN + TEXTUAL FEEDBACK (SpeechSynthesis + aria-live) — every
 *      response is BOTH spoken out loud AND written into an
 *      aria-live region. That second part matters even when TTS
 *      works: a blind person very likely already has their own
 *      screen reader running, and a screen reader narrating our
 *      aria-live text is more reliable and more familiar to them
 *      than a second, unrelated voice competing with it. This half
 *      works in every browser, with or without SpeechRecognition.
 *
 * Every string this component speaks or displays — the chrome around
 * the mic button, the "listening"/"no match" feedback, aria-labels —
 * comes from dashboardI18n.js's `dt()`, keyed by `lang`, so a Kiswahili
 * speaker hears Kiswahili words in a Kiswahili-accented voice, not
 * English words with a Kiswahili accent. The `commands` themselves
 * (labels + match phrases) are the caller's responsibility to
 * translate too — see App.jsx and ui.jsx, which build their command
 * lists from the same `dt()` dictionary.
 *
 * `commands` — array of { match: string[], label, run }. `match`
 * entries are substrings checked against the lowercased transcript;
 * first one found wins. `run` can be sync or return a string to
 * speak instead of the default "label" confirmation.
 */

const LANG_MAP = { en: "en-US", fr: "fr-FR", sw: "sw-KE", ha: "ha-NG", yo: "yo-NG", pt: "pt-PT" };

function speak(text, lang) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel(); // don't stack up overlapping utterances
  const u = new SpeechSynthesisUtterance(text);
  u.lang = LANG_MAP[lang] || "en-US";
  u.rate = 1;
  window.speechSynthesis.speak(u);
}

export default function VoiceAssistant({ commands, lang = "en", greeting }) {
  const [supported, setSupported] = useState(true);
  const [listening, setListening] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [showHelp, setShowHelp] = useState(false);
  const recognitionRef = useRef(null);

  useEffect(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { setSupported(false); return; }
    const rec = new SR();
    rec.continuous = false;
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onresult = (e) => {
      const transcript = e.results[0][0].transcript.toLowerCase().trim();
      handleTranscript(transcript);
    };
    rec.onerror = () => setListening(false);
    rec.onend = () => setListening(false);
    recognitionRef.current = rec;
    return () => { try { rec.abort(); } catch { /* already stopped */ } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commands, lang]);

  useEffect(() => {
    // Announced via aria-live only (not spoken aloud) — a screen reader
    // user gets to know this exists without an unsolicited voice
    // interrupting them the moment a page loads.
    if (greeting) setFeedback(greeting);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleTranscript(transcript) {
    const cmd = commands.find((c) => c.match.some((m) => transcript.includes(m)));
    if (!cmd) {
      const msg = dt(lang, "voiceNoMatch", { transcript });
      setFeedback(msg);
      speak(msg, lang);
      return;
    }
    const result = cmd.run();
    const msg = typeof result === "string" ? result : cmd.label;
    setFeedback(msg);
    speak(msg, lang);
  }

  function toggleListening() {
    if (!supported || !recognitionRef.current) return;
    if (listening) {
      recognitionRef.current.stop();
      setListening(false);
      return;
    }
    try {
      recognitionRef.current.lang = LANG_MAP[lang] || "en-US";
      recognitionRef.current.start();
      setListening(true);
      setFeedback(dt(lang, "voiceListening"));
    } catch {
      // start() throws if already-started from a fast double-click; ignore
    }
  }

  return (
    <div style={{ position: "fixed", bottom: 20, right: 20, zIndex: 900, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 10 }}>
      {showHelp && (
        <div role="dialog" aria-label={dt(lang, "voiceListCommandsAria")} style={{
          background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 16, width: 260,
          boxShadow: "0 10px 30px rgba(20,20,43,0.18)", maxHeight: 320, overflowY: "auto",
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div style={{ fontWeight: 700, fontSize: 13.5, color: T.ink }}>{dt(lang, "voiceTitle")}</div>
            <button aria-label={dt(lang, "voiceCloseListAria")} onClick={() => setShowHelp(false)}
              style={{ background: "none", border: "none", cursor: "pointer", color: T.sub, padding: 2 }}>
              <X size={15} />
            </button>
          </div>
          <ul style={{ margin: 0, padding: 0, listStyle: "none", fontSize: 12.5, color: T.sub, lineHeight: 1.9 }}>
            {commands.map((c, i) => <li key={i}>"{c.match[0]}"</li>)}
          </ul>
          {!supported && (
            <div style={{ marginTop: 10, fontSize: 11.5, color: T.warning }}>
              {dt(lang, "voiceNotSupported")}
            </div>
          )}
        </div>
      )}

      {feedback && (
        <div style={{
          background: T.ink, color: "#fff", padding: "8px 14px", borderRadius: 10, fontSize: 12.5,
          maxWidth: 280, boxShadow: "0 6px 18px rgba(0,0,0,0.18)",
        }}>
          {feedback}
        </div>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <button
          aria-label={dt(lang, "voiceListCommandsAria")}
          onClick={() => setShowHelp((v) => !v)}
          style={{
            width: 38, height: 38, borderRadius: "50%", border: `1px solid ${T.border}`, background: T.card,
            color: T.sub, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: "0 2px 8px rgba(20,20,43,0.1)",
          }}
        >
          <HelpCircle size={17} />
        </button>
        <button
          aria-label={!supported ? dt(lang, "voiceNotSupportedAria") : listening ? dt(lang, "voiceStopListeningAria") : dt(lang, "voiceStartListeningAria")}
          aria-pressed={listening}
          disabled={!supported}
          onClick={toggleListening}
          title={!supported ? dt(lang, "voiceNotSupported") : undefined}
          style={{
            width: 52, height: 52, borderRadius: "50%", border: "none",
            background: !supported ? T.border : listening ? T.danger : `linear-gradient(135deg, ${T.primary}, ${T.secondary})`,
            color: "#fff", cursor: supported ? "pointer" : "not-allowed",
            display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: "0 4px 14px rgba(20,20,43,0.22)",
            animation: listening ? "pulse 1.4s ease-in-out infinite" : "none",
          }}
        >
          {!supported ? <MicOff size={22} /> : <Mic size={22} />}
        </button>
      </div>

      {/* Mirrors `feedback` for anyone using an actual screen reader —
          independent of whether SpeechSynthesis above is audible or
          even supported, this line always gets announced. */}
      <div aria-live="assertive" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0,0,0,0)" }}>
        {feedback}
      </div>

      <style>{`@keyframes pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.08); } }`}</style>
    </div>
  );
}
