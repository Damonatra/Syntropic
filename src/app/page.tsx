"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Nav } from "@/components/vertebra/nav";
import { Hero } from "@/components/vertebra/hero";
import { PipelineTable } from "@/components/vertebra/pipeline-table";
import { ScoringSection } from "@/components/vertebra/scoring-section";
import { DispatchSection } from "@/components/vertebra/dispatch-section";
import { AddProspectDialog } from "@/components/vertebra/add-prospect-dialog";
import type { OutboxEventRow, ProspectRow, Stats } from "@/lib/vertebra/types";

export default function Page() {
  const [prospects, setProspects] = useState<ProspectRow[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [outbox, setOutbox] = useState<OutboxEventRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pipelineBusy, setPipelineBusy] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const [prospectsRes, statsRes, outboxRes] = await Promise.all([
        fetch("/api/prospects", { cache: "no-store" }),
        fetch("/api/stats", { cache: "no-store" }),
        fetch("/api/outbox?limit=30", { cache: "no-store" }),
      ]);
      if (prospectsRes.ok) {
        const data = await prospectsRes.json();
        setProspects(data.prospects ?? []);
      }
      if (statsRes.ok) setStats(await statsRes.json());
      if (outboxRes.ok) {
        const data = await outboxRes.json();
        setOutbox(data.events ?? []);
      }
    } catch (error) {
      console.error("load failed", error);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = useMemo(
    () => prospects.find((prospect) => prospect.id === selectedId) ?? null,
    [prospects, selectedId],
  );

  const scoreTrend = useMemo(
    () =>
      prospects
        .filter((prospect) => prospect.score)
        .slice(0, 12)
        .reverse()
        .map((prospect) => prospect.score!.qlvScore),
    [prospects],
  );

  const scoreProspect = useCallback(
    async (prospect: ProspectRow, silent = false): Promise<boolean> => {
      setBusyId(prospect.id);
      try {
        const response = await fetch("/api/score", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prospectId: prospect.id }),
        });
        const data = await response.json();
        if (!response.ok) {
          if (!silent) toast.error(`Scoring failed: ${data.error ?? response.status}`);
          return false;
        }
        if (!silent) {
          toast.success(`${prospect.name} scored ${data.qlvScore}/100 (${data.band})`, {
            description: data.model === "vertebra-rubric-1.0" ? "Rubric fallback — LLM unavailable." : `Model: ${data.model}`,
          });
        }
        return true;
      } catch (error) {
        if (!silent) toast.error(error instanceof Error ? error.message : "Network error");
        return false;
      } finally {
        setBusyId(null);
      }
    },
    [],
  );

  const dispatchProspect = useCallback(
    async (prospect: ProspectRow) => {
      setBusyId(prospect.id);
      try {
        const response = await fetch("/api/dispatch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prospectId: prospect.id }),
        });
        const data = await response.json();
        if (!response.ok) {
          toast.error(`Dispatch failed: ${data.error ?? response.status}`);
          return;
        }
        if (data.channel === "channel_a_automated_email") {
          toast.success(`${prospect.name} routed to Channel A`, {
            description:
              data.status === "sent"
                ? `Sent from ${data.fromDomain}${data.caslScope ? " · CASL kit applied" : ""}.`
                : data.reasons?.[data.reasons.length - 1] ?? "Queued for the engine worker.",
          });
        } else {
          toast.success(`${prospect.name} routed to Channel B`, {
            description: "Josias high-touch queue — export CSV or schedule the follow-up.",
          });
        }
        await load();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Network error");
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  const scorePipeline = useCallback(async () => {
    const pending = prospects.filter(
      (prospect) => prospect.ingestion !== "filtered" && !prospect.score,
    );
    if (pending.length === 0) {
      toast.info("Every eligible prospect already has a score.");
      return;
    }
    setPipelineBusy(true);
    toast.info(`Scoring ${pending.length} prospect${pending.length === 1 ? "" : "s"}…`);
    let succeeded = 0;
    for (const prospect of pending) {
      const ok = await scoreProspect(prospect, true);
      if (ok) succeeded += 1;
      await load();
    }
    setPipelineBusy(false);
    toast.success(`Pipeline scored — ${succeeded}/${pending.length} prospects rated.`);
  }, [prospects, scoreProspect, load]);

  const exportCsv = useCallback(async () => {
    try {
      const response = await fetch("/api/dispatch/export", { cache: "no-store" });
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        const data = await response.json();
        toast.info(data.message ?? "No pending high-touch rows to export.");
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = response.headers.get("content-disposition")?.match(/filename="(.+)"/)?.[1] ?? "josias-high-touch.csv";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      toast.success("Josias high-touch CSV exported and marked as worked.");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Export failed");
    }
  }, [load]);

  return (
    <div className="flex min-h-screen flex-col bg-white">
      <Nav onAddProspect={() => setDialogOpen(true)} />

      <main className="flex-1">
        <Hero
          stats={stats}
          scoreTrend={scoreTrend}
          onScorePipeline={scorePipeline}
          onExportCsv={exportCsv}
        />

        {/* Pipeline ------------------------------------------------------- */}
        <section id="pipeline" className="scroll-mt-20 bg-[#fafafb] py-20 sm:py-24">
          <div className="mx-auto max-w-[1200px] px-5 sm:px-8">
            <div className="flex flex-wrap items-end justify-between gap-6">
              <div className="max-w-[560px]">
                <p className="tag mb-4 uppercase">Ingestion corridor</p>
                <h2 className="heading text-[#17191c]">
                  Every distributor inside the <span className="italic-accent">$10M–$150M</span> gate.
                </h2>
                <p className="subhead mt-4">
                  PVF, Electrical, HVAC and Fluid Power only. Records outside the
                  corridor are filtered with a reason — nothing ambiguous ships.
                </p>
              </div>
              <div className="flex items-center gap-4">
                <span className="meta">
                  {stats?.prospects?.ingested ?? 0} ingested ·{" "}
                  {stats?.prospects?.pending ?? 0} pending ·{" "}
                  {stats?.outboxPending ?? 0} outbox events
                </span>
                <button className="pill pill-ghost !h-10 text-[14px]" onClick={() => setDialogOpen(true)}>
                  Add prospect
                </button>
              </div>
            </div>

            <div className="mt-10">
              <PipelineTable
                prospects={prospects}
                busyId={busyId ?? (pipelineBusy ? "__pipeline__" : null)}
                selectedId={selectedId}
                onSelect={(prospect) => setSelectedId(prospect.id)}
                onScore={(prospect) => void scoreProspect(prospect)}
                onDispatch={(prospect) => void dispatchProspect(prospect)}
              />
            </div>
          </div>
        </section>

        <ScoringSection selected={selected} />

        <DispatchSection prospects={prospects} outbox={outbox} onExportCsv={exportCsv} />

        {/* Editorial ink accent — the page's single dark card */}
        <section className="mx-auto max-w-[1200px] px-5 py-20 sm:px-8 sm:py-24">
          <div className="ink-card flex flex-col items-start justify-between gap-8 p-8 sm:p-12 lg:flex-row lg:items-center">
            <div className="max-w-[640px]">
              <h3 className="font-display text-[clamp(26px,3.4vw,40px)] leading-[1.2] tracking-[-0.015em]">
                Forty enterprise clients by the end of Q4.
              </h3>
              <p className="mt-4 max-w-[520px] text-[16px] leading-relaxed text-[#a3a6af]">
                Vertebra fills the corridor from six directories, scores the leakage,
                and never lets a warm account sit in a spreadsheet again.
              </p>
            </div>
            <button
              className="pill bg-white text-[#17191c] hover:opacity-90"
              onClick={() => document.getElementById("pipeline")?.scrollIntoView({ behavior: "smooth" })}
            >
              Work the pipeline →
            </button>
          </div>
        </section>
      </main>

      <footer className="mt-auto border-t border-[#ececec] bg-white">
        <div className="mx-auto flex max-w-[1200px] flex-col items-start justify-between gap-4 px-5 py-8 sm:flex-row sm:items-center sm:px-8">
          <p className="font-display text-[18px] text-[#17191c]">vertebra</p>
          <p className="meta">
            Syntropic Engine LLC · CASL &amp; CAN-SPAM compliant dispatch · Neon Postgres + Qdrant + Claude
          </p>
        </div>
      </footer>

      <AddProspectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onIngested={(result) => {
          if (result.status === "error") toast.error(result.message);
          else if (result.status === "filtered") toast.info(result.message);
          else toast.success(result.message);
          void load();
        }}
      />
    </div>
  );
}
