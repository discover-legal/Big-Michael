import { useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { api } from "./api";
import type { IngestResult, SearchResult } from "./types";
import { PRACTICE_AREAS } from "./types";

export function Library({ onClose, notify }: { onClose: () => void; notify: (m: string) => void }) {
  const [mode, setMode] = useState<"ingest" | "upload" | "search">("ingest");

  // text ingest
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [jurisdiction, setJurisdiction] = useState("");
  const [docType, setDocType] = useState("contract");
  const [manualPracticeArea, setManualPracticeArea] = useState("");
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState<IngestResult | null>(null);

  // file upload
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploadResult, setUploadResult] = useState<IngestResult | null>(null);
  const [uploading, setUploading] = useState(false);

  // search
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  async function ingest() {
    setBusy(true);
    setLastResult(null);
    try {
      const result = await api.ingestDocument({ title, content, jurisdiction, documentType: docType, practiceArea: manualPracticeArea || undefined });
      setLastResult(result);
      notify("Document ingested into the registry");
      setTitle(""); setContent(""); setManualPracticeArea("");
    } catch (e) { notify((e as Error).message); }
    finally { setBusy(false); }
  }

  async function upload(file: File) {
    setUploading(true);
    setUploadResult(null);
    try {
      const result = await api.uploadDocument(file);
      setUploadResult(result);
      notify(`"${result.title}" ingested`);
    } catch (e) { notify((e as Error).message); }
    finally { setUploading(false); }
  }

  async function search() {
    setSearching(true);
    try { setResults(await api.searchDocuments(query)); }
    catch (e) { notify((e as Error).message); }
    finally { setSearching(false); }
  }

  return (
    <div className="modal-scrim" onClick={onClose}>
      <motion.div className="modal" style={{ maxWidth: 680 }} onClick={(e) => e.stopPropagation()}
        initial={{ opacity: 0, y: 18, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: "spring", stiffness: 320, damping: 28 }}>
        <div className="modal-head">
          <h3>The library</h3>
          <p>Ingest documents into the Qdrant knowledge registry, or search them semantically.</p>
        </div>

        <div className="tabs" style={{ margin: "16px 26px 0" }}>
          <button className={`tab ${mode === "ingest" ? "active" : ""}`} onClick={() => setMode("ingest")}>
            Paste text{mode === "ingest" && <motion.span layoutId="lib-underline" className="tab-underline" />}
          </button>
          <button className={`tab ${mode === "upload" ? "active" : ""}`} onClick={() => setMode("upload")}>
            Upload file{mode === "upload" && <motion.span layoutId="lib-underline" className="tab-underline" />}
          </button>
          <button className={`tab ${mode === "search" ? "active" : ""}`} onClick={() => setMode("search")}>
            Search{mode === "search" && <motion.span layoutId="lib-underline" className="tab-underline" />}
          </button>
        </div>

        {mode === "ingest" && (
          <div className="modal-body">
            <div className="field">
              <label>Title</label>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Master Services Agreement — Acme / Beta" />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14 }}>
              <div className="field">
                <label>Jurisdiction</label>
                <input value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value)} placeholder="e.g. England & Wales" />
              </div>
              <div className="field">
                <label>Document type</label>
                <input value={docType} onChange={(e) => setDocType(e.target.value)} placeholder="contract" />
              </div>
              <div className="field">
                <label>Practice area <span style={{ fontWeight: 400, color: "var(--text-faint)" }}>(or auto-detect)</span></label>
                <select value={manualPracticeArea} onChange={(e) => setManualPracticeArea(e.target.value)}>
                  <option value="">Auto-detect</option>
                  {PRACTICE_AREAS.map((pa) => <option key={pa} value={pa}>{pa}</option>)}
                </select>
              </div>
            </div>
            <div className="field">
              <label>Content</label>
              <textarea style={{ minHeight: 150 }} value={content} onChange={(e) => setContent(e.target.value)}
                placeholder="Paste the full text of the document…" />
            </div>
            <IngestResultBanner result={lastResult} />
          </div>
        )}

        {mode === "upload" && (
          <div className="modal-body">
            <input ref={fileRef} type="file" accept=".pdf,.txt,.md,.csv,.json,.log,.rtf" style={{ display: "none" }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ""; }} />
            <div
              style={{
                border: "2px dashed var(--border)", borderRadius: 12, padding: "48px 32px",
                textAlign: "center", cursor: "pointer", color: "var(--text-dim)", fontSize: 14,
              }}
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) upload(f); }}>
              {uploading ? (
                <span>Processing…</span>
              ) : (
                <>
                  <div style={{ fontSize: 32, marginBottom: 10 }}>⊕</div>
                  <div>Click to select or drag &amp; drop a file</div>
                  <div style={{ fontSize: 12, marginTop: 6, color: "var(--text-faint)" }}>PDF, TXT, MD, CSV, JSON up to 25 MB</div>
                </>
              )}
            </div>
            <IngestResultBanner result={uploadResult} />
          </div>
        )}

        {mode === "search" && (
          <div className="modal-body">
            <div className="field">
              <label>Semantic query</label>
              <div style={{ display: "flex", gap: 8 }}>
                <input value={query} onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && search()}
                  placeholder="e.g. exclusivity obligations under Article 101" />
                <button className="btn" disabled={searching || !query} onClick={search}>{searching ? "…" : "Search"}</button>
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10, maxHeight: 300, overflowY: "auto" }}>
              {results.map((r) => (
                <div key={r.document.id} className="grid-wrap" style={{ padding: "12px 14px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start" }}>
                    <strong style={{ fontSize: 13.5 }}>{r.document.title}</strong>
                    <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                      {r.document.practiceArea && <span className="pill sm blue">{r.document.practiceArea}</span>}
                      <span className="pill blue">{(r.score * 100).toFixed(0)}%</span>
                    </div>
                  </div>
                  <div style={{ color: "var(--text-dim)", fontSize: 12.5, marginTop: 6, lineHeight: 1.5 }}>{r.excerpt}</div>
                  <div className="grid-meta" style={{ marginTop: 6 }}>{r.document.id}</div>
                </div>
              ))}
              {!results.length && !searching && <div className="placeholder" style={{ padding: 24 }}>No results yet.</div>}
            </div>
          </div>
        )}

        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>Close</button>
          {mode === "ingest" && (
            <button className="btn primary" disabled={busy || title.trim().length < 3 || content.trim().length < 20} onClick={ingest}>
              {busy ? "Ingesting…" : "⊕ Ingest document"}
            </button>
          )}
        </div>
      </motion.div>
    </div>
  );
}

function IngestResultBanner({ result }: { result: IngestResult | null }) {
  if (!result) return null;
  return (
    <AnimatePresence>
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
        style={{ background: "var(--surface-2)", borderRadius: 8, padding: "12px 14px", marginTop: 12 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: result.practiceArea || result.detectedClient || result.suggestedLawyers?.length ? 8 : 0 }}>
          <span style={{ fontSize: 12, color: "var(--text-faint)" }}>Ingested:</span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--green)" }}>{result.id}</span>
        </div>
        {result.practiceArea && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
            <span style={{ fontSize: 12, color: "var(--text-faint)" }}>Practice area:</span>
            <span className="pill sm blue">{result.practiceArea}</span>
          </div>
        )}
        {result.detectedClient && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
            <span style={{ fontSize: 12, color: "var(--text-faint)" }}>Detected client:</span>
            <span className="pill sm gold">{result.detectedClient.clientName} ({result.detectedClient.clientNumber})</span>
          </div>
        )}
        {result.suggestedLawyers && result.suggestedLawyers.length > 0 && (
          <div>
            <span style={{ fontSize: 12, color: "var(--text-faint)" }}>Suggested lawyers:</span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }}>
              {result.suggestedLawyers.map((l) => (
                <span key={l.id} className="pill sm">{l.name}</span>
              ))}
            </div>
          </div>
        )}
      </motion.div>
    </AnimatePresence>
  );
}
