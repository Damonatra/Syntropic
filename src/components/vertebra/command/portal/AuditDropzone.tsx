/**
 * Audit dropzone / ingestion tile — tactile intake for legacy quote PDFs and
 * cost sheets, demonstrating the production chain: Docling OCR parse →
 * line-item extraction → hybrid BM25 × dense retrieval (RRF, k=60) → Qdrant
 * upsert → sealed audit brief. The run is a client-side demonstration of the
 * same stage contract the ingest API executes.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Chip, HudMeta, SectionLabel } from "../bits";

interface QueuedFile {
  id: string;
  name: string;
  size: number;
}

const STAGES: Array<{ key: string; label: string; detail: string; ms: number }> = [
  { key: "ingest", label: "INGEST", detail: "MIME verify · SHA-256 checksum · page raster", ms: 520 },
  { key: "ocr", label: "DOCLING OCR", detail: "layout model · table structure · header/footer strip", ms: 940 },
  { key: "lines", label: "LINE-ITEM EXTRACTION", detail: "SKU · UOM · qty · price · SPA reference", ms: 680 },
  { key: "rrf", label: "HYBRID RETRIEVAL", detail: "BM25 × dense embeddings · RRF fusion k=60", ms: 760 },
  { key: "qdrant", label: "QDRANT UPSERT", detail: "vector index commit · payload filters", ms: 520 },
  { key: "brief", label: "AUDIT BRIEF", detail: "anomaly ledger sealed · margin delta per line", ms: 380 },
];

function derivedMetrics(totalBytes: number) {
  const pages = Math.max(2, Math.round(totalBytes / 48_000));
  const lineItems = pages * 24 + (pages % 7) * 3;
  const spaRefs = Math.max(1, Math.round(pages / 6));
  const anomalies = Math.max(1, Math.round(pages / 9));
  const flaggedUsd = anomalies * 7_400 + pages * 310;
  return { pages, lineItems, spaRefs, anomalies, flaggedUsd };
}

export function AuditDropzone() {
  const [files, setFiles] = useState<QueuedFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const [stageIdx, setStageIdx] = useState(-1); // -1 idle, 0..n-1 running, n done
  const [progress, setProgress] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);

  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  const done = stageIdx >= STAGES.length;

  const reset = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setStageIdx(-1);
    setProgress(0);
    setFiles([]);
  }, []);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const runPipeline = useCallback(
    (bytes: number) => {
      timers.current.forEach(clearTimeout);
      timers.current = [];
      setStageIdx(0);
      setProgress(0);
      let elapsed = 0;
      const total = STAGES.reduce((s, st) => s + st.ms, 0);
      STAGES.forEach((stage, i) => {
        elapsed += stage.ms;
        const at = elapsed;
        timers.current.push(
          setTimeout(() => {
            setStageIdx(i + 1);
            setProgress(Math.min(100, Math.round((at / total) * 100)));
          }, at),
        );
      });
      void bytes;
    },
    [],
  );

  const accept = useCallback(
    (list: FileList | null) => {
      if (!list || list.length === 0) return;
      const next: QueuedFile[] = Array.from(list).map((f, i) => ({
        id: `${Date.now()}-${i}-${f.name}`,
        name: f.name,
        size: f.size,
      }));
      setFiles((prev) => {
        const merged = [...prev, ...next];
        runPipeline(merged.reduce((s, f) => s + f.size, 0));
        return merged;
      });
    },
    [runPipeline],
  );

  const metrics = derivedMetrics(totalBytes);
  const currentStage = stageIdx >= 0 && stageIdx < STAGES.length ? STAGES[stageIdx] : null;

  return (
    <div className="neu-lg flex flex-col rounded-[28px] px-7 py-6">
      <div className="flex items-center justify-between">
        <SectionLabel>Audit dropzone — legacy intake</SectionLabel>
        <HudMeta node="AST-08" hash="c21e" />
      </div>

      {/* drop surface */}
      <div
        role="button"
        tabIndex={0}
        aria-label="Upload legacy quote PDFs and cost sheets"
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            inputRef.current?.click();
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
          accept(e.dataTransfer.files);
        }}
        className={`mt-4 flex min-h-[150px] cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-8 text-center transition-all ${
          dragging ? "border-[#08080A] bg-white shadow-[inset_3px_3px_10px_rgba(0,0,0,0.07)]" : "border-black/15 bg-[#F0F1F3]"
        }`}
      >
        <span className="flex size-11 items-center justify-center rounded-full bg-[#08080A] text-[17px] text-white shadow-[4px_4px_10px_rgba(0,0,0,0.2)]">↑</span>
        <p className="mt-3 font-display text-[15.5px] font-semibold tracking-[-0.02em] text-[#08080A]">Drop legacy quote PDFs, cost sheets, SPA addenda</p>
        <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.14em] text-[#8A8F97]">or click to browse · pdf · csv · xlsx · ≤ 40 mb each</p>
      </div>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".pdf,.csv,.xlsx,.xls"
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
            <Chip key={f.id} tone="raised" className="max-w-[240px]">
              <span className="truncate normal-case">{f.name}</span>
              <span className="text-[#8A8F97]">{Math.max(1, Math.round(f.size / 1024))}kb</span>
            </Chip>
          ))}
        </div>
      )}

      {/* pipeline */}
      {stageIdx >= 0 && (
        <div className="mt-4">
          <div className="flex items-center justify-between">
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#5F646D]">
              {done ? "audit brief ready — anomaly ledger sealed" : currentStage ? `${currentStage.label} — ${currentStage.detail}` : ""}
            </p>
            <p className="font-mono text-[10px] tabular-nums text-[#08080A]">{progress}%</p>
          </div>
          <div className="mt-2 h-[5px] w-full overflow-hidden rounded-full bg-[#E4E6EA] shadow-[inset_1px_1px_3px_rgba(0,0,0,0.05)]">
            <div className="h-full rounded-full bg-[#08080A] transition-all duration-500" style={{ width: `${progress}%` }} />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-1.5 sm:grid-cols-3 xl:grid-cols-6">
            {STAGES.map((st, i) => {
              const state = i < stageIdx ? "done" : i === stageIdx ? "run" : "wait";
              return (
                <div
                  key={st.key}
                  className={`rounded-xl px-2.5 py-2 font-mono text-[9px] uppercase tracking-[0.1em] transition-all ${
                    state === "done"
                      ? "bg-[#08080A] text-white"
                      : state === "run"
                        ? "bg-white text-[#08080A] shadow-[3px_3px_8px_rgba(0,0,0,0.08),-3px_-3px_8px_rgba(255,255,255,0.95)]"
                        : "text-[#A6ABB2]"
                  }`}
                >
                  {state === "done" ? "✓ " : ""}
                  {st.label}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* extracted readout */}
      {done && (
        <div className="ink cc-rise mt-4 rounded-2xl px-5 py-4">
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
            {(
              [
                ["pages parsed", metrics.pages],
                ["line items", metrics.lineItems],
                ["spa refs found", metrics.spaRefs],
                ["anomalies flagged", metrics.anomalies],
              ] as Array<[string, number]>
            ).map(([k, v]) => (
              <div key={k}>
                <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-white/45">{k}</p>
                <p className="mt-1 font-display text-[21px] font-semibold tracking-[-0.03em] tabular-nums text-white">{v.toLocaleString("en-US")}</p>
              </div>
            ))}
          </div>
          <p className="mt-3 border-t border-white/10 pt-2.5 font-mono text-[10px] tabular-nums text-white/55">
            flagged exposure across anomalies ≈ ${metrics.flaggedUsd.toLocaleString("en-US")}/yr · brief queued to Pipeline
          </p>
        </div>
      )}

      <div className="mt-4 flex items-center justify-between">
        <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-[#A6ABB2]">client-side demo of the production ingestion chain</p>
        {files.length > 0 && (
          <button onClick={reset} className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#5F646D] transition-colors hover:text-[#08080A]">
            Reset
          </button>
        )}
      </div>
    </div>
  );
}
