import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { api } from "./api";
import { WORKFLOWS, type Task, type Template, type WorkflowType, type DocumentRef } from "./types";

export function SubmitModal({ onClose, onCreated, notify }: {
  onClose: () => void;
  onCreated: (task: Task) => void;
  notify: (msg: string) => void;
}) {
  const [description, setDescription] = useState("");
  const [clientNumber, setClientNumber] = useState("");
  const [matterNumber, setMatterNumber] = useState("");
  const [workflow, setWorkflow] = useState<WorkflowType>("full_bench");
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [docs, setDocs] = useState<DocumentRef[]>([]);
  const [selectedDocs, setSelectedDocs] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.listTemplates().then(setTemplates).catch(() => {});
    api.listDocuments().then(setDocs).catch(() => {});
  }, []);

  function toggleDoc(id: string) {
    setSelectedDocs((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function submit() {
    setBusy(true);
    const documentIds = [...selectedDocs];
    const refs = { clientNumber: clientNumber.trim() || undefined, matterNumber: matterNumber.trim() || undefined };
    try {
      const task = templateId
        ? await api.fromTemplate({ templateId, documentIds, ...refs })
        : await api.submitTask({ description, workflowType: workflow, documentIds, ...refs });
      notify("Task submitted — agents convening");
      onCreated(task);
    } catch (e) {
      notify((e as Error).message);
      setBusy(false);
    }
  }

  const canSubmit = !busy && (templateId !== "" || description.trim().length > 8);

  return (
    <div className="modal-scrim" onClick={onClose}>
      <motion.div className="modal" onClick={(e) => e.stopPropagation()}
        initial={{ opacity: 0, y: 18, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: "spring", stiffness: 320, damping: 28 }}>
        <div className="modal-head">
          <h3>Convene the bench</h3>
          <p>Brief the orchestrator. It assembles the agent graph and runs the protocol.</p>
        </div>

        <div className="modal-body">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <div className="field">
              <label>Client number</label>
              <input value={clientNumber} onChange={(e) => setClientNumber(e.target.value)} placeholder="e.g. 10482" />
            </div>
            <div className="field">
              <label>Matter number</label>
              <input value={matterNumber} onChange={(e) => setMatterNumber(e.target.value)} placeholder="e.g. 10482-014" />
            </div>
          </div>

          <div className="field">
            <label>The matter</label>
            <textarea
              autoFocus
              placeholder="e.g. Review this master services agreement and summarise the key risks, obligations, and unusual terms under New York law…"
              value={description}
              onChange={(e) => { setDescription(e.target.value); setTemplateId(""); }}
            />
          </div>

          <div className="field">
            <label>Workflow</label>
            <div className="wf-grid">
              {WORKFLOWS.map((w) => (
                <div key={w.id} className={`wf-chip ${workflow === w.id && !templateId ? "sel" : ""}`}
                     onClick={() => { setWorkflow(w.id); setTemplateId(""); }}>
                  <div className="wf-name">{w.name}</div>
                  <div className="wf-desc">{w.desc}</div>
                </div>
              ))}
            </div>
          </div>

          {docs.length > 0 && (
            <div className="field">
              <label>Attach documents · {selectedDocs.size} selected</label>
              <div className="doc-pick">
                {docs.map((d) => (
                  <button
                    type="button"
                    key={d.id}
                    className={`doc-chip ${selectedDocs.has(d.id) ? "sel" : ""}`}
                    onClick={() => toggleDoc(d.id)}
                  >
                    <span className="doc-check">{selectedDocs.has(d.id) ? "✓" : "＋"}</span>
                    <span className="doc-name">{d.title}</span>
                    {d.documentType && <span className="doc-type">{d.documentType}</span>}
                  </button>
                ))}
              </div>
            </div>
          )}

          {templates.length > 0 && (
            <>
              <div className="divider-or">or run a template</div>
              <div className="field">
                <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                  <option value="">— pick a pre-built workflow —</option>
                  {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
            </>
          )}
        </div>

        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!canSubmit} onClick={submit}>
            {busy ? "Convening…" : "⚖ Convene"}
          </button>
        </div>
      </motion.div>
    </div>
  );
}
