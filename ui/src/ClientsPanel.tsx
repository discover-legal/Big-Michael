import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { api } from "./api";
import type { Client, ClientMatter, ConflictCheckResult } from "./types";
import { PRACTICE_AREAS } from "./types";

export function ClientsPanel({ onClose, notify }: { onClose: () => void; notify: (m: string) => void }) {
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<"clients" | "new-client" | "new-matter">("clients");
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<ConflictCheckResult | null>(null);

  const [nc, setNc] = useState({ name: "", clientNumber: "", adversaries: "", notes: "" });
  const [nm, setNm] = useState({ matterNumber: "", description: "", practiceArea: "" });

  const selected = clients.find((c) => c.id === selectedId) ?? null;

  const load = () => api.listClients().then(setClients).catch((e) => notify((e as Error).message)).finally(() => setLoading(false));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function checkConflict() {
    if (!nc.name.trim()) return;
    try {
      const res = await api.checkConflict(nc.name.trim());
      setConflict(res);
    } catch { /* ignore */ }
  }

  async function addClient() {
    if (!nc.name.trim() || !nc.clientNumber.trim()) { notify("Name and client number required"); return; }
    setBusy(true);
    try {
      const adversaries = nc.adversaries.split(",").map((s) => s.trim()).filter(Boolean);
      const res = await api.createClient({ name: nc.name, clientNumber: nc.clientNumber, adversaries, notes: nc.notes || undefined });
      if (res.conflict?.hasConflict) {
        notify(`⚠ Conflict detected: ${res.conflict.conflictingClientName} lists "${res.conflict.matchedAdversary}" as an adverse party`);
      } else {
        notify("Client added");
      }
      setNc({ name: "", clientNumber: "", adversaries: "", notes: "" });
      setConflict(null);
      await load();
      setSelectedId(res.id);
      setTab("clients");
    } catch (e) { notify((e as Error).message); } finally { setBusy(false); }
  }

  async function removeClient(id: string) {
    if (!window.confirm("Delete this client and all their matters?")) return;
    try { await api.deleteClient(id); await load(); setSelectedId(null); notify("Client removed"); }
    catch (e) { notify((e as Error).message); }
  }

  async function addMatter() {
    if (!selectedId || !nm.matterNumber.trim() || !nm.description.trim()) { notify("Matter number and description required"); return; }
    setBusy(true);
    try {
      await api.addMatter(selectedId, { matterNumber: nm.matterNumber, description: nm.description, practiceArea: nm.practiceArea || undefined });
      setNm({ matterNumber: "", description: "", practiceArea: "" });
      await load();
      setTab("clients");
      notify("Matter added");
    } catch (e) { notify((e as Error).message); } finally { setBusy(false); }
  }

  async function removeMatter(clientId: string, matterNumber: string) {
    if (!window.confirm("Remove this matter?")) return;
    try { await api.removeMatter(clientId, matterNumber); await load(); notify("Matter removed"); }
    catch (e) { notify((e as Error).message); }
  }

  return (
    <div className="modal-scrim" onClick={onClose}>
      <motion.div className="modal admin" style={{ maxWidth: 760 }} onClick={(e) => e.stopPropagation()}
        initial={{ opacity: 0, y: 18, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: "spring", stiffness: 320, damping: 28 }}>
        <div className="modal-head">
          <h3>Clients &amp; matters</h3>
          <p>Manage client roster, matters, and conflicts of interest.</p>
        </div>

        <div className="tabs" style={{ margin: "0 26px" }}>
          <button className={`tab ${tab === "clients" ? "active" : ""}`} onClick={() => setTab("clients")}>
            Clients {tab === "clients" && <motion.span layoutId="cp-ul" className="tab-underline" />}
          </button>
          <button className={`tab ${tab === "new-client" ? "active" : ""}`} onClick={() => setTab("new-client")}>
            Add client {tab === "new-client" && <motion.span layoutId="cp-ul" className="tab-underline" />}
          </button>
          {selected && (
            <button className={`tab ${tab === "new-matter" ? "active" : ""}`} onClick={() => setTab("new-matter")}>
              Add matter {tab === "new-matter" && <motion.span layoutId="cp-ul" className="tab-underline" />}
            </button>
          )}
        </div>

        <div className="modal-body">
          <AnimatePresence mode="wait">
            {tab === "clients" && (
              <motion.div key="clients" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                {loading && <div className="placeholder">Loading…</div>}
                {!loading && !clients.length && (
                  <div className="placeholder">No clients yet. Add one above.</div>
                )}
                <div style={{ display: "flex", gap: 16, height: 420 }}>
                  {/* Client list */}
                  <div style={{ width: 240, flexShrink: 0, display: "flex", flexDirection: "column", gap: 6, overflowY: "auto" }}>
                    {clients.map((c) => (
                      <button key={c.id}
                        className={`task-card ${c.id === selectedId ? "active" : ""}`}
                        style={{ textAlign: "left" }}
                        onClick={() => setSelectedId(c.id)}>
                        <div style={{ fontWeight: 600, fontSize: 13 }}>{c.name}</div>
                        <div style={{ color: "var(--text-faint)", fontSize: 11.5 }}>{c.clientNumber} · {c.matters.length} matter{c.matters.length !== 1 ? "s" : ""}</div>
                      </button>
                    ))}
                  </div>

                  {/* Client detail */}
                  <div style={{ flex: 1, overflowY: "auto", paddingLeft: 8 }}>
                    {!selected ? (
                      <div className="placeholder" style={{ paddingTop: 48 }}>Select a client to view details.</div>
                    ) : (
                      <div>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
                          <div>
                            <div style={{ fontWeight: 700, fontSize: 16 }}>{selected.name}</div>
                            <div style={{ color: "var(--text-dim)", fontSize: 12.5 }}>Client #{selected.clientNumber}</div>
                            {selected.notes && <div style={{ color: "var(--text-dim)", fontSize: 12.5, marginTop: 4 }}>{selected.notes}</div>}
                          </div>
                          <div style={{ display: "flex", gap: 8 }}>
                            <button className="btn primary sm" onClick={() => setTab("new-matter")}>＋ Matter</button>
                            <button className="btn reject sm" onClick={() => removeClient(selected.id)}>✕</button>
                          </div>
                        </div>

                        {selected.adversaries.length > 0 && (
                          <div style={{ marginBottom: 14 }}>
                            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--amber)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>Adverse parties</div>
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                              {selected.adversaries.map((a) => (
                                <span key={a} className="pill" style={{ background: "rgba(218,106,96,0.15)", color: "var(--red)" }}>{a}</span>
                              ))}
                            </div>
                          </div>
                        )}

                        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>
                          Matters · {selected.matters.length}
                        </div>
                        {selected.matters.length === 0 && (
                          <div className="placeholder">No matters yet.</div>
                        )}
                        {selected.matters.map((m) => (
                          <MatterRow key={m.matterNumber} matter={m} onRemove={() => removeMatter(selected.id, m.matterNumber)} />
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </motion.div>
            )}

            {tab === "new-client" && (
              <motion.div key="new-client" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                <div className="field">
                  <label>Client name</label>
                  <input value={nc.name} onChange={(e) => setNc({ ...nc, name: e.target.value })}
                    onBlur={checkConflict} placeholder="Acme Corporation" />
                </div>
                <AnimatePresence>
                  {conflict?.hasConflict && (
                    <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
                      style={{ background: "rgba(218,106,96,0.12)", border: "1px solid rgba(218,106,96,0.4)", borderRadius: 8, padding: "10px 14px", marginBottom: 12, color: "var(--red)", fontSize: 13 }}>
                      ⚠ Potential conflict of interest — <strong>{conflict.conflictingClientName}</strong> lists "<em>{conflict.matchedAdversary}</em>" as an adverse party.
                    </motion.div>
                  )}
                </AnimatePresence>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                  <div className="field">
                    <label>Client number</label>
                    <input value={nc.clientNumber} onChange={(e) => setNc({ ...nc, clientNumber: e.target.value })} placeholder="C-001" />
                  </div>
                </div>
                <div className="field">
                  <label>Adverse parties <span style={{ fontWeight: 400, color: "var(--text-faint)" }}>(comma-separated, for conflict checks)</span></label>
                  <input value={nc.adversaries} onChange={(e) => setNc({ ...nc, adversaries: e.target.value })} placeholder="Beta Inc, Gamma Ltd" />
                </div>
                <div className="field">
                  <label>Notes</label>
                  <textarea style={{ minHeight: 72 }} value={nc.notes} onChange={(e) => setNc({ ...nc, notes: e.target.value })} placeholder="Optional internal notes…" />
                </div>
              </motion.div>
            )}

            {tab === "new-matter" && selected && (
              <motion.div key="new-matter" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                <div style={{ color: "var(--text-dim)", fontSize: 13, marginBottom: 16 }}>
                  Adding matter to <strong>{selected.name}</strong>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                  <div className="field">
                    <label>Matter number</label>
                    <input value={nm.matterNumber} onChange={(e) => setNm({ ...nm, matterNumber: e.target.value })} placeholder="M-2026-001" />
                  </div>
                  <div className="field">
                    <label>Practice area</label>
                    <select value={nm.practiceArea} onChange={(e) => setNm({ ...nm, practiceArea: e.target.value })}>
                      <option value="">— Select —</option>
                      {PRACTICE_AREAS.map((pa) => <option key={pa} value={pa}>{pa}</option>)}
                    </select>
                  </div>
                </div>
                <div className="field">
                  <label>Description</label>
                  <textarea style={{ minHeight: 80 }} value={nm.description} onChange={(e) => setNm({ ...nm, description: e.target.value })} placeholder="Brief description of the matter…" />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>Close</button>
          {tab === "new-client" && (
            <button className="btn primary" disabled={busy || !nc.name.trim() || !nc.clientNumber.trim()} onClick={addClient}>
              {busy ? "Adding…" : "＋ Add client"}
            </button>
          )}
          {tab === "new-matter" && selected && (
            <button className="btn primary" disabled={busy || !nm.matterNumber.trim() || !nm.description.trim()} onClick={addMatter}>
              {busy ? "Adding…" : "＋ Add matter"}
            </button>
          )}
        </div>
      </motion.div>
    </div>
  );
}

function MatterRow({ matter, onRemove }: { matter: ClientMatter; onRemove: () => void }) {
  return (
    <div className="lawyer-row" style={{ marginBottom: 8 }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>{matter.matterNumber}</div>
        <div style={{ color: "var(--text-dim)", fontSize: 12.5 }}>{matter.description}</div>
      </div>
      {matter.practiceArea && <span className="pill sm blue">{matter.practiceArea}</span>}
      <button className="btn reject sm" onClick={onRemove} title="Remove matter">✕</button>
    </div>
  );
}
