/** PIPELINE — machine state: funnel, sequence health, tiered triage board. */
"use client";

import { useState } from "react";
import { Chip, EmptyHint, SectionLabel, SoftCard } from "./bits";
import { INTENT_LABELS, money, relTime, type CommandSnapshot, type ReplyIntent, type TriageItem } from "@/lib/vertebra/command";

export function PipelineView({
  snap,
  now,
  onOpenDossierId,
  onTriage,
}: {
  snap: CommandSnapshot;
  now: number;
  onOpenDossierId: (prospectId: string) => void;
  onTriage: (draftId: string, decision: "approved" | "discarded") => void;
}) {
  const [tab, setTab] = useState<"triage" | "sequences">("triage");
  const maxCount = Math.max(1, ...snap.funnel.map((f) => f.count));

  return (
    <div className="flex h-full flex-col overflow-y-auto cc-scroll p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <SectionLabel>Pipeline — the machine, zoomed out</SectionLabel>
          <p className="mt-2 font-serif text-[22px] tracking-[-0.01em] text-[#f2f2f4]">
            {snap.leads.length} leads in the corridor · {money(snap.funnel[0]?.leakageUsd ?? 0)} total leakage exposed
          </p>
        </div>
        <div className="flex gap-2">
          {(
            [
              ["triage", `Triage · ${snap.triage.pending.length}`],
              ["sequences", "Sequences"],
            ] as Array<["triage" | "sequences", string]>
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`h-8 rounded-xl px-3.5 font-mono text-[10.5px] uppercase tracking-[0.12em] transition-colors ${
                tab === key ? "bg-[#fafafa] text-[#0a0a0b]" : "border border-[#232327] text-[#8b8b93] hover:text-[#d6d6db]"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Funnel */}
      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7">
        {snap.funnel.map((stage) => (
          <SoftCard key={stage.stage} className="px-4 py-3.5">
            <p className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-[#5c5c64]">{stage.label}</p>
            <p className="mt-1.5 font-mono text-[24px] font-medium leading-none tabular-nums text-[#e4e4e8]">{stage.count}</p>
            <div className="mt-2.5 h-[3px] w-full overflow-hidden rounded-full bg-[#1c1c1f]">
              <div className="h-full rounded-full bg-[#9a9aa2]" style={{ width: `${Math.max(6, (stage.count / maxCount) * 100)}%` }} />
            </div>
            <p className="mt-2 font-mono text-[10.5px] tabular-nums text-[#6b6b72]">{money(stage.leakageUsd)} exposed</p>
          </SoftCard>
        ))}
      </div>

      {tab === "triage" ? (
        <div className="mt-5 grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          {/* Tier 2 — human gate */}
          <section className="flex min-w-0 flex-col gap-3">
            <div className="flex items-center justify-between">
              <SectionLabel>Drafts pending review — tier 2 · human gate</SectionLabel>
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#3f3f46]">a = approve top</span>
            </div>
            {snap.triage.pending.length === 0 && <EmptyHint>Agent queue clear — every judgment call is yours</EmptyHint>}
            {snap.triage.pending.map((item) => (
              <TriageCard key={item.replyId} item={item} now={now} onOpenDossierId={onOpenDossierId} onTriage={onTriage} />
            ))}
          </section>

          {/* Tier 1 — auto-resolved */}
          <section className="flex min-w-0 flex-col gap-3">
            <SectionLabel>Auto-resolved — tier 1 autonomy</SectionLabel>
            {snap.triage.auto.length === 0 && <EmptyHint>No autonomous resolutions yet</EmptyHint>}
            {snap.triage.auto.map((item) => (
              <SoftCard key={item.replyId} className="cc-rise px-5 py-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-[13.5px] font-medium text-[#d6d6db]">{item.prospectName}</p>
                    <p className="mt-0.5 font-mono text-[10.5px] uppercase tracking-[0.1em] text-[#6b6b72]">
                      {INTENT_LABELS[item.intent]} · {item.draftStatus?.replace(/_/g, " ") ?? "no draft"}
                    </p>
                  </div>
                  <span className="shrink-0 font-mono text-[10px] tabular-nums text-[#5c5c64]">{relTime(item.receivedAtMs, now)}</span>
                </div>
                {item.rescheduledToMs && (
                  <p className="mt-1.5 font-mono text-[10.5px] text-[#8b8b93]">sequence pushed to {new Date(item.rescheduledToMs).toLocaleDateString()}</p>
                )}
              </SoftCard>
            ))}

            {snap.triage.closed.length > 0 && (
              <>
                <SectionLabel className="mt-2">Closed</SectionLabel>
                {snap.triage.closed.map((item) => (
                  <SoftCard key={item.replyId} className="px-5 py-3 opacity-60">
                    <p className="truncate text-[12.5px] text-[#8b8b93]">
                      {item.prospectName} · {item.draftStatus?.replace(/_/g, " ")}
                    </p>
                  </SoftCard>
                ))}
              </>
            )}
          </section>
        </div>
      ) : (
        <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
          <SoftCard className="px-5 py-4">
            <SectionLabel className="mb-3">Channel A — automated sequences</SectionLabel>
            <div className="flex flex-col gap-2.5">
              {Object.entries(channelStatusCounts(snap)).map(([status, count]) => (
                <div key={status} className="flex items-center justify-between">
                  <Chip tone={status === "clicked" || status === "replied" ? "inverted" : "outline"}>{status}</Chip>
                  <span className="font-mono text-[13px] tabular-nums text-[#d6d6db]">{count}</span>
                </div>
              ))}
            </div>
            <p className="mt-4 border-t border-[#1e1e22] pt-3 text-[12px] leading-relaxed text-[#6b6b72]">
              {snap.ops.channelACount} sequence rows total · {snap.ops.dispatchesSent24h} touched in the last 24h. Outbox:{" "}
              {snap.ops.outboxPending} pending / {snap.ops.outboxPublished} published.
            </p>
          </SoftCard>
          <SoftCard className="px-5 py-4">
            <SectionLabel className="mb-3">Channel B — Josias high-touch queue</SectionLabel>
            <div className="flex flex-col gap-2.5">
              {snap.leads
                .filter((l) => l.highTouch)
                .sort((a, b) => (b.highTouch?.qlvScore ?? 0) - (a.highTouch?.qlvScore ?? 0))
                .map((l) => (
                  <button
                    key={l.id}
                    onClick={() => onOpenDossierId(l.id)}
                    className="flex items-center justify-between rounded-xl border border-[#1e1e22] px-4 py-2.5 text-left transition-colors hover:border-[#2e2e34]"
                  >
                    <span className="truncate text-[13px] text-[#d6d6db]">{l.name}</span>
                    <span className="font-mono text-[11px] tabular-nums text-[#8b8b93]">
                      QLV {l.highTouch?.qlvScore}
                      {l.highTouch?.exportedAtMs ? " · exported" : " · queued"}
                    </span>
                  </button>
                ))}
            </div>
          </SoftCard>
        </div>
      )}
    </div>
  );
}

function channelStatusCounts(snap: CommandSnapshot): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const lead of snap.leads) {
    if (!lead.dispatch) continue;
    counts[lead.dispatch.status] = (counts[lead.dispatch.status] ?? 0) + 1;
  }
  return counts;
}

function TriageCard({
  item,
  now,
  onOpenDossierId,
  onTriage,
}: {
  item: TriageItem;
  now: number;
  onOpenDossierId: (id: string) => void;
  onTriage: (draftId: string, decision: "approved" | "discarded") => void;
}) {
  return (
    <SoftCard className="cc-rise px-5 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => onOpenDossierId(item.prospectId)} className="text-[14.5px] font-medium text-[#f2f2f4] hover:underline">
              {item.prospectName}
            </button>
            <Chip tone="raised">{INTENT_LABELS[item.intent as ReplyIntent] ?? item.intent}</Chip>
            {item.qlvScore != null && <Chip tone="outline">QLV {item.qlvScore}</Chip>}
            {item.confidence != null && <Chip tone="outline">conf {Math.round(item.confidence * 100)}%</Chip>}
          </div>
          <p className="mt-1.5 truncate text-[12px] text-[#6b6b72]">
            {item.fromEmail} · {relTime(item.receivedAtMs, now)}
          </p>
        </div>
      </div>

      <div className="mt-3 rounded-xl border border-[#1e1e22] bg-[#0e0e10] px-4 py-3">
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#5c5c64]">inbound</p>
        <p className="mt-1 text-[13px] text-[#d6d6db]">{item.subject || "(no subject)"}</p>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-[#8b8b93]">{item.body}</p>
      </div>

      {item.draftBody && (
        <div className="mt-2.5 rounded-xl bg-[#1a1a1e] px-4 py-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#8b8b93]">agent draft — {item.draftSubject}</p>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-[#e4e4e8]">{item.draftBody}</p>
        </div>
      )}
      {item.rationale && <p className="mt-2 text-[11.5px] italic leading-relaxed text-[#5c5c64]">{item.rationale}</p>}

      <div className="mt-3.5 flex gap-2">
        <button
          onClick={() => item.draftId && onTriage(item.draftId, "approved")}
          disabled={!item.draftId}
          className="inline-flex h-9 items-center rounded-xl bg-[#fafafa] px-4 font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-[#0a0a0b] transition-opacity hover:opacity-85 disabled:opacity-40"
        >
          Approve &amp; send
        </button>
        <button
          onClick={() => item.draftId && onTriage(item.draftId, "discarded")}
          disabled={!item.draftId}
          className="inline-flex h-9 items-center rounded-xl border border-[#2a2a2f] px-4 font-mono text-[11px] uppercase tracking-[0.14em] text-[#8b8b93] transition-colors hover:bg-[#1a1a1e] disabled:opacity-40"
        >
          Discard
        </button>
      </div>
    </SoftCard>
  );
}
