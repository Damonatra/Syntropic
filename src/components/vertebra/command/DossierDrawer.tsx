/** Dossier drawer — full operator context before a call. Obsidian sheet, graphite threat matrix. */
"use client";

import { useEffect, useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Chip, ErpBadge, Kv, PillButton, ScoreBlock, SectionLabel, SoftCard, EmptyHint } from "./bits";
import { EVENT_LABELS, PORTAL_LABELS, annualLeakageUsd, money, relTime, verticalLabel, type CommandLead } from "@/lib/vertebra/command";
import { NET_MARGIN_ASSUMPTION, EXPOSURE_CEILING } from "@/lib/vertebra/command";

interface DossierData {
  prospect: {
    id: string;
    name: string;
    domain: string | null;
    vertical: string | null;
    city: string | null;
    stateProvince: string | null;
    country: string | null;
    revenueEstimateUsd: number | null;
    employeeCount: number | null;
    caslScope: boolean;
    bestEmail: string | null;
    emailPattern: string | null;
    detectedErp: string | null;
    quotePortalType: string | null;
    erpMetadata: string | null;
    latitude: number | null;
    longitude: number | null;
    lastIntentHeat: number;
    clusterName: string | null;
    score: { qlvScore: number; band: string; factors: Array<{ key: string; weight: number; points: number; evidence: string }>; hooks: Array<{ flavor: string; body: string }>; rationale: string; model: string } | null;
    contacts: Array<{ name: string; role: string; titleRaw: string | null; phone: string | null }>;
    highTouch: { qlvScore: number; exported: boolean } | null;
  };
  telemetry: Array<{ id: string; eventType: string; url: string | null; city: string | null; country: string | null; device: string | null; durationMs: number | null; occurredAtMs: number }>;
  dispatches: Array<{ id: string; channel: string; status: string; subject: string | null; provider: string | null; scheduledAtMs: number | null; createdAtMs: number }>;
  actions: Array<{ id: string; action: string; note: string | null; createdAtMs: number }>;
  replies: Array<{ id: string; intent: string; fromEmail: string; subject: string | null; body: string; receivedAtMs: number; draft: { id: string; status: string; subject: string; body: string } | null }>;
}

const FACTOR_LABELS: Record<string, string> = {
  rfq_latency: "RFQ latency",
  legacy_portal: "Legacy portal",
  unapplied_spa: "Unapplied SPAs",
  manual_quoting_share: "Manual quoting share",
  vertical_fit: "Vertical fit",
  size_fit: "Size fit",
};

function erpDoc(raw: string | null): { recommended_pitch_angle: string; job_signal_count: number; evidence?: { job_posts?: Array<{ board: string; title: string; keyword: string; posted_at: string }> } } | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function DossierDrawer({
  lead,
  open,
  onOpenChange,
  onAction,
}: {
  lead: CommandLead | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAction: (prospectId: string, action: "called" | "deferred" | "snoozed" | "booked", note?: string) => void;
}) {
  const [data, setData] = useState<DossierData | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !lead) return;
    setLoading(true);
    setData(null);
    fetch(`/api/dossier?id=${lead.id}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setData(d))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [open, lead]);

  const now = Date.now();
  const score = data?.prospect.score ?? (lead?.score ? { ...lead.score } : null);
  const leakage = data ? annualLeakageUsd(data.prospect.revenueEstimateUsd, score?.qlvScore ?? null) : lead?.leakageUsd ?? null;
  const erp = erpDoc(data?.prospect.erpMetadata ?? null);
  const phone = data?.prospect.contacts[0]?.phone ?? lead?.contact?.phone ?? null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="cc-scroll w-full overflow-y-auto border-l border-white/[0.10] bg-[#0B0C0B] p-0 sm:max-w-[560px]">
        {loading || !data ? (
          <div className="flex h-full flex-col items-center justify-center gap-3">
            <SheetHeader className="sr-only">
              <SheetTitle>Loading dossier</SheetTitle>
            </SheetHeader>
            <span className="size-2 rounded-full bg-[#F4F5F2] cc-pulse-dot" />
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-[#8E9194]">Loading dossier…</p>
          </div>
        ) : (
          <div className="flex flex-col gap-6 p-6 pb-8">
            <SheetHeader className="p-0">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <SheetTitle className="font-display text-[24px] font-semibold leading-tight tracking-[-0.03em] text-[#F4F5F2]">
                    {data.prospect.name}
                  </SheetTitle>
                  <p className="mt-1 font-mono text-[12px] text-[#8E9194]">
                    {data.prospect.domain ?? "domain unknown"} · {data.prospect.city ?? "—"}
                    {data.prospect.stateProvince ? `, ${data.prospect.stateProvince}` : ""} · {data.prospect.country ?? "—"}
                  </p>
                </div>
                <ScoreBlock score={score?.qlvScore ?? null} band={score?.band ?? null} size="lg" />
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Chip tone="well">{verticalLabel(data.prospect.vertical)}</Chip>
                {data.prospect.clusterName && <Chip>{data.prospect.clusterName}</Chip>}
                {data.prospect.highTouch && <Chip tone="inverted">High-touch · {data.prospect.highTouch.qlvScore}</Chip>}
                {data.prospect.caslScope && <Chip tone="outline">CASL</Chip>}
                <Chip tone="outline">heat {data.prospect.lastIntentHeat}</Chip>
              </div>
            </SheetHeader>

            {/* Identity */}
            <section>
              <SectionLabel className="mb-2">Identity &amp; access</SectionLabel>
              <SoftCard className="px-5 py-3">
                {data.prospect.contacts.map((c) => (
                  <Kv
                    key={c.name}
                    k={c.titleRaw ?? c.role}
                    v={
                      c.phone ? (
                        <a href={`tel:${c.phone.replace(/\s/g, "")}`} className="underline decoration-white/30 underline-offset-4 hover:text-white">
                          {c.phone}
                        </a>
                      ) : (
                        "direct line pending"
                      )
                    }
                  />
                ))}
                <Kv k="Email" v={data.prospect.bestEmail ?? "unverified"} mono={false} />
                <Kv k="Pattern" v={data.prospect.emailPattern ?? "—"} />
                <Kv k="Revenue" v={`${money(data.prospect.revenueEstimateUsd)} · ${data.prospect.employeeCount ?? "—"} empl`} />
              </SoftCard>
            </section>

            {/* Score decomposition */}
            {score && (
              <section>
                <SectionLabel className="mb-2">QLV decomposition · {score.model}</SectionLabel>
                <SoftCard className="px-5 py-4">
                  <div className="flex flex-col gap-3">
                    {score.factors.map((f) => (
                      <div key={f.key}>
                        <div className="flex items-baseline justify-between">
                          <span className="text-[13px] text-[#E9EBE7]">{FACTOR_LABELS[f.key] ?? f.key}</span>
                          <span className="font-mono text-[11px] tabular-nums text-[#8E9194]">
                            {Math.round(f.points)} × {f.weight.toFixed(2)}
                          </span>
                        </div>
                        <div className="mt-1.5 h-[3px] w-full overflow-hidden rounded-full bg-[#232623]">
                          <div className="h-full rounded-full bg-[#F4F5F2]" style={{ width: `${Math.min(100, f.points)}%` }} />
                        </div>
                        <p className="mt-1.5 text-[12px] leading-relaxed text-[#8E9194]">{f.evidence}</p>
                      </div>
                    ))}
                  </div>
                  <p className="mt-4 border-t border-white/[0.08] pt-3 text-[12.5px] leading-relaxed text-[#C9CCC7]">{score.rationale}</p>
                </SoftCard>
              </section>
            )}

            {/* ERP profile (Module 5) */}
            <section>
              <SectionLabel className="mb-2">ERP &amp; portal profile · Module 5</SectionLabel>
              <SoftCard className="px-5 py-4">
                {data.prospect.detectedErp && (
                  <div className="mb-3">
                    <ErpBadge erp={data.prospect.detectedErp} />
                  </div>
                )}
                <Kv k="Detected ERP" v={data.prospect.detectedErp ?? "unknown"} mono={false} />
                <Kv k="Quote portal" v={PORTAL_LABELS[data.prospect.quotePortalType ?? ""] ?? data.prospect.quotePortalType ?? "—"} mono={false} />
                <Kv k="Job signals" v={erp?.job_signal_count ?? 0} />
                {erp?.evidence?.job_posts && erp.evidence.job_posts.length > 0 && (
                  <div className="mt-2 flex flex-col gap-1.5 border-t border-white/[0.08] pt-3">
                    {erp.evidence.job_posts.map((j, i) => (
                      <p key={i} className="text-[12px] text-[#8E9194]">
                        <span className="text-[#E9EBE7]">{j.title}</span> — {j.board}, &ldquo;{j.keyword}&rdquo;
                      </p>
                    ))}
                  </div>
                )}
              </SoftCard>
            </section>

            {/* Pitch angle */}
            {erp?.recommended_pitch_angle && (
              <section>
                <SectionLabel className="mb-2">Recommended pitch angle</SectionLabel>
                <blockquote className="neu-well rounded-lg px-5 py-4">
                  <p className="font-display text-[15.5px] leading-relaxed tracking-[-0.01em] text-[#F4F5F2]">
                    &ldquo;{erp.recommended_pitch_angle}&rdquo;
                  </p>
                </blockquote>
              </section>
            )}

            {/* Quote Defense Threat Matrix (Module 6) — deep onyx */}
            <section>
              <SectionLabel className="mb-2">Quote defense threat matrix · Module 6</SectionLabel>
              <div className="ink rounded-lg px-5 py-5">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[9.5px] uppercase tracking-[0.2em] text-white/65">node // ast-06 · audit engine</span>
                  <span className="inline-flex items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-[0.14em] text-white/65">
                    <span className="size-1.5 rounded-full bg-[#F4F5F2] cc-pulse-dot" /> enclave: secure
                  </span>
                </div>
                <div className="mt-4 flex flex-col gap-0.5 border-b border-white/20 pb-4">
                  <Kv k="Revenue estimate" v={<span className="text-white/90">{money(data.prospect.revenueEstimateUsd)}</span>} />
                  <Kv k="Net margin (assumed)" v={<span className="text-white/90">{(NET_MARGIN_ASSUMPTION * 100).toFixed(0)}%</span>} />
                  <Kv k="Exposure curve" v={<span className="text-white/90">QLV/100 × {(EXPOSURE_CEILING * 100).toFixed(0)}%</span>} />
                </div>
                <div className="mt-4">
                  <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/70">Annual net-margin leakage</p>
                  <p className="mt-1.5 font-display text-[38px] font-semibold leading-none tracking-[-0.03em] tabular-nums text-white">
                    {leakage != null ? money(leakage) : "—"}
                  </p>
                  <p className="mt-2 font-mono text-[10.5px] text-white/65">confidence band ±15% · recovery floor backed at $10,000</p>
                </div>
                <p className="mt-4 border-t border-white/20 pt-3 text-[11.5px] leading-relaxed text-white/65">
                  Native widget render. In production dispatch the Playwright-rendered audit image attaches from CDN.
                </p>
              </div>
            </section>

            {/* Telemetry timeline */}
            <section>
              <SectionLabel className="mb-2">Telemetry · Module 8</SectionLabel>
              {data.telemetry.length === 0 ? (
                <EmptyHint>No telemetry captured</EmptyHint>
              ) : (
                <SoftCard className="px-5 py-3">
                  {data.telemetry.map((e) => (
                    <div key={e.id} className="flex items-baseline justify-between gap-4 py-2 not-last:border-b not-last:border-white/[0.07]">
                      <div className="min-w-0">
                        <p className="font-mono text-[11px] uppercase tracking-[0.1em] text-[#E9EBE7]">{EVENT_LABELS[e.eventType] ?? e.eventType}</p>
                        <p className="mt-0.5 truncate text-[11.5px] text-[#8E9194]">
                          {e.city ?? "—"}, {e.country ?? "—"} · {e.device ?? "—"}
                          {e.durationMs ? ` · ${Math.round(e.durationMs / 1000)}s` : ""}
                        </p>
                      </div>
                      <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-[#6E736E]">{relTime(e.occurredAtMs, now)}</span>
                    </div>
                  ))}
                </SoftCard>
              )}
            </section>

            {/* Dispatch history */}
            <section>
              <SectionLabel className="mb-2">Dispatch · Module 4</SectionLabel>
              {data.dispatches.length === 0 ? (
                <EmptyHint>No dispatches routed</EmptyHint>
              ) : (
                <SoftCard className="px-5 py-3">
                  {data.dispatches.map((d) => (
                    <div key={d.id} className="py-2 not-last:border-b not-last:border-white/[0.07]">
                      <div className="flex items-baseline justify-between gap-3">
                        <p className="truncate text-[12.5px] text-[#E9EBE7]">{d.subject ?? "(no subject)"}</p>
                        <Chip tone={d.status === "clicked" || d.status === "replied" ? "inverted" : "outline"}>{d.status}</Chip>
                      </div>
                      <p className="mt-0.5 font-mono text-[10.5px] text-[#6E736E]">
                        {d.channel.replace(/_/g, " ")} · {d.provider ?? "—"}
                        {d.scheduledAtMs ? ` · next step ${relTime(d.scheduledAtMs, now) === "" ? "now" : new Date(d.scheduledAtMs).toLocaleDateString()}` : ""}
                      </p>
                    </div>
                  ))}
                </SoftCard>
              )}
            </section>

            {/* Replies */}
            {data.replies.length > 0 && (
              <section>
                <SectionLabel className="mb-2">Reply threads · Module 9</SectionLabel>
                <SoftCard className="px-5 py-3">
                  {data.replies.map((r) => (
                    <div key={r.id} className="py-2 not-last:border-b not-last:border-white/[0.07]">
                      <div className="flex items-baseline justify-between gap-3">
                        <p className="truncate text-[12.5px] text-[#E9EBE7]">{r.subject ?? "(no subject)"}</p>
                        <Chip tone="raised">{r.intent.replace(/_/g, " ")}</Chip>
                      </div>
                      <p className="mt-1 line-clamp-2 text-[11.5px] leading-relaxed text-[#8E9194]">{r.body}</p>
                      {r.draft && (
                        <p className="mt-1 font-mono text-[10.5px] uppercase tracking-[0.1em] text-[#6E736E]">draft: {r.draft.status.replace(/_/g, " ")}</p>
                      )}
                    </div>
                  ))}
                </SoftCard>
              </section>
            )}

            {/* Action footer */}
            <section className="sticky bottom-0 -mx-6 mt-2 border-t border-white/[0.10] bg-[#0B0C0B] px-6 pb-2 pt-4">
              <div className="flex flex-wrap items-center gap-2">
                {phone && (
                  <PillButton tone="dark" href={`tel:${phone.replace(/\s/g, "")}`}>
                    Call {phone}
                  </PillButton>
                )}
                <PillButton tone="ghost" onClick={() => onAction(data.prospect.id, "called", "Logged from dossier")}>
                  Log call
                </PillButton>
                <PillButton tone="well" onClick={() => onAction(data.prospect.id, "deferred")}>
                  Defer
                </PillButton>
                <PillButton tone="well" onClick={() => onAction(data.prospect.id, "snoozed", undefined)}>
                  Snooze 24h
                </PillButton>
                {data.prospect.score && (
                  <PillButton tone="well" href={`/api/dossier/brief?id=${data.prospect.id}`} target="_blank">
                    Export brief
                  </PillButton>
                )}
              </div>
            </section>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
