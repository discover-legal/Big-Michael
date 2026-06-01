import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { api } from "./api";
import type { AppSettings } from "./types";

export function AdminPanel({ onClose, notify }: { onClose: () => void; notify: (m: string) => void }) {
  const [s, setS] = useState<AppSettings | null>(null);
  const [apiKey, setApiKey] = useState("");           // only sent if the user types a new one
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.getSettings().then(setS).catch((e) => notify((e as Error).message)); }, [notify]);

  function patch<K extends keyof AppSettings>(section: K, key: keyof AppSettings[K], value: unknown) {
    setS((prev) => prev && ({ ...prev, [section]: { ...prev[section], [key]: value } }));
  }

  async function save() {
    if (!s) return;
    setBusy(true);
    try {
      const next = await api.updateSettings({
        presentation: s.presentation,
        dytopo: s.dytopo,
        debate: s.debate,
        docuseal: { enabled: s.docuseal.enabled, url: s.docuseal.url, ...(apiKey ? { apiKey } : {}) },
      });
      setS(next); setApiKey("");
      notify("Settings saved — applied live");
    } catch (e) { notify((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <div className="modal-scrim" onClick={onClose}>
      <motion.div className="modal admin" onClick={(e) => e.stopPropagation()}
        initial={{ opacity: 0, y: 18, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: "spring", stiffness: 320, damping: 28 }}>
        <div className="modal-head">
          <h3>Admin · settings</h3>
          <p>Changes apply live across the bench. No restart needed.</p>
        </div>

        {!s ? <div className="modal-body"><div className="placeholder">Loading settings…</div></div> : (
          <div className="modal-body">
            {/* ── Practice mode ───────────────────────────────────────────── */}
            <div className="admin-section">
              <div className="admin-section-title">Presentation</div>
              <div className="field">
                <label>Audience mode</label>
                <div className="wf-grid two">
                  <div className={`wf-chip ${s.presentation.mode === "lawyer" ? "sel" : ""}`} onClick={() => patch("presentation", "mode", "lawyer")}>
                    <div className="wf-name">Lawyer</div>
                    <div className="wf-desc">Full legal terminology &amp; citations</div>
                  </div>
                  <div className={`wf-chip ${s.presentation.mode === "plain" ? "sel" : ""}`} onClick={() => patch("presentation", "mode", "plain")}>
                    <div className="wf-name">Non-lawyer</div>
                    <div className="wf-desc">Plain-language framing</div>
                  </div>
                </div>
              </div>
              <div className="field">
                <label>Firm / organisation name</label>
                <input value={s.presentation.firmName} onChange={(e) => patch("presentation", "firmName", e.target.value)} placeholder="Shown in the header — optional" />
              </div>
            </div>

            {/* ── Orchestration (DyTopo) ──────────────────────────────────── */}
            <div className="admin-section">
              <div className="admin-section-title">Orchestration · DyTopo</div>
              <div className="admin-grid">
                <NumField label="Round depth (max rounds)" value={s.dytopo.maxRounds} min={1} max={30} onChange={(v) => patch("dytopo", "maxRounds", v)} />
                <NumField label="Max agents / round" value={s.dytopo.maxAgentsPerRound} min={1} max={48} onChange={(v) => patch("dytopo", "maxAgentsPerRound", v)} />
                <NumField label="Need/Offer match threshold" value={s.dytopo.similarityThreshold} min={0.1} max={0.99} step={0.01} onChange={(v) => patch("dytopo", "similarityThreshold", v)} />
              </div>
            </div>

            {/* ── Debate & verification ───────────────────────────────────── */}
            <div className="admin-section">
              <div className="admin-section-title">Debate &amp; verification</div>
              <div className="admin-grid">
                <NumField label="Verification passes" value={s.debate.verificationPasses} min={0} max={25} onChange={(v) => patch("debate", "verificationPasses", v)} />
                <NumField label="Human-gate confidence" value={s.debate.gateConfidenceThreshold} min={0} max={1} step={0.01} onChange={(v) => patch("debate", "gateConfidenceThreshold", v)} />
              </div>
              <label className="check"><input type="checkbox" checked={s.debate.adversarialEnabled} onChange={(e) => patch("debate", "adversarialEnabled", e.target.checked)} /> Adversarial challenge enabled</label>
              <label className="check"><input type="checkbox" checked={s.debate.citationRequired} onChange={(e) => patch("debate", "citationRequired", e.target.checked)} /> Require citations (CitationGate)</label>
            </div>

            {/* ── DocuSeal ────────────────────────────────────────────────── */}
            <div className="admin-section">
              <div className="admin-section-title">DocuSeal · e-signature</div>
              <label className="check"><input type="checkbox" checked={s.docuseal.enabled} onChange={(e) => patch("docuseal", "enabled", e.target.checked)} /> Enable e-signature tools</label>
              <div className="field">
                <label>DocuSeal URL</label>
                <input value={s.docuseal.url} onChange={(e) => patch("docuseal", "url", e.target.value)} placeholder="http://localhost:3000" />
              </div>
              <div className="field">
                <label>API key {s.docuseal.apiKeySet && <span className="key-set">● configured</span>}</label>
                <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
                  placeholder={s.docuseal.apiKeySet ? "•••••••• — leave blank to keep" : "X-Auth-Token"} />
              </div>
            </div>
          </div>
        )}

        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>Close</button>
          <button className="btn primary" disabled={busy || !s} onClick={save}>{busy ? "Saving…" : "Save settings"}</button>
        </div>
      </motion.div>
    </div>
  );
}

function NumField({ label, value, min, max, step, onChange }: {
  label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      <input type="number" value={value} min={min} max={max} step={step ?? 1}
        onChange={(e) => onChange(step ? parseFloat(e.target.value) : parseInt(e.target.value))} />
    </div>
  );
}
