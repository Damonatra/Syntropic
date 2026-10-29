/** Dossier drawer — full operator context before a call. Obsidian sheet, graphite threat matrix. */
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Chip, ErpBadge, Kv, PillButton, ScoreBlock, SectionLabel, SoftCard, EmptyHint } from "./bits";
import { EVENT_LABELS, PORTAL_LABELS, annualLeakageUsd, money, relTime, verticalLabel, type CommandLead } from "@/lib/vertebra/command";
import { NET_MARGIN_ASSUMPTION, EXPOSURE_CEILING } from "@/lib/vertebra/command";
import { buildBrief, verifyDraft, countEchoedSignals, CLOSE_CTA } from "@/lib/vertebra/evidence";

interface DossierData {
  prospect: {
    id: string;
    name: string;
    domain: string | null;
    vertical: string | null;
    region: string | null;
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
    rawExcerpt: string | null;
    erpMetadata: string | null;
    latitude: number | null;
    longitude: number | null;
    lastIntentHeat: number;
    clusterName: string | null;
    score: { qlvScore: number; band: string; factors: Array<{ key: string; weight: number; points: number; evidence: string }>; hooks: Array<{ flavor: string; body: string }>; rationale: string; model: string } | null;
    contacts: Array<{ name: string; role: string; titleRaw: string | null; phone: string | null }>;
    highTouch: { qlvScore: number; exported: boolean } | null;
    painSignals: Array<{ id: string; kind: string; verbatim: string; context: string | null; sourceUrl: string | null; sourceNote: string | null; confidence: string; status: string; createdAtMs: number }>;
  };
  telemetry: Array<{ id: string; eventType: string; url: string | null; city: string | null; country: string | null; device: string | null; durationMs: number | null; occurredAtMs: number }>;
  dispatches: Array<{ id: string; channel: string; status: string; subject: string | null; provider: string | null; scheduledAtMs: number | null; createdAtMs: number }>;
  actions: Array<{ id: string; action: string; note: string | null; createdAtMs: number }>;
  replies: Array<{ id: string; intent: string; fromEmail: string; subject: string | null; body: string; receivedAtMs: number; draft: { id: string; status: string; subject: string; body: string } | null }>;
}

const ACTION_LOG_LABELS: Record<string, string> = {
  called: "Call logged",
  deferred: "Deferred",
  snoozed: "Snoozed",
  booked: "Booked",
  note: "Operator note",
  emailed: "Cold email",
};

const HOOK_FLAVOR_LABELS: Record<string, string> = {
  rfq_latency: "RFQ latency",
  spa_leakage: "SPA leakage",
  portal_drift: "Portal drift",
  peer_proof: "Peer proof",
};

/** Subject seed keyed off a hook's flavor — client parity with casl.ts subjectForHook. */
function seedSubject(flavor: string, company: string): string {
  switch (flavor) {
    case "rfq_latency":
      return `${company}: RFQ turnaround`;
    case "spa_leakage":
      return `${company}: vendor SPA gaps`;
    case "portal_drift":
      return `${company}: quoting through the portal`;
    case "peer_proof":
      return `a benchmark for ${company}`;
    default:
      return `${company}: quoting benchmark`;
  }
}

function seedBody(hookBody: string, contactFirst?: string): string {
  const hello = contactFirst ? `Hi ${contactFirst},` : "Hello,";
  return `${hello}\n\n${hookBody}\n\n${CLOSE_CTA}`;
}

type SendResult =
  | { kind: "staged"; reason: string | null }
  | { kind: "sent"; id: string | null }
  | { kind: "failed"; reason: string | null }
  | { kind: "cooldown"; lastSend: { subject: string | null; atMs: number } | null }
  | { kind: "suppressed" }
  | { kind: "casl"; hint: string | null }
  | { kind: "verify"; violations: Array<{ code: string; detail: string }> }
  | { kind: "error"; reason: string | null };

interface DraftReport {
  ok: boolean;
  hard: Array<{ code: string; detail: string }>;
  soft: Array<{ code: string; detail: string }>;
  briefHash: string | null;
  attempts: number;
}

const PAIN_KIND_LABELS: Record<string, string> = {
  review_complaint: "review complaint",
  site_copy: "their site",
  job_posting: "job posting",
  reply_language: "their reply",
  telemetry: "telemetry",
  audit_finding: "audit doc",
  operator_note: "operator note",
  research: "research",
};
const PAIN_KINDS = Object.keys(PAIN_KIND_LABELS);

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
  focusCompose = false,
}: {
  lead: CommandLead | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAction: (prospectId: string, action: "called" | "deferred" | "snoozed" | "booked" | "note", note?: string) => Promise<void> | void;
  /** M7 — opened via the `e` key: land the operator on the cold email desk. */
  focusCompose?: boolean;
}) {
  const [data, setData] = useState<DossierData | null>(null);
  const [loading, setLoading] = useState(false);
  // M3 operator desk state
  const [composeSubject, setComposeSubject] = useState("");
  const [composeBody, setComposeBody] = useState("");
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<SendResult | null>(null);
  const [noteText, setNoteText] = useState("");
  const [triaging, setTriaging] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [acting, setActing] = useState(false);
  // Personalization layer — evidence strip + AI draft + verify report
  const [drafting, setDrafting] = useState(false);
  const [draftReport, setDraftReport] = useState<DraftReport | null>(null);
  const [draftNotice, setDraftNotice] = useState<string | null>(null);
  const [evKind, setEvKind] = useState("review_complaint");
  const [evVerbatim, setEvVerbatim] = useState("");
  const [evSource, setEvSource] = useState("");
  const [evBusy, setEvBusy] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [extractNote, setExtractNote] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const seededForRef = useRef<string | null>(null);
  const composeInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open || !lead) {
      setSendResult(null);
      setNoteText("");
      seededForRef.current = null;
      return;
    }
    setLoading(true);
    setData(null);
    fetch(`/api/dossier?id=${lead.id}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setData(d))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [open, lead]);

  /** Silent post-action refetch — keeps the drawer stable, never clobbers with null. */
  function refetchDossier() {
    if (!lead) return;
    fetch(`/api/dossier?id=${lead.id}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) setData(d);
      })
      .catch(() => {});
  }

  // M7 — `e` opens the dossier straight onto the cold email desk.
  useEffect(() => {
    if (!open || !data || !focusCompose) return;
    const t = setTimeout(() => {
      composeInputRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
      composeInputRef.current?.focus({ preventScroll: true });
    }, 150);
    return () => clearTimeout(t);
  }, [open, data, focusCompose]);

  // Angle seeds + M5 draft memory: an unsent draft survives close/reopen.
  // Local memory first, hook seeds second — seeded once per prospect.
  useEffect(() => {
    if (!data || seededForRef.current === data.prospect.id) return;
    seededForRef.current = data.prospect.id;
    const key = `vertebra:compose:${data.prospect.id}`;
    try {
      const saved = localStorage.getItem(key);
      if (saved) {
        const parsed = JSON.parse(saved) as { subject?: string; body?: string };
        setComposeSubject(parsed.subject ?? "");
        setComposeBody(parsed.body ?? "");
        return;
      }
    } catch {
      /* corrupt or private mode — fall through to seeds */
    }
    const top = data.prospect.score?.hooks?.[0];
    if (top) {
      const s = seedSubject(top.flavor, data.prospect.name);
      const b = seedBody(top.body, data.prospect.contacts[0]?.name.split(" ")[0]);
      setComposeSubject(s);
      setComposeBody(b);
      try {
        localStorage.setItem(key, JSON.stringify({ subject: s, body: b }));
      } catch {
        /* private mode */
      }
    }
  }, [data]);

  const now = Date.now();
  const isCanadian = Boolean(data && ((data.prospect.country ?? "").toLowerCase().includes("canada") || data.prospect.region === "ca"));
  const gateClosed = Boolean(data && isCanadian && !data.prospect.caslScope);
  const sendDisabled =
    sending ||
    !data?.prospect.bestEmail ||
    gateClosed ||
    sendResult?.kind === "suppressed" ||
    sendResult?.kind === "casl" ||
    composeSubject.trim().length === 0 ||
    composeBody.trim().length === 0;
  const caslNotice = gateClosed
    ? "CASL gate closed — no consent basis on file for this Canadian prospect. The enclave will refuse the send; establish consent first."
    : data?.prospect.caslScope
      ? "CASL consent on file · RFC 8058 one-click unsubscribe headers attach."
      : "Identification footer + instant unsubscribe link attach to every send.";
  const mapUrl = data
    ? data.prospect.latitude != null && data.prospect.longitude != null
      ? `https://www.google.com/maps/search/?api=1&query=${data.prospect.latitude},${data.prospect.longitude}`
      : data.prospect.city || data.prospect.stateProvince
        ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([data.prospect.city, data.prospect.stateProvince, data.prospect.country].filter(Boolean).join(" "))}`
        : null
    : null;
  // M5 — the dispatch ledger is the truth source for the persistent staged badge
  const lastManual = data?.dispatches.find((d) => d.channel === "operator_manual_email") ?? null;
  const lastManualHours = lastManual ? (now - lastManual.createdAtMs) / 3_600_000 : null;

  // M7 — compose rails: the exact deterministic engine the send wall runs, live
  // on every keystroke against a brief built from the same dossier material.
  // Advisory by design — the wall at /api/dossier/email remains the law; these
  // rails exist so the operator never discovers a violation after clicking.
  const liveBrief = useMemo(() => {
    if (!data) return null;
    const active = data.prospect.painSignals.filter((s) => s.status === "active");
    if (active.length === 0) return null;
    return buildBrief({
      prospectId: data.prospect.id,
      companyName: data.prospect.name,
      contactFirstName: data.prospect.contacts[0]?.name.split(" ")[0] ?? null,
      contactFullName: data.prospect.contacts[0]?.name ?? null,
      city: data.prospect.city,
      stateProvince: data.prospect.stateProvince,
      region: data.prospect.region,
      vertical: data.prospect.vertical,
      detectedErp: data.prospect.detectedErp,
      quotePortalType: data.prospect.quotePortalType,
      portalHint: (data.prospect.erpMetadata ?? "").includes("portal") ? "portal signals present in ERP metadata" : null,
      rawExcerpt: data.prospect.rawExcerpt,
      signals: active.map((s) => ({
        id: s.id,
        kind: s.kind,
        verbatim: s.verbatim,
        context: s.context,
        sourceUrl: s.sourceUrl,
        sourceNote: s.sourceNote,
        confidence: s.confidence,
      })),
      hookBodies: data.prospect.score?.hooks.map((h) => h.body) ?? [],
      rationale: data.prospect.score?.rationale ?? null,
      boilerplate: [CLOSE_CTA],
    });
  }, [data]);
  const rails = useMemo(() => {
    if (!liveBrief) return null;
    if (composeSubject.trim().length === 0 && composeBody.trim().length === 0) return null;
    const report = verifyDraft(composeSubject, composeBody, liveBrief, { requireSignalEcho: false });
    const echoed = countEchoedSignals(composeBody, liveBrief.signals.map((s) => s.verbatim));
    return { report, echoed, total: liveBrief.signals.length };
  }, [liveBrief, composeSubject, composeBody]);

  function copyEmail() {
    if (!data?.prospect.bestEmail) return;
    navigator.clipboard
      ?.writeText(data.prospect.bestEmail)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => {});
  }

  /** M5 — mirror every keystroke into the per-prospect draft memory. */
  function touchCompose(patch: { subject?: string; body?: string }) {
    if (!data) return;
    try {
      localStorage.setItem(
        `vertebra:compose:${data.prospect.id}`,
        JSON.stringify({ subject: patch.subject ?? composeSubject, body: patch.body ?? composeBody }),
      );
    } catch {
      /* private mode */
    }
  }

  async function sendColdEmail(override: boolean) {
    if (!data) return;
    setSending(true);
    setSendResult(null);
    try {
      const res = await fetch("/api/dossier/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prospectId: data.prospect.id,
          subject: composeSubject.trim(),
          body: composeBody.trim(),
          ...(override ? { override: true } : {}),
        }),
      });
      const j = (await res.json().catch(() => null)) as
        | { ok?: boolean; send?: { status: string; reason: string | null; providerMsgId: string | null }; lastSend?: { subject: string | null; atMs: number }; error?: string; hint?: string; reason?: string; violations?: Array<{ code: string; detail: string }> }
        | null;
      if (res.ok && j?.ok && j.send) {
        if (j.send.status === "sent" || j.send.status === "staged") {
          setSendResult(
            j.send.status === "sent" ? { kind: "sent", id: j.send.providerMsgId } : { kind: "staged", reason: j.send.reason },
          );
          setComposeSubject("");
          setComposeBody("");
          try {
            localStorage.removeItem(`vertebra:compose:${data.prospect.id}`); // M5 — sent is sent
          } catch {
            /* private mode */
          }
        } else {
          setSendResult({ kind: "failed", reason: j.send.reason });
        }
      } else if (res.status === 409) {
        setSendResult({ kind: "cooldown", lastSend: j?.lastSend ?? null });
      } else if (res.status === 422 && j?.violations) {
        setSendResult({ kind: "verify", violations: j.violations });
      } else if (res.status === 403 && j?.error === "suppressed") {
        setSendResult({ kind: "suppressed" });
      } else if (res.status === 403) {
        setSendResult({ kind: "casl", hint: j?.hint ?? null });
      } else {
        setSendResult({ kind: "error", reason: j?.error ?? `http_${res.status}` });
      }
    } catch {
      setSendResult({ kind: "error", reason: "network" });
    } finally {
      setSending(false);
      refetchDossier();
    }
  }

  async function triageDraft(draftId: string, decision: "approved" | "discarded") {
    try {
      await fetch("/api/replies", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draftId, decision }),
      });
    } catch {
      /* honest: the refetch below shows the truth */
    } finally {
      setTriaging(null);
      refetchDossier();
    }
  }

  /** Add a verbatim pain signal from the inline composer. */
  async function addSignal() {
    if (!data || evVerbatim.trim().length < 8 || evBusy) return;
    setEvBusy(true);
    try {
      const res = await fetch("/api/dossier/evidence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prospectId: data.prospect.id,
          kind: evKind,
          verbatim: evVerbatim.trim(),
          ...(evSource.trim() ? { sourceNote: evSource.trim() } : {}),
        }),
      });
      if (res.ok) {
        setEvVerbatim("");
        setEvSource("");
        setComposerOpen(false);
        refetchDossier();
      }
    } catch {
      /* the refetch shows the truth */
    } finally {
      setEvBusy(false);
    }
  }

  async function vetoSignal(id: string, status: "active" | "vetoed") {
    try {
      await fetch("/api/dossier/evidence", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status }),
      });
    } catch {
      /* honest refetch below */
    } finally {
      refetchDossier();
    }
  }

  /** Mine held material (ingest excerpt, replies, audit docs) for verbatim quotes. */
  async function extractSignals() {
    if (!data || extracting) return;
    setExtracting(true);
    setExtractNote(null);
    try {
      const res = await fetch("/api/dossier/evidence/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prospectId: data.prospect.id }),
      });
      const j = (await res.json().catch(() => null)) as
        | { stored?: Array<unknown>; discarded?: Array<unknown>; error?: string; hint?: string }
        | null;
      if (res.ok && j) {
        setExtractNote(`${j.stored?.length ?? 0} signal(s) stored · ${j.discarded?.length ?? 0} refused (not verbatim)`);
        refetchDossier();
      } else {
        setExtractNote(
          j?.error === "no_material"
            ? "nothing held to extract from — paste the quote by hand"
            : j?.error === "llm_unavailable"
              ? "extraction needs the LLM — paste the quote by hand"
              : "extraction failed",
        );
      }
    } catch {
      setExtractNote("extraction failed");
    } finally {
      setExtracting(false);
    }
  }

  /** The 1:1 drafting pipeline: brief → LLM → verify → (one regen) → compose. */
  async function draftWithAI() {
    if (!data || drafting) return;
    setDrafting(true);
    setDraftNotice(null);
    setDraftReport(null);
    try {
      const res = await fetch("/api/dossier/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prospectId: data.prospect.id }),
      });
      const j = (await res.json().catch(() => null)) as
        | {
            ok?: boolean;
            draft?: { subject: string; body: string; echoedSignalId: string | null };
            briefHash?: string;
            verify?: { ok: boolean; hard: Array<{ code: string; detail: string }>; soft: Array<{ code: string; detail: string }> };
            attempts?: number;
            error?: string;
            hint?: string;
          }
        | null;
      if (res.ok && j?.draft) {
        setComposeSubject(j.draft.subject);
        setComposeBody(j.draft.body);
        touchCompose({ subject: j.draft.subject, body: j.draft.body });
        setSendResult(null);
        setDraftReport({ ok: Boolean(j.verify?.ok), hard: j.verify?.hard ?? [], soft: j.verify?.soft ?? [], briefHash: j.briefHash ?? null, attempts: j.attempts ?? 1 });
      } else if (res.status === 409) {
        setDraftNotice("no evidence on file — add or extract pain signals first; the enclave does not draft from vibes");
      } else if (res.status === 503) {
        setDraftNotice("drafting needs the LLM — write it manually; the verify rails still apply at send");
      } else {
        setDraftNotice(res.status === 502 ? "the model could not produce a clean draft — try again or write it manually" : "draft failed");
      }
    } catch {
      setDraftNotice("draft failed — network");
    } finally {
      setDrafting(false);
    }
  }

  async function act(action: "called" | "deferred" | "snoozed" | "booked" | "note", note?: string) {
    if (!data || acting) return; // M5 — one-shot while a dossier action is in flight
    setActing(true);
    try {
      await onAction(data.prospect.id, action, note);
      refetchDossier();
    } finally {
      setActing(false);
    }
  }

  function logNote() {
    const trimmed = noteText.trim();
    if (!trimmed) return;
    setNoteText("");
    void act("note", trimmed);
  }
  const score = data?.prospect.score ?? (lead?.score ? { ...lead.score } : null);
  const leakage = data ? annualLeakageUsd(data.prospect.revenueEstimateUsd, score?.qlvScore ?? null) : lead?.leakageUsd ?? null;
  const erp = erpDoc(data?.prospect.erpMetadata ?? null);
  const phone = data?.prospect.contacts[0]?.phone ?? lead?.contact?.phone ?? null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* command-root scopes the Enclave font system (Inter Tight · Space Grotesk · JetBrains Mono)
          + achromatic tokens onto this portal — otherwise the sheet inherits body's plain Inter. */}
      <SheetContent
        side="right"
        className="command-root cc-scroll w-full overflow-y-auto border-l border-white/[0.10] bg-[#0B0C0B] p-0 text-[#F4F5F2] antialiased sm:max-w-[560px]"
      >
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
                <div className="mt-2 flex flex-wrap items-center gap-3 border-t border-white/[0.08] pt-2.5 font-mono text-[10px] uppercase tracking-[0.14em] text-[#8E9194]">
                  <button type="button" onClick={copyEmail} disabled={!data.prospect.bestEmail} className="transition-colors hover:text-[#F4F5F2] disabled:opacity-40">
                    copy email
                  </button>
                  {data.prospect.domain && (
                    <a href={`https://${data.prospect.domain}`} target="_blank" rel="noreferrer" className="transition-colors hover:text-[#F4F5F2]">
                      open domain ↗
                    </a>
                  )}
                  {mapUrl && (
                    <a href={mapUrl} target="_blank" rel="noreferrer" className="transition-colors hover:text-[#F4F5F2]">
                      map ↗
                    </a>
                  )}
                  {copied && <span className="text-[#F4F5F2]">copied ✓</span>}
                </div>
              </SoftCard>
            </section>

            {/* Pain evidence (personalization layer) — verbatim quotes from their world */}
            <section>
              <SectionLabel className="mb-2">Pain evidence · verbatim</SectionLabel>
              <SoftCard className="px-5 py-4">
                {(data.prospect.painSignals?.length ?? 0) === 0 ? (
                  <EmptyHint>
                    No pain signals on file. The AI draft refuses to run without evidence — every cold email must be grounded in their words, not vibes.
                  </EmptyHint>
                ) : (
                  <div className="flex flex-col gap-2">
                    {data.prospect.painSignals.map((s) => (
                      <div
                        key={s.id}
                        className={`rounded-md border px-3 py-2 ${s.status === "vetoed" ? "border-white/[0.06] opacity-45" : "border-white/[0.10]"}`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-[#8E9194]">
                            {PAIN_KIND_LABELS[s.kind] ?? s.kind} · {s.confidence}
                          </span>
                          <button
                            type="button"
                            onClick={() => void vetoSignal(s.id, s.status === "active" ? "vetoed" : "active")}
                            className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-[#6E736E] transition-colors hover:text-[#F4F5F2]"
                          >
                            {s.status === "active" ? "veto" : "restore"}
                          </button>
                        </div>
                        <p className="mt-1 text-[12px] leading-relaxed text-[#E9EBE7]">“{s.verbatim}”</p>
                        {(s.sourceNote || s.context) && (
                          <p className="mt-1 font-mono text-[9.5px] text-[#6E736E]">
                            {s.sourceNote ?? ""}
                            {s.sourceUrl ? (
                              <a href={s.sourceUrl} target="_blank" rel="noreferrer" className="ml-1 underline decoration-white/20 underline-offset-2 hover:text-[#F4F5F2]">
                                source ↗
                              </a>
                            ) : null}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {composerOpen ? (
                  <div className="mt-3 rounded-md border border-white/[0.12] bg-[#131513] px-3 py-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <select
                        value={evKind}
                        onChange={(e) => setEvKind(e.target.value)}
                        className="h-7 rounded-md border border-white/[0.10] bg-[#0B0C0B] px-2 font-mono text-[10px] text-[#F4F5F2] focus:outline-none"
                      >
                        {PAIN_KINDS.map((k) => (
                          <option key={k} value={k}>
                            {PAIN_KIND_LABELS[k]}
                          </option>
                        ))}
                      </select>
                      <input
                        value={evSource}
                        onChange={(e) => setEvSource(e.target.value)}
                        placeholder="source note (optional)"
                        maxLength={300}
                        className="h-7 flex-1 rounded-md border border-white/[0.10] bg-[#0B0C0B] px-2 font-mono text-[10px] text-[#F4F5F2] placeholder:text-[#6E736E] focus:border-white/[0.28] focus:outline-none"
                      />
                    </div>
                    <textarea
                      value={evVerbatim}
                      onChange={(e) => setEvVerbatim(e.target.value)}
                      rows={3}
                      maxLength={600}
                      placeholder="paste the exact words — verbatim, never a summary"
                      className="mt-2 w-full resize-y rounded-md border border-white/[0.10] bg-[#0B0C0B] px-2.5 py-2 font-mono text-[11px] leading-relaxed text-[#F4F5F2] placeholder:text-[#6E736E] focus:border-white/[0.28] focus:outline-none"
                    />
                    <div className="mt-2 flex items-center gap-3">
                      <PillButton tone="dark" onClick={() => void addSignal()} disabled={evBusy || evVerbatim.trim().length < 8}>
                        {evBusy ? "storing…" : "store signal"}
                      </PillButton>
                      <button type="button" onClick={() => setComposerOpen(false)} className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-[#6E736E] hover:text-[#F4F5F2]">
                        cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-3 flex flex-wrap items-center gap-3 font-mono text-[10px] uppercase tracking-[0.14em]">
                    <button type="button" onClick={() => setComposerOpen(true)} className="text-[#8E9194] transition-colors hover:text-[#F4F5F2]">
                      + add verbatim
                    </button>
                    <button type="button" onClick={() => void extractSignals()} disabled={extracting} className="text-[#8E9194] transition-colors hover:text-[#F4F5F2] disabled:opacity-40">
                      {extracting ? "mining held material…" : "extract from held evidence"}
                    </button>
                    {extractNote && <span className="text-[#6E736E] normal-case tracking-normal">{extractNote}</span>}
                  </div>
                )}
              </SoftCard>
            </section>

            {/* Cold email desk (M3) — compose, angle seeds, honest send states */}
            <section>
              <SectionLabel className="mb-2">Cold email desk · channel A</SectionLabel>
              <SoftCard className="px-5 py-4">
                <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-[#8E9194]">
                  to · <span className="normal-case tracking-normal text-[#E9EBE7]">{data.prospect.bestEmail ?? "unverified — no send path"}</span>
                </div>
                {lastManual?.status === "staged" && (
                  <p className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-white/[0.14] bg-white/[0.03] px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-[#F4F5F2]">
                    <span className="size-1.5 rounded-full bg-[#F4F5F2] cc-pulse-dot" /> mail: staged — no provider · awaiting resend key
                  </p>
                )}
                {lastManual && lastManual.status !== "staged" && lastManualHours != null && lastManualHours < 24 && (
                  <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.14em] text-[#6E736E]">
                    last manual send {relTime(lastManual.createdAtMs, now) || "just now"} · {lastManual.status} · cooldown active
                  </p>
                )}
                <p className={`mt-2.5 rounded-md border px-3 py-2 font-mono text-[10.5px] leading-relaxed ${gateClosed ? "border-white/[0.24] bg-white/[0.04] text-[#F4F5F2]" : "border-white/[0.08] text-[#8E9194]"}`}>
                  {caslNotice}
                </p>
                {score?.hooks && score.hooks.length > 0 && (
                  <div className="mt-3 flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-[9.5px] uppercase tracking-[0.18em] text-[#6E736E]">angle seeds</span>
                    {score.hooks.map((h) => (
                      <button
                        key={h.flavor}
                        type="button"
                        onClick={() => {
                          setComposeSubject(seedSubject(h.flavor, data.prospect.name));
                          setComposeBody(seedBody(h.body, data.prospect.contacts[0]?.name.split(" ")[0]));
                          setSendResult(null);
                        }}
                        className="rounded-full border border-white/[0.12] px-2.5 py-1 font-mono text-[10px] text-[#8E9194] transition-colors hover:border-white/[0.3] hover:text-[#F4F5F2]"
                      >
                        {HOOK_FLAVOR_LABELS[h.flavor] ?? h.flavor}
                      </button>
                    ))}
                  </div>
                )}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[9.5px] uppercase tracking-[0.18em] text-[#6E736E]">1:1 draft</span>
                  <button
                    type="button"
                    onClick={() => void draftWithAI()}
                    disabled={drafting || (data.prospect.painSignals?.filter((s) => s.status === "active").length ?? 0) === 0}
                    className="rounded-full border border-white/[0.12] px-2.5 py-1 font-mono text-[10px] text-[#8E9194] transition-colors hover:border-white/[0.3] hover:text-[#F4F5F2] disabled:opacity-40"
                  >
                    {drafting ? "drafting from evidence…" : "draft with AI"}
                  </button>
                  {draftNotice && <span className="font-mono text-[10px] text-[#8E9194] normal-case tracking-normal">{draftNotice}</span>}
                </div>
                <input
                  ref={composeInputRef}
                  value={composeSubject}
                  onChange={(e) => {
                    setComposeSubject(e.target.value);
                    touchCompose({ subject: e.target.value });
                  }}
                  placeholder="subject"
                  maxLength={200}
                  disabled={!data.prospect.bestEmail}
                  className="mt-3 h-9 w-full rounded-md border border-white/[0.10] bg-[#131513] px-3 font-mono text-[12px] text-[#F4F5F2] placeholder:text-[#6E736E] focus:border-white/[0.28] focus:outline-none disabled:opacity-40"
                />
                <textarea
                  value={composeBody}
                  onChange={(e) => {
                    setComposeBody(e.target.value);
                    touchCompose({ body: e.target.value });
                  }}
                  rows={7}
                  maxLength={8000}
                  placeholder="body"
                  disabled={!data.prospect.bestEmail}
                  className="mt-2 w-full resize-y rounded-md border border-white/[0.10] bg-[#131513] px-3 py-2.5 font-mono text-[12px] leading-relaxed text-[#F4F5F2] placeholder:text-[#6E736E] focus:border-white/[0.28] focus:outline-none disabled:opacity-40"
                />
                <div className="mt-1 text-right font-mono text-[9.5px] tabular-nums text-[#6E736E]">{composeBody.length} / 8000</div>
                {rails && (
                  <div
                    className={`mt-1.5 rounded-md border px-3 py-2 font-mono text-[9.5px] uppercase tracking-[0.14em] leading-relaxed ${
                      rails.report.ok ? "border-white/[0.08] text-[#6E736E]" : "border-white/[0.24] bg-white/[0.04] text-[#F4F5F2]"
                    }`}
                  >
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span>live rails</span>
                      <span className={rails.report.stats.bodyWords > 200 ? "text-[#F4F5F2]" : undefined}>
                        {rails.report.stats.bodyWords} words
                      </span>
                      <span>{rails.report.stats.questions} ask</span>
                      <span>
                        banned {rails.report.hard.filter((v) => v.code === "banned_phrase").length}
                      </span>
                      <span>
                        trace {rails.report.hard.some((v) => v.code.startsWith("fact_trace")) ? "off" : "clean"}
                      </span>
                      <span className={rails.echoed === 0 ? "text-[#F4F5F2]" : undefined}>echo {rails.echoed}/{rails.total}</span>
                      <span className="normal-case tracking-normal">· advisory — the send wall is the law</span>
                    </div>
                    {rails.report.hard.length > 0 && (
                      <ul className="mt-1 list-disc pl-4 normal-case tracking-normal">
                        {rails.report.hard.slice(0, 2).map((v, i) => (
                          <li key={i}>
                            {v.code}: {v.detail}
                          </li>
                        ))}
                        {rails.report.hard.length > 2 && <li>…and {rails.report.hard.length - 2} more</li>}
                      </ul>
                    )}
                  </div>
                )}
                {draftReport && (
                  <div className={`mt-2 rounded-md border px-3 py-2 font-mono text-[10px] leading-relaxed ${draftReport.ok ? "border-white/[0.08] text-[#8E9194]" : "border-white/[0.24] bg-white/[0.04] text-[#F4F5F2]"}`}>
                    {draftReport.ok ? (
                      <>
                        <span className="uppercase tracking-[0.16em]">verify: clean</span>
                        <span className="ml-2 text-[#6E736E]">
                          brief {draftReport.briefHash?.slice(0, 8) ?? "—"} · {draftReport.attempts} attempt{draftReport.attempts === 1 ? "" : "s"}
                          {draftReport.soft.length > 0 && ` · soft: ${draftReport.soft.map((v) => v.code).join(", ")}`}
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="uppercase tracking-[0.16em]">verify: violations — regenerate failed, edit by hand</span>
                        <ul className="mt-1 list-disc pl-4 normal-case tracking-normal">
                          {draftReport.hard.map((v, i) => (
                            <li key={i}>
                              {v.code}: {v.detail}
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </div>
                )}
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <PillButton tone="dark" onClick={() => void sendColdEmail(false)} disabled={sendDisabled}>
                    {sending ? "sending…" : "send cold email"}
                  </PillButton>
                  {sendResult?.kind === "cooldown" && (
                    <PillButton tone="well" onClick={() => void sendColdEmail(true)} disabled={sending}>
                      force resend
                    </PillButton>
                  )}
                  <span className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-[#6E736E]">24h cooldown · honest dispatch</span>
                </div>
                {sendResult && (
                  <div className="mt-3 rounded-md border border-white/[0.14] bg-white/[0.03] px-3 py-2.5">
                    <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-[#F4F5F2]">
                      {sendResult.kind === "staged" && "● mail: staged — no provider"}
                      {sendResult.kind === "sent" && "● mail: sent — via resend"}
                      {sendResult.kind === "failed" && "● send failed"}
                      {sendResult.kind === "cooldown" && "● cooldown active — manual send inside 24h"}
                      {sendResult.kind === "suppressed" && "● suppressed — the enclave will not send"}
                      {sendResult.kind === "casl" && "● casl gate — enclave refused"}
                      {sendResult.kind === "verify" && "● integrity wall — send refused"}
                      {sendResult.kind === "error" && "● send failed — enclave error"}
                    </p>
                    <p className="mt-1 text-[11.5px] leading-relaxed text-[#8E9194]">
                      {sendResult.kind === "staged" &&
                        "Accepted into the ledger and visible in dispatch history. It leaves the building the moment RESEND_API_KEY is configured — nothing pretends an email went out."}
                      {sendResult.kind === "sent" && `Provider message ${sendResult.id ?? "accepted"}. CASL footer attached.`}
                      {sendResult.kind === "failed" && (sendResult.reason ?? "Transport refused the message.")}
                      {sendResult.kind === "cooldown" &&
                        sendResult.lastSend &&
                        `“${sendResult.lastSend.subject ?? "(no subject)"}” went out ${relTime(sendResult.lastSend.atMs, now) === "" ? "just now" : relTime(sendResult.lastSend.atMs, now)}. Force resend only if you are sure.`}
                      {sendResult.kind === "suppressed" && "This address opted out — every send path is closed, no exceptions."}
                      {sendResult.kind === "casl" && (sendResult.hint ?? "No consent basis on file.")}
                      {sendResult.kind === "verify" && (
                        <span>
                          Every number and proper noun must be grounded in the evidence on file — fabricated “personalization” is worse than none. Fix the text; there is no override.
                          <ul className="mt-1 list-disc pl-4">
                            {sendResult.violations.map((v, i) => (
                              <li key={i}>
                                {v.code}: {v.detail}
                              </li>
                            ))}
                          </ul>
                        </span>
                      )}
                      {sendResult.kind === "error" && "The enclave did not acknowledge — try again."}
                    </p>
                  </div>
                )}
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

            {/* Operator log (M3) — the decision ledger, previously fetched but never rendered */}
            <section>
              <SectionLabel className="mb-2">Operator log</SectionLabel>
              {data.actions.length === 0 ? (
                <EmptyHint>No operator decisions logged yet</EmptyHint>
              ) : (
                <SoftCard className="px-5 py-3">
                  {data.actions.map((a) => (
                    <div key={a.id} className="flex items-baseline justify-between gap-4 py-2 not-last:border-b not-last:border-white/[0.07]">
                      <div className="min-w-0">
                        <p className="font-mono text-[11px] uppercase tracking-[0.1em] text-[#E9EBE7]">{ACTION_LOG_LABELS[a.action] ?? a.action}</p>
                        {a.note && <p className="mt-0.5 truncate text-[11.5px] text-[#8E9194]">{a.note}</p>}
                      </div>
                      <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-[#6E736E]">{relTime(a.createdAtMs, now)}</span>
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
                        <div className="mt-1.5 rounded-md border border-white/[0.10] bg-[#131513] px-3 py-2.5">
                          <div className="flex items-center justify-between gap-3">
                            <p className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-[#6E736E]">draft · {r.draft.status.replace(/_/g, " ")}</p>
                            {r.draft.status === "pending_human_review" && (
                              <div className="flex shrink-0 gap-2">
                                <PillButton tone="dark" disabled={triaging === r.draft.id} onClick={() => void triageDraft(r.draft!.id, "approved")}>
                                  {triaging === r.draft.id ? "…" : "approve"}
                                </PillButton>
                                <PillButton tone="well" disabled={triaging === r.draft.id} onClick={() => void triageDraft(r.draft!.id, "discarded")}>
                                  discard
                                </PillButton>
                              </div>
                            )}
                          </div>
                          <p className="mt-1.5 text-[12px] text-[#E9EBE7]">{r.draft.subject}</p>
                          <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-[11.5px] leading-relaxed text-[#8E9194]">{r.draft.body}</p>
                        </div>
                      )}
                    </div>
                  ))}
                </SoftCard>
              </section>
            )}

            {/* Action footer */}
            <section className="sticky bottom-0 -mx-6 mt-2 border-t border-white/[0.10] bg-[#0B0C0B] px-6 pb-2 pt-4">
              <div className="flex items-center gap-2">
                <input
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") logNote();
                  }}
                  placeholder="operator note — context, objections, next step"
                  maxLength={280}
                  className="h-9 min-w-0 flex-1 rounded-full border border-white/[0.10] bg-[#131513] px-4 font-mono text-[11.5px] text-[#F4F5F2] placeholder:text-[#6E736E] focus:border-white/[0.28] focus:outline-none"
                />
                <PillButton tone="ghost" disabled={!noteText.trim() || acting} onClick={logNote}>
                  Log note
                </PillButton>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {phone && (
                  <PillButton tone="dark" href={`tel:${phone.replace(/\s/g, "")}`}>
                    Call {phone}
                  </PillButton>
                )}
                <PillButton tone="ghost" disabled={acting} onClick={() => void act("called", "Logged from dossier")}>
                  Log call
                </PillButton>
                <PillButton tone="dark" disabled={acting} onClick={() => void act("booked")}>
                  Booked
                </PillButton>
                <PillButton tone="well" disabled={acting} onClick={() => void act("deferred")}>
                  Defer
                </PillButton>
                <PillButton tone="well" disabled={acting} onClick={() => void act("snoozed", undefined)}>
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
