/**
 * Sourcing panel — the reveal queue's console face.
 *
 * One spoke, made visible: run a batch (staging fixtures while no key sits
 * on disk, live Apollo search once armed), read the fit math per candidate,
 * and move money only above the bar. The fit bar is luminance-only — zero
 * color law — and every refusal from the door lands on the row it belongs
 * to, named, not swallowed. Below-bar rows stay visible on purpose: an
 * operator should see what the enclave refused to spend on, and why.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { Chip, SectionLabel, SoftCard } from "./bits";

interface FitFactor {
  key: string;
  weight: number;
  points: number;
  evidence: string;
}

interface QueueItem {
  candidateId: string;
  prospectId: string;
  person: string | null;
  title: string | null;
  organization: string | null;
  domain: string | null;
  location: string | null;
  fitScore: number;
  factors: FitFactor[];
  mode: string;
  batchId: string;
  stage: string;
  stageReason: string | null;
  attempts: number;
  revealEligible: boolean;
  bestEmail: string | null;
  revealedProvider: string | null;
  revealedAt: string | null;
}

interface QueuePayload {
  ok: boolean;
  staged: QueueItem[];
  revealed: QueueItem[];
  stats: { staged: number; revealed: number; dismissed: number; belowBar: number; eligible: number };
}

interface BatchOutcome {
  ok?: boolean;
  mode?: string;
  batchId?: string;
  staged?: number;
  skipped?: number;
  wireTotal?: number;
  gateNote?: string | null;
  reason?: string;
}

const FACTOR_LABEL: Record<string, string> = {
  vertical: "vertical",
  erp: "erp",
  size: "size",
  region: "region",
  title: "title",
};

function FitBar({ score }: { score: number }) {
  const opacity = score >= 85 ? 1 : score >= 70 ? 0.78 : score >= 40 ? 0.45 : 0.22;
  return (
    <div className="flex items-center gap-2" title={`pre-contact fit ${score}/100 — vertical · erp · size · region · title`}>
      <div className="h-1 w-16 overflow-hidden rounded-full bg-white/[0.08]">
        <div className="h-full rounded-full bg-[#F4F5F2]" style={{ width: `${Math.max(3, score)}%`, opacity }} />
      </div>
      <span className="font-mono text-[10.5px] tabular-nums text-[#C9CCC7]">{score}</span>
    </div>
  );
}

export function SourcingPanel() {
  const [data, setData] = useState<QueuePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [batch, setBatch] = useState<BatchOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState<"live" | "staging" | null>(null);
  const [openFactors, setOpenFactors] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/contacts/sourcing/queue", { cache: "no-store" });
      const j = (await res.json()) as QueuePayload;
      if (!res.ok || !j.ok) throw new Error("read failed");
      setData(j);
      setError(null);
    } catch {
      setError("queue read failed");
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  const runBatch = async (mode: "live" | "staging") => {
    setRunning(mode);
    setBusy(true);
    try {
      const res = await fetch("/api/contacts/sourcing/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }), // house ICP — the panel runs the default book
      });
      const j = (await res.json().catch(() => ({}))) as BatchOutcome;
      setBatch(j);
      if (!res.ok || !j.ok) setError(j.reason ?? `batch refused (${res.status})`);
      else setError(null);
      await load();
    } catch {
      setError("batch failed");
    } finally {
      setRunning(null);
      setBusy(false);
    }
  };

  const act = async (path: "reveal" | "dismiss", candidateId: string) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/contacts/sourcing/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(path === "dismiss" ? { candidateId, reason: "dismissed from the panel" } : { candidateId }),
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; reason?: string; status?: string; email?: string | null };
      if (path === "reveal" && res.ok && j.ok) setBatch({ ok: true, reason: undefined, staged: undefined, mode: `reveal ${j.status}`, batchId: j.email ?? "" });
      if (!res.ok) setError(j.reason ?? `action failed (${res.status})`);
      else setError(null);
      await load();
    } catch {
      setError("action failed");
    } finally {
      setBusy(false);
    }
  };

  const stats = data?.stats;

  return (
    <SoftCard className="mt-5 px-6 py-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <SectionLabel>Sourcing — the prospect spoke</SectionLabel>
          <p className="mt-1.5 max-w-3xl text-[12.5px] leading-relaxed text-[#8E9194]">
            Search costs nothing; reveal costs credits. A batch finds WHO to email, scores each hit on pre-contact fit (vertical · erp · size · region ·
            title), and stages it here — money moves only at or above the reveal bar of 70, and every refusal is named on its row. Staging batches run
            fixtures with .example.com domains until the Apollo key is armed; they queue and score honestly but never reveal.
          </p>
        </div>
        <div className="flex items-center gap-4">
          <button
            onClick={() => void runBatch("staging")}
            disabled={busy}
            title="run the fixture people through score + stage — for seeing the queue work before a key exists"
            className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-[#8E9194] transition-colors hover:text-[#F4F5F2]"
          >
            {running === "staging" ? "staging…" : "staging batch"}
          </button>
          <button
            onClick={() => void runBatch("live")}
            disabled={busy}
            title="live Apollo people search — needs the apollo row armed with its key on disk"
            className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-[#F4F5F2] transition-opacity hover:opacity-80"
          >
            {running === "live" ? "searching…" : "live batch"}
          </button>
        </div>
      </div>

      {error && <p className="mt-3 font-mono text-[10.5px] uppercase tracking-[0.14em] text-[#FF8A7A]">{error}</p>}

      {batch && (
        <div className="mt-4 rounded-lg border border-white/[0.08] bg-[#0E100E] px-4 py-3">
          <p className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-[#F4F5F2]">
            {batch.ok
              ? `${batch.mode} batch ${batch.batchId} — ${batch.staged} staged · ${batch.skipped} skipped (no organization) · wire total ${batch.wireTotal}`
              : `refused — ${batch.reason}`}
          </p>
          {batch.gateNote && <p className="mt-1 font-mono text-[10.5px] text-[#8E9194]">gate note: {batch.gateNote}</p>}
        </div>
      )}

      {stats && (
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-[10.5px] tabular-nums text-[#8E9194]">
          <span className="text-[#F4F5F2]">{stats.eligible} above the bar</span>
          <span>{stats.staged} staged</span>
          <span>{stats.belowBar} below bar</span>
          <span>{stats.revealed} revealed</span>
          <span>{stats.dismissed} dismissed</span>
        </div>
      )}

      <div className="mt-4 flex flex-col">
        {(data?.staged ?? []).length === 0 && (
          <p className="py-6 text-[12.5px] text-[#8E9194]">
            The queue is empty — run a staging batch to watch the rubric work, or a live batch once Apollo is armed. Silence here is one deliberate
            sentence, not confetti.
          </p>
        )}
        {(data?.staged ?? []).map((c) => (
          <div key={c.candidateId} className={`border-t border-white/[0.06] py-3.5 first:border-t-0 first:pt-0 ${c.revealEligible ? "" : "opacity-65"}`}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <p className="font-display text-[14px] font-semibold tracking-[-0.01em] text-[#F4F5F2]">
                {c.person ?? "unnamed"} <span className="font-normal text-[#8E9194]">· {c.organization ?? "unknown org"}</span>
              </p>
              {c.title && <Chip tone="outline">{c.title}</Chip>}
              <Chip tone={c.mode === "staging" ? "outline" : "raised"}>{c.mode === "staging" ? "fixture" : "live"}</Chip>
              <FitBar score={c.fitScore} />
              {!c.revealEligible && <Chip tone="well" className="normal-case tracking-normal">below bar {70}</Chip>}
              <div className="ml-auto flex items-center gap-3">
                <button
                  onClick={() => setOpenFactors(openFactors === c.candidateId ? null : c.candidateId)}
                  className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-[#8E9194] transition-colors hover:text-[#F4F5F2]"
                >
                  {openFactors === c.candidateId ? "hide math" : "math"}
                </button>
                {c.revealEligible && (
                  <button
                    onClick={() => void act("reveal", c.candidateId)}
                    disabled={busy}
                    title="spend a reveal credit — walks the resolver gate, ledger, and adapters"
                    className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-[#F4F5F2] transition-opacity hover:opacity-80"
                  >
                    reveal
                  </button>
                )}
                <button
                  onClick={() => void act("dismiss", c.candidateId)}
                  disabled={busy}
                  className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-[#8E9194] transition-colors hover:text-[#F4F5F2]"
                >
                  dismiss
                </button>
              </div>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10.5px] text-[#8E9194]">
              {c.domain && <span>{c.domain}</span>}
              {c.location && <span>{c.location}</span>}
              {c.attempts > 0 && <span>{c.attempts} reveal attempt{c.attempts === 1 ? "" : "s"}</span>}
              {c.stageReason && <span className="text-[#C9CCC7]">{c.stageReason}</span>}
            </div>
            {openFactors === c.candidateId && (
              <div className="mt-2 rounded-lg border border-white/[0.08] bg-[#0B0C0B] px-3 py-2.5">
                {c.factors.map((f) => (
                  <p key={f.key} className="font-mono text-[10.5px] leading-relaxed text-[#8E9194]">
                    <span className="text-[#C9CCC7]">{FACTOR_LABEL[f.key] ?? f.key}</span> · weight {f.weight} · points {f.points} — {f.evidence}
                  </p>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {(data?.revealed ?? []).length > 0 && (
        <div className="mt-5">
          <SectionLabel className="mb-2">Revealed — the record</SectionLabel>
          {(data?.revealed ?? []).map((c) => (
            <div key={c.candidateId} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-white/[0.06] py-2.5 first:border-t-0">
              <p className="font-display text-[13px] text-[#F4F5F2]">
                {c.person ?? "unnamed"} <span className="font-normal text-[#8E9194]">· {c.organization ?? ""}</span>
              </p>
              <FitBar score={c.fitScore} />
              <Chip tone="inverted">{c.revealedProvider ?? "resolved"}</Chip>
              {c.bestEmail && <p className="font-mono text-[10.5px] text-[#C9CCC7]">{c.bestEmail}</p>}
            </div>
          ))}
        </div>
      )}
    </SoftCard>
  );
}
