/**
 * PORTAL — the Margin Defense Engagement Desk. Where money becomes work.
 *
 * The landing page's executive portal closes the deal; this desk runs the
 * audit. Left: the queue — every paid engagement sorted by money-waiting ×
 * age, each row stating its next action in plain words. Right: the desk
 * detail — stage machine, the $10,000 guarantee verdict, the append-only
 * ledger trail. Keyboard-first: j/k move the cursor, a advances the
 * selected engagement's stage, enter toggles the detail on narrow screens.
 *
 * The old brochure tiles (guarantee banner, leakage estimator, static
 * rev-share example) left the console — selling happens on the landing
 * page; the console only works. Commercial terms remain as a slim
 * reference strip derived from the unified leakage model.
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chip, HudMeta, SectionLabel } from "../bits";
import { DeskDetail } from "./DeskDetail";
import type { CommandSnapshot, EngagementShape } from "@/lib/vertebra/command";
import { LEAKAGE_MODEL } from "@/lib/vertebra/leakage";
import { nextActionFor, queueWeight, STAGE_LABELS, STAGE_TRANSITIONS, type EngagementStage } from "@/lib/vertebra/portal";

const usd = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;

const STAGE_ORDER: EngagementStage[] = ["paid", "intake", "forensics", "verdict", "delivered", "sow", "closed"];

/** Terminal stages sink; the rest sort by money-waiting × age × undecided-verdict. */
function sortQueue(queue: EngagementShape[], nowMs: number): EngagementShape[] {
  return [...queue].sort((a, b) => {
    const aDone = a.status === "closed" || a.status === "sow";
    const bDone = b.status === "closed" || b.status === "sow";
    if (aDone !== bDone) return aDone ? 1 : -1;
    return queueWeight(b, nowMs) - queueWeight(a, nowMs);
  });
}

export function PortalView({ snap, refresh }: { snap: CommandSnapshot; refresh: () => Promise<void> }) {
  const engagements = useMemo(() => snap.engagements ?? [], [snap.engagements]);
  const nowMs = snap.generatedAtMs || Date.now();
  const queue = useMemo(() => sortQueue(engagements, nowMs), [engagements, nowMs]);

  const [cursorId, setCursorId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queueRefs = useRef(new Map<string, HTMLDivElement | null>());

  // Default the cursor to the top of the queue; keep it stable across polls.
  useEffect(() => {
    if (!cursorId && queue.length > 0) setCursorId(queue[0].id);
    else if (cursorId && queue.length > 0 && !queue.some((e) => e.id === cursorId)) setCursorId(queue[0].id);
  }, [queue, cursorId]);

  const selected = queue.find((e) => e.id === cursorId) ?? null;

  const patch = useCallback(
    async (body: Record<string, unknown>): Promise<boolean> => {
      if (!selected) return false;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/portal/engagements/${selected.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const detail = (await res.json().catch(() => ({}))) as { error?: string; hint?: string };
          setError(detail.hint ?? detail.error ?? `server_${res.status}`);
          return false;
        }
        await refresh();
        return true;
      } catch {
        setError("network_error");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [selected, refresh],
  );

  // ---- keyboard flow — j/k cursor, a advance, enter toggle --------------- //
  const [detailOpen, setDetailOpen] = useState(true);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (queue.length === 0) return;
      const idx = queue.findIndex((x) => x.id === cursorId);
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        const next = queue[Math.min(queue.length - 1, idx + 1)];
        if (next) {
          setCursorId(next.id);
          queueRefs.current.get(next.id)?.scrollIntoView({ block: "nearest" });
        }
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        const prev = queue[Math.max(0, idx - 1)];
        if (prev) {
          setCursorId(prev.id);
          queueRefs.current.get(prev.id)?.scrollIntoView({ block: "nearest" });
        }
      } else if (e.key === "a") {
        const cur = queue[idx];
        if (!cur) return;
        const idxCur = STAGE_ORDER.indexOf(cur.status as EngagementStage);
        const nextForward = (STAGE_TRANSITIONS[cur.status as EngagementStage] ?? [])
          .filter((s) => STAGE_ORDER.indexOf(s) > idxCur)
          .sort((x, y) => STAGE_ORDER.indexOf(x) - STAGE_ORDER.indexOf(y))[0];
        if (nextForward) void patch({ op: "stage", to: nextForward });
      } else if (e.key === "Enter") {
        setDetailOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [queue, cursorId, patch]);

  // ---- desk counters — honest readouts from the ledger -------------------- //
  const active = queue.filter((e) => e.status !== "closed" && e.status !== "sow");
  const underAudit = active.reduce((sum, e) => sum + e.amountUsd, 0);
  const cleared = queue.filter((e) => e.guaranteeCleared === true);
  const clearedUsd = cleared.reduce((sum, e) => sum + (e.confirmedLeakageUsd ?? 0), 0);
  const undecided = queue.filter((e) => e.status === "verdict" && e.guaranteeCleared == null).length;
  const oldestPaidDays =
    active.length > 0 ? Math.max(...active.map((e) => Math.floor((nowMs - e.paidAtMs) / 86_400_000))) : 0;

  return (
    <div className="flex h-full flex-col gap-4 overflow-hidden p-5">
      {/* header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <SectionLabel>Margin Defense Desk — paid engagements</SectionLabel>
          <p className="mt-1.5 font-display text-[20px] font-semibold tracking-[-0.03em] text-[#F4F5F2]">
            The landing page closes the deal · this desk runs the audit
          </p>
        </div>
        <HudMeta node="AST-10" hash="e0a5" />
      </div>

      {/* counters */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {(
          [
            ["active engagements", String(active.length)],
            ["under audit", usd(underAudit)],
            ["guarantees cleared", `${cleared.length} · ${usd(clearedUsd)}`],
            ["verdicts undecided", String(undecided)],
            ["oldest unpaid", `${oldestPaidDays}d`],
          ] as Array<[string, string]>
        ).map(([k, v]) => (
          <div key={k} className="neu rounded-lg px-4 py-3">
            <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-[#8E9194]">{k}</p>
            <p className="mt-1.5 font-display text-[20px] font-semibold leading-none tracking-[-0.03em] tabular-nums text-[#F4F5F2]">
              {v}
            </p>
          </div>
        ))}
      </div>

      {error && (
        <p className="rounded-lg border border-white/20 bg-[#141614] px-4 py-2 font-mono text-[10.5px] uppercase tracking-[0.12em] text-[#FF8A7A]">
          {error}
        </p>
      )}

      {/* desk — queue + detail */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1.35fr)]">
        {/* queue */}
        <div className="flex min-h-0 flex-col rounded-lg neu-lg">
          <div className="flex items-center justify-between px-5 pb-2 pt-4">
            <SectionLabel>Engagement queue</SectionLabel>
            <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-[#5F6460]">
              money-waiting × age · j/k · a advance
            </p>
          </div>
          <div className="cc-scroll min-h-0 flex-1 overflow-y-auto px-3 pb-3">
            {queue.length === 0 && (
              <div className="flex h-full min-h-[180px] flex-col items-center justify-center px-8 text-center">
                <p className="font-display text-[15px] font-semibold text-[#F4F5F2]">The ledger is empty</p>
                <p className="mt-1.5 font-mono text-[10px] uppercase leading-relaxed tracking-[0.12em] text-[#5F6460]">
                  paid audits arrive through /api/portal/ingest — the landing page signs them, the desk works them
                </p>
              </div>
            )}
            {queue.map((e) => {
              const isCursor = e.id === cursorId;
              const done = e.status === "closed" || e.status === "sow";
              const na = nextActionFor(e);
              return (
                <div
                  key={e.id}
                  ref={(el) => {
                    queueRefs.current.set(e.id, el);
                  }}
                  role="button"
                  tabIndex={0}
                  aria-pressed={isCursor}
                  onClick={() => {
                    setCursorId(e.id);
                    setDetailOpen(true);
                  }}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter" || ev.key === " ") {
                      ev.preventDefault();
                      setCursorId(e.id);
                      setDetailOpen(true);
                    }
                  }}
                  className={`mb-2 cursor-pointer rounded-lg px-4 py-3 transition-all ${
                    isCursor ? "ink" : "border border-transparent hover:border-white/10"
                  } ${done ? "opacity-55" : ""}`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <p className={`font-display text-[15px] font-semibold tracking-[-0.02em] ${isCursor ? "text-white" : "text-[#F4F5F2]"}`}>
                      {e.clientName}
                    </p>
                    <Chip tone={isCursor ? "inverted" : "raised"}>{STAGE_LABELS[e.status as EngagementStage] ?? e.status}</Chip>
                    {e.source === "portal_webhook" ? (
                      <Chip tone={isCursor ? "well" : "default"}>portal</Chip>
                    ) : (
                      <Chip tone={isCursor ? "well" : "default"}>manual</Chip>
                    )}
                    {!e.prospectName && e.status !== "closed" && (
                      <Chip tone={isCursor ? "well" : "default"}>unlinked</Chip>
                    )}
                    <p className="ml-auto font-display text-[16px] font-semibold tabular-nums text-[#F4F5F2]">
                      {usd(e.amountUsd)}
                    </p>
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
                    <p className={`font-mono text-[10.5px] uppercase tracking-[0.1em] ${isCursor ? "text-white/80" : "text-[#8E9194]"}`}>
                      ▸ {na.action}
                    </p>
                    <p className="font-mono text-[9px] uppercase tracking-[0.12em] text-[#5F6460]">
                      paid {Math.max(0, Math.floor((nowMs - e.paidAtMs) / 86_400_000))}d ago
                      {e.prospectName ? ` · ${e.prospectName}` : ""}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* detail */}
        <div className={`${detailOpen ? "flex" : "hidden xl:flex"} min-h-0 flex-col xl:flex`}>
          {selected ? (
            <DeskDetail engagement={selected} onPatch={patch} busy={busy} nowMs={nowMs} />
          ) : (
            <div className="flex flex-1 items-center justify-center neu-lg">
              <p className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-[#5F6460]">
                select an engagement — j / k moves the cursor
              </p>
            </div>
          )}
        </div>
      </div>

      {/* commercial reference — the contract the desk enforces */}
      <div className="grid shrink-0 grid-cols-2 gap-3 sm:grid-cols-4">
        {(
          [
            ["01 · diagnostic audit", usd(LEAKAGE_MODEL.auditFeeUsd), "deposit credited to any SOW"],
            ["02 · guarantee floor", usd(LEAKAGE_MODEL.guaranteeFloorUsd), "the audit contract, enforced at verdict"],
            ["03 · enterprise sow", usd(LEAKAGE_MODEL.sowFloorUsd), "continuous margin defense deployment"],
            ["04 · rev-share", `${LEAKAGE_MODEL.revShareRate * 100}%`, "recovered margin only · model " + LEAKAGE_MODEL.version],
          ] as Array<[string, string, string]>
        ).map(([label, value, body]) => (
          <div key={label} className="neu rounded-lg px-4 py-3">
            <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-[#8E9194]">{label}</p>
            <p className="mt-1 font-display text-[19px] font-semibold leading-none tracking-[-0.03em] text-[#F4F5F2]">{value}</p>
            <p className="mt-1 text-[10.5px] leading-snug text-[#6E736E]">{body}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
