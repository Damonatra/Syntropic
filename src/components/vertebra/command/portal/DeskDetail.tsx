/**
 * DeskDetail — the right side of the engagement desk: everything about one
 * paid engagement, in operator order. The stage rail states the contract
 * progress; the verdict recorder enforces the $10,000 guarantee decision;
 * the event trail is the append-only honesty ledger rendered verbatim.
 *
 * Frictionless rules: the next legal move is always one button (or the `a`
 * key) away; the commitment gate (verdict before delivery) is mirrored
 * client-side and enforced server-side; every write appends a ledger event.
 */
"use client";

import { useMemo, useState } from "react";
import { Chip, HudMeta, SectionLabel } from "../bits";
import type { EngagementShape } from "@/lib/vertebra/command";
import { nextActionFor, STAGE_LABELS, STAGE_TRANSITIONS, type EngagementStage } from "@/lib/vertebra/portal";

const usd = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;

const STAGE_ORDER: EngagementStage[] = ["paid", "intake", "forensics", "verdict", "delivered", "sow", "closed"];

const EVENT_GLYPHS: Record<string, string> = {
  ingested: "◆",
  stage_changed: "→",
  delivered: "✓",
  verdict_recorded: "⚖",
  prospect_linked: "⌁",
  document_added: "▤",
  note: "·",
};

function relTime(ms: number, nowMs: number): string {
  const s = Math.max(1, Math.floor((nowMs - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function DeskDetail({
  engagement,
  onPatch,
  busy,
  nowMs,
}: {
  engagement: EngagementShape;
  onPatch: (body: Record<string, unknown>) => Promise<boolean>;
  busy: boolean;
  nowMs: number;
}) {
  const [verdictUsd, setVerdictUsd] = useState<string>(
    engagement.confirmedLeakageUsd != null ? String(engagement.confirmedLeakageUsd) : "",
  );
  const [verdictCleared, setVerdictCleared] = useState<boolean | null>(engagement.guaranteeCleared);
  const [verdictNote, setVerdictNote] = useState<string>(engagement.verdictNote ?? "");
  const [note, setNote] = useState("");

  const stage = engagement.status as EngagementStage;
  const forwards = STAGE_TRANSITIONS[stage] ?? [];
  const stageIdx = STAGE_ORDER.indexOf(stage);
  // Next legal forward stage in contract order (never the backward option); back = nearest legal stage before this one.
  const nextForward = useMemo(
    () => STAGE_ORDER.find((s) => forwards.includes(s) && STAGE_ORDER.indexOf(s) > stageIdx) ?? null,
    [forwards, stageIdx],
  );
  const backTo = useMemo(
    () => [...forwards].reverse().find((s) => STAGE_ORDER.indexOf(s) < STAGE_ORDER.indexOf(stage)) ?? null,
    [forwards, stage],
  );
  const nextAction = nextActionFor(engagement);
  const verdictDecided = engagement.guaranteeCleared != null && engagement.confirmedLeakageUsd != null;

  const advance = async () => {
    if (!nextForward || busy) return;
    await onPatch({ op: "stage", to: nextForward });
  };

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto cc-scroll">
      {/* header — client, money, next action */}
      <div className="ink rounded-lg px-6 py-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="font-mono text-[9.5px] uppercase tracking-[0.2em] text-white/60">
              engagement · {engagement.ref} · {engagement.source === "portal_webhook" ? "executive portal webhook" : "manual booking"}
            </p>
            <h3 className="mt-1.5 font-display text-[21px] font-semibold tracking-[-0.03em] text-white">
              {engagement.clientName}
            </h3>
            <p className="mt-1 font-mono text-[10.5px] uppercase tracking-[0.12em] text-white/55">
              {engagement.clientDomain ?? "domain unknown"}
              {engagement.prospectName ? ` · matched → ${engagement.prospectName}` : " · stranger — link or create the prospect"}
            </p>
          </div>
          <div className="text-right">
            <HudMeta node="AST-11" hash={engagement.id.slice(0, 4)} tone="graphite" />
            <p className="mt-2 font-display text-[30px] font-semibold leading-none tracking-[-0.03em] tabular-nums text-white">
              {usd(engagement.amountUsd)}
            </p>
            <p className="mt-1 font-mono text-[9.5px] uppercase tracking-[0.14em] text-white/55">
              {engagement.tier.replace(/_/g, " ")} · paid {relTime(engagement.paidAtMs, nowMs)}
            </p>
          </div>
        </div>
        {!engagement.prospectName && (
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-white/15 pt-3.5">
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/70">
              NEXT ▸ link or create the prospect, then run intake
            </p>
          </div>
        )}
      </div>

      {/* stage rail */}
      <div className="neu-lg rounded-lg px-6 py-5">
        <div className="flex items-center justify-between">
          <SectionLabel>Contract stage</SectionLabel>
          {backTo && (
            <button
              onClick={() => onPatch({ op: "stage", to: backTo })}
              disabled={busy}
              className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#8E9194] transition-colors hover:text-[#F4F5F2] disabled:opacity-40"
            >
              ← back to {STAGE_LABELS[backTo]}
            </button>
          )}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {STAGE_ORDER.map((s, i) => {
            const idx = STAGE_ORDER.indexOf(stage);
            const reached = i <= idx;
            const current = s === stage;
            return (
              <span key={s} className="flex items-center gap-1.5">
                <span
                  className={`rounded-lg px-3 py-1.5 font-mono text-[9.5px] uppercase tracking-[0.12em] transition-all ${
                    current
                      ? "bg-[#F4F5F2] text-[#0B0C0B]"
                      : reached
                        ? "border border-white/25 text-[#C9CCC7]"
                        : "border border-white/[0.07] text-[#5F6460]"
                  }`}
                >
                  {current ? "▸ " : reached ? "✓ " : ""}
                  {STAGE_LABELS[s]}
                </span>
                {i < STAGE_ORDER.length - 1 && <span className="text-[10px] text-[#5F6460]">—</span>}
              </span>
            );
          })}
        </div>
        {stage === "verdict" && !verdictDecided && (
          <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.12em] text-[#8E9194]">
            delivery is gated until the guarantee decision is on the ledger
          </p>
        )}
      </div>

      {/* verdict recorder — the guarantee decision */}
      {(stage === "verdict" || verdictDecided) && (
        <div className="gunmetal rounded-lg border border-black/10 px-6 py-5">
          <div className="flex items-center justify-between">
            <p className="font-mono text-[10.5px] font-medium uppercase tracking-[0.22em] text-[#2E322E]">
              The $10,000 guarantee — verdict
            </p>
            <HudMeta node="AST-12" hash="g10k" tone="light" />
          </div>
          {verdictDecided ? (
            <div className="mt-3 flex flex-wrap items-center gap-x-8 gap-y-2">
              <div>
                <p className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-[#4B514D]">confirmed recoverable</p>
                <p className="mt-1 font-display text-[24px] font-semibold leading-none tracking-[-0.03em] tabular-nums text-[#0B0C0B]">
                  {usd(engagement.confirmedLeakageUsd ?? 0)}
                </p>
              </div>
              <div>
                <p className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-[#4B514D]">guarantee</p>
                <p className="mt-1 font-display text-[24px] font-semibold leading-none tracking-[-0.03em] text-[#0B0C0B]">
                  {engagement.guaranteeCleared ? "CLEARED" : "NOT CLEARED"}
                </p>
              </div>
              <p className="max-w-[380px] flex-1 text-[11.5px] leading-relaxed text-[#4B514D]">
                {engagement.verdictNote ?? "decision on the ledger"}
              </p>
            </div>
          ) : (
            <div className="mt-3 flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-3">
                <label className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-[#2E322E]" htmlFor="verdict-usd">
                  confirmed recoverable $
                </label>
                <input
                  id="verdict-usd"
                  value={verdictUsd}
                  onChange={(e) => setVerdictUsd(e.target.value.replace(/[^0-9]/g, ""))}
                  inputMode="numeric"
                  placeholder="28400"
                  className="w-[130px] rounded-lg border border-black/15 bg-black/[0.06] px-3 py-1.5 font-display text-[15px] font-semibold tabular-nums text-[#0B0C0B] outline-none focus:border-black/40"
                />
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => setVerdictCleared(true)}
                    className={`rounded-lg px-3 py-1.5 font-mono text-[9.5px] font-medium uppercase tracking-[0.12em] transition-all ${
                      verdictCleared === true ? "bg-[#0B0C0B] text-white" : "border border-black/15 bg-black/[0.06] text-[#2E322E]"
                    }`}
                  >
                    clears $10k
                  </button>
                  <button
                    onClick={() => setVerdictCleared(false)}
                    className={`rounded-lg px-3 py-1.5 font-mono text-[9.5px] font-medium uppercase tracking-[0.12em] transition-all ${
                      verdictCleared === false ? "bg-[#0B0C0B] text-white" : "border border-black/15 bg-black/[0.06] text-[#2E322E]"
                    }`}
                  >
                    not yet
                  </button>
                </div>
                <button
                  onClick={async () => {
                    const v = Number(verdictUsd);
                    if (!Number.isFinite(v) || v < 0 || verdictCleared == null || busy) return;
                    const okRec = await onPatch({
                      op: "verdict",
                      confirmedLeakageUsd: v,
                      guaranteeCleared: verdictCleared,
                      note: verdictNote.trim() || undefined,
                    });
                    if (okRec) setVerdictNote("");
                  }}
                  disabled={busy || verdictCleared == null || verdictUsd === ""}
                  className="tactile-btn ml-auto rounded-lg bg-[#0B0C0B] px-4 py-1.5 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-white disabled:opacity-40"
                >
                  Record verdict
                </button>
              </div>
              <input
                value={verdictNote}
                onChange={(e) => setVerdictNote(e.target.value)}
                placeholder="what carries the recovery — one honest line for the ledger"
                className="w-full rounded-lg border border-black/15 bg-black/[0.06] px-3 py-2 font-mono text-[11.5px] text-[#0B0C0B] outline-none placeholder:text-[#6E736E] focus:border-black/40"
              />
              <p className="font-mono text-[9.5px] leading-relaxed tracking-[0.06em] text-[#2E322E]">
                the number the desk reports to the client · the guarantee floor is {usd(10000)} · cleared verdicts unlock delivery
              </p>
            </div>
          )}
        </div>
      )}

      {/* intake facts */}
      <div className="neu rounded-lg px-6 py-5">
        <SectionLabel>Intake facts</SectionLabel>
        <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
          {(
            [
              ["contact", engagement.contactName ?? "—"],
              ["email", engagement.contactEmail ?? "—"],
              ["phone", engagement.contactPhone ?? "—"],
              ["documents", String(engagement.documentCount)],
              ["rfq / month", engagement.intakeRfqPerMonth?.toLocaleString("en-US") ?? "—"],
              ["lines / rfq", engagement.intakeLineItems?.toLocaleString("en-US") ?? "—"],
            ] as Array<[string, string]>
          ).map(([k, v]) => (
            <div key={k}>
              <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-[#8E9194]">{k}</p>
              <p className="mt-1 truncate text-[12.5px] font-medium text-[#F4F5F2]" title={v}>
                {v}
              </p>
            </div>
          ))}
        </div>
        <div className="mt-3 flex items-center gap-2">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="ledger note — call summaries, client asks, guarantees made"
            className="flex-1 rounded-lg border border-white/10 bg-[#0E100E] px-3 py-2 font-mono text-[11.5px] text-[#F4F5F2] outline-none placeholder:text-[#5F6460] focus:border-white/30"
          />
          <button
            onClick={async () => {
              if (!note.trim() || busy) return;
              const okNote = await onPatch({ op: "note", note: note.trim() });
              if (okNote) setNote("");
            }}
            disabled={busy || !note.trim()}
            className="rounded-lg border border-white/25 px-3.5 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-[#F4F5F2] transition-colors hover:bg-white hover:text-[#0B0C0B] disabled:opacity-40"
          >
            Log note
          </button>
        </div>
      </div>

      {/* event trail — append-only, rendered verbatim */}
      <div className="neu-lg flex-1 rounded-lg px-6 py-5">
        <div className="flex items-center justify-between">
          <SectionLabel>Ledger trail</SectionLabel>
          <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-[#5F6460]">append-only · every movement recorded</p>
        </div>
        <div className="mt-3 flex flex-col">
          {engagement.events.map((ev) => (
            <div key={ev.id} className="flex items-start gap-3 border-b border-white/[0.05] py-2.5 last:border-0">
              <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border border-white/10 font-mono text-[10px] text-[#8E9194]">
                {EVENT_GLYPHS[ev.kind] ?? "·"}
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-mono text-[11.5px] leading-relaxed text-[#C9CCC7]">{ev.detail ?? ev.kind}</p>
                <p className="mt-0.5 font-mono text-[9px] uppercase tracking-[0.12em] text-[#5F6460]">
                  {ev.kind.replace(/_/g, " ")} · {ev.actor.replace(/_/g, " ")} · {relTime(ev.createdAtMs, nowMs)}
                </p>
              </div>
              <Chip tone={ev.actor === "portal_webhook" ? "inverted" : "well"} className="shrink-0">
                {ev.actor === "portal_webhook" ? "portal" : ev.actor}
              </Chip>
            </div>
          ))}
          {engagement.events.length === 0 && (
            <p className="py-3 font-mono text-[11px] text-[#5F6460]">no movements yet</p>
          )}
        </div>
      </div>
      {/* sticky action strip — the next move follows the operator at any scroll depth */}
      <div className="ink sticky bottom-0 z-10 mt-auto rounded-lg px-6 py-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-white/85">
            NEXT ▸ {nextAction.action}
          </p>
          {nextForward && (
            <button
              onClick={advance}
              disabled={busy}
              className="tactile-btn ml-auto rounded-lg bg-white px-4 py-1.5 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-[#0B0C0B] hover:bg-[#C9CCC7] disabled:opacity-40"
            >
              {verdictDecided && stage === "verdict" ? "Deliver" : `Advance → ${STAGE_LABELS[nextForward]}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
