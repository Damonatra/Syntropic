/**
 * Audit dropzone / ingestion tile — obsidian intake for legacy quote PDFs and
 * cost sheets. Uploads go to /api/audit/parse for REAL server-side work:
 * SHA-256 digest, PDF flate-stream text extraction (or CSV row parse),
 * line-item + SPA-reference detection. Docling OCR / hybrid RRF / Qdrant
 * remain engine-side contract stages and are labelled as such — the console
 * never fabricates their output.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Chip, HudMeta, SectionLabel } from "../bits";

interface ParseResult {
  documentId: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  pages: number | null;
  lineItems: number;
  spaReferences: number;
  distinctSkus: number;
  extraction: "full_text" | "partial" | "header_only";
  note: string;
  sampleItems: Array<{ sku: string | null; qty: number | null; unitPrice: number | null }>;
}

interface QueuedFile {
  id: string;
  name: string;
  size: number;
  state: "pending" | "running" | "done" | "error";
  /** The raw File handle — not rendered. */
  __file?: File;
  result?: ParseResult;
  error?: string;
}

const REAL_STAGES = [
  { key: "ingest", label: "INGEST", detail: "MIME gate · SHA-256 digest · byte limit" },
  { key: "extract", label: "TEXT EXTRACTION", detail: "PDF flate inflate + text operators · CSV row parse" },
  { key: "lines", label: "LINE-ITEM DETECTION", detail: "sku · qty · unit-price shapes · SPA references" },
];
const ENGINE_STAGES = [
  { key: "ocr", label: "DOCLING OCR" },
  { key: "rrf", label: "RRF RETRIEVAL" },
  { key: "qdrant", label: "QDRANT UPSERT" },
];

/** Real upload progress via XHR — the percentage is bytes on the wire. */
function uploadFile(file: File, onProgress: (pct: number) => void): Promise<ParseResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/audit/parse");
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      const body = xhr.response as ParseResult & { error?: string };
      if (xhr.status >= 200 && xhr.status < 300 && body?.documentId) resolve(body);
      else reject(new Error(body?.error ?? `server_${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error("network_error"));
    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  });
}

export function AuditDropzone() {
  const [files, setFiles] = useState<QueuedFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = files.filter((f) => f.state === "done" && f.result).map((f) => f.result!);
  const last = results[results.length - 1] ?? null;
  const errorFile = files.find((f) => f.state === "error");

  useEffect(() => () => undefined, []);

  const processQueue = useCallback(async (queued: QueuedFile[]) => {
    setBusy(true);
    for (const q of queued) {
      const original = q.__file;
      if (!original) continue;
      setFiles((prev) => prev.map((f) => (f.id === q.id ? { ...f, state: "running" } : f)));
      setProgress(0);
      try {
        const result = await uploadFile(original, setProgress);
        setFiles((prev) => prev.map((f) => (f.id === q.id ? { ...f, state: "done", result } : f)));
      } catch (e) {
        setFiles((prev) =>
          prev.map((f) => (f.id === q.id ? { ...f, state: "error", error: String((e as Error).message) } : f)),
        );
      }
    }
    setBusy(false);
    setProgress(100);
  }, []);

  const accept = useCallback(
    (list: FileList | null) => {
      if (!list || list.length === 0) return;
      const accepted = Array.from(list).filter((f) => {
        const ok =
          f.type === "application/pdf" ||
          f.type.startsWith("text/") ||
          /\.(pdf|csv|txt|tsv)$/i.test(f.name);
        return ok && f.size > 0 && f.size <= 10 * 1024 * 1024;
      });
      if (accepted.length === 0) {
        setFiles((prev) => [
          ...prev,
          { id: `${Date.now()}-rejected`, name: "rejected: pdf / csv / txt only, ≤ 10 MB", size: 0, state: "error", error: "unsupported_file" },
        ]);
        return;
      }
      const next: QueuedFile[] = accepted.map((f, i) => ({
        id: `${Date.now()}-${i}-${f.name}`,
        name: f.name,
        size: f.size,
        state: "pending",
        __file: f,
      }));
      setFiles((prev) => [...prev, ...next]);
      void processQueue(next);
    },
    [processQueue],
  );

  const reset = useCallback(() => {
    if (busy) return;
    setFiles([]);
    setProgress(0);
  }, [busy]);

  const runningNow = busy || files.some((f) => f.state === "running");

  return (
    <div className="neu-lg flex flex-col rounded-lg px-7 py-6">
      <div className="flex items-center justify-between">
        <SectionLabel>Audit dropzone — legacy intake</SectionLabel>
        <HudMeta node="AST-08" hash="c21e" />
      </div>

      {/* drop surface */}
      <div
        role="button"
        tabIndex={0}
        aria-label="Upload legacy quote PDFs and cost sheets"
        onClick={() => !busy && inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (!busy) inputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (!busy) accept(e.dataTransfer.files);
        }}
        className={`mt-4 flex min-h-[150px] cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed px-6 py-8 text-center transition-all ${
          dragging ? "border-white/60 bg-[#1A1D1A]" : "border-white/20 bg-[#0E100E]"
        } ${busy ? "pointer-events-none opacity-70" : ""}`}
      >
        <span className="flex size-11 items-center justify-center rounded-full bg-[#F4F5F2] text-[17px] text-[#0B0C0B]">↑</span>
        <p className="mt-3 font-display text-[15.5px] font-semibold tracking-[-0.02em] text-[#F4F5F2]">
          Drop legacy quote PDFs, cost sheets, SPA addenda
        </p>
        <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.14em] text-[#6E736E]">
          or click to browse · pdf · csv · txt · ≤ 10 mb · parsed server-side
        </p>
      </div>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".pdf,.csv,.txt,.tsv"
        className="hidden"
        onChange={(e) => {
          accept(e.target.files);
          e.target.value = "";
        }}
      />

      {/* queued files */}
      {files.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {files.map((f) => (
            <Chip
              key={f.id}
              tone="raised"
              className={`max-w-[240px] ${f.state === "error" ? "text-[#FF8A7A]" : ""}`}
            >
              <span className="truncate normal-case">{f.name}</span>
              <span className="text-[#6E736E]">
                {f.state === "done" ? "✓" : f.state === "error" ? "✗" : f.state === "running" ? "…" : `${Math.max(1, Math.round(f.size / 1024))}kb`}
              </span>
            </Chip>
          ))}
        </div>
      )}

      {/* pipeline */}
      <div className="mt-4">
        <div className="flex items-center justify-between">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#8E9194]">
            {runningNow
              ? "parsing — real extraction on the enclave server"
              : last
                ? `parsed · ${last.extraction.replace(/_/g, " ")} · ${last.note.slice(0, 64)}`
                : "console stages run on upload · engine stages run in the vertebra engine"}
          </p>
          <p className="font-mono text-[10px] tabular-nums text-[#F4F5F2]">{runningNow || last ? `${progress}%` : ""}</p>
        </div>
        {(runningNow || last) && (
          <div className="mt-2 h-[5px] w-full overflow-hidden rounded-full bg-[#232623]">
            <div className="h-full rounded-full bg-[#F4F5F2] transition-all duration-300" style={{ width: `${progress}%` }} />
          </div>
        )}
        <div className="mt-3 grid grid-cols-2 gap-1.5 sm:grid-cols-3 xl:grid-cols-6">
          {REAL_STAGES.map((st) => {
            const done = last != null;
            const run = runningNow && !done;
            return (
              <div
                key={st.key}
                title={st.detail}
                className={`rounded-lg px-2.5 py-2 font-mono text-[9px] uppercase tracking-[0.1em] transition-all ${
                  done
                    ? "bg-[#F4F5F2] text-[#0B0C0B]"
                    : run
                      ? "border border-white/25 bg-[#222522] text-[#F4F5F2]"
                      : "border border-white/[0.06] text-[#5F6460]"
                }`}
              >
                {done ? "✓ " : ""}
                {st.label}
              </div>
            );
          })}
          {ENGINE_STAGES.map((st) => (
            <div
              key={st.key}
              title="engine-side stage — vertebra engine (Docling + Qdrant), not executed in the console"
              className="rounded-lg border border-dashed border-white/[0.09] px-2.5 py-2 font-mono text-[9px] uppercase tracking-[0.1em] text-[#5F6460]"
            >
              {st.label} <span className="text-[#8E9194]">·engine</span>
            </div>
          ))}
        </div>
      </div>

      {/* real extracted readout */}
      {last && (
        <div className="ink cc-rise mt-4 rounded-lg px-5 py-4">
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
            {(
              [
                ["pages detected", last.pages],
                ["line items", last.lineItems],
                ["spa references", last.spaReferences],
                ["distinct skus", last.distinctSkus],
              ] as Array<[string, number | null]>
            ).map(([k, v]) => (
              <div key={k}>
                <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-white/65">{k}</p>
                <p className="mt-1 font-display text-[21px] font-semibold tracking-[-0.03em] tabular-nums text-white">
                  {v == null ? "—" : v.toLocaleString("en-US")}
                </p>
              </div>
            ))}
          </div>
          <p className="mt-3 border-t border-white/20 pt-2.5 font-mono text-[10px] tabular-nums text-white/75">
            sha-256 {last.sha256} · {(last.sizeBytes / 1024).toFixed(1)} kb · document {last.documentId.slice(0, 10)} sealed to the audit ledger
          </p>
          {last.sampleItems.length > 0 && (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {last.sampleItems.slice(0, 4).map((it, i) => (
                <Chip key={i} tone="sunken" className="normal-case">
                  {it.sku ?? "item"} · {it.unitPrice != null ? `$${it.unitPrice.toFixed(2)}` : "price n/a"}
                  {it.qty != null ? ` × ${it.qty}` : ""}
                </Chip>
              ))}
            </div>
          )}
        </div>
      )}

      {errorFile && (
        <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.12em] text-[#FF8A7A]">
          {errorFile.error === "unsupported_file" || errorFile.error === "unsupported_mime"
            ? "unsupported file — pdf, csv or txt only, ≤ 10 mb"
            : `parse failed: ${errorFile.error ?? "unknown"}`}
        </p>
      )}

      <div className="mt-4 flex items-center justify-between">
        <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-[#5F6460]">
          real parse on the enclave · docling ocr + qdrant run engine-side
        </p>
        {files.length > 0 && (
          <button
            onClick={reset}
            disabled={busy}
            className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#8E9194] transition-colors hover:text-[#F4F5F2] disabled:opacity-40"
          >
            Reset
          </button>
        )}
      </div>
    </div>
  );
}
