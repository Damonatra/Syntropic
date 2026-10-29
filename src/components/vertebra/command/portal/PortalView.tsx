/**
 * PORTAL — the Margin Defense Engagement Desk, one focus at a time.
 *
 * The landing page's executive portal closes the deal; this desk runs the
 * audit. The old layout crowded the operator — counters, queue and detail
 * all shouting at once — so the desk now holds exactly one view at a time:
 *
 *   desk   a quiet surface: one statement, one honest status line and three
 *          doors — ENGAGEMENT QUEUE, ENGAGEMENT, CLOSE LEDGER. Each door
 *          inverts to paper on hover or focus: the light floods in, the
 *          label goes dark. Disabled doors stay shut.
 *   queue  the sorted ledger of paid work; a row opens its engagement.
 *   engagement
 *          the full desk detail for the cursor's engagement.
 *   ledger the money room — guarantees cleared, rev-share basis, fees
 *          banked, and the delivered / SOW / closed rows behind them.
 *
 * Esc walks back out the way you came; nothing crowds anything. Keyboard
 * first: q toggles the queue door, e (or enter) opens the engagement under
 * the cursor, c opens the close ledger, j/k move the cursor, a advances the
 * selected engagement's stage, esc backs out.
 *
 * Selling happens on the landing page; the console only works. Every number
 * on the desk derives from the engagement ledger — never invented.
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Chip, HudMeta, SectionLabel } from "../bits";
import { DeskDetail } from "./DeskDetail";
import type { CommandSnapshot, EngagementShape } from "@/lib/vertebra/command";
import { LEAKAGE_MODEL } from "@/lib/vertebra/leakage";
import { nextActionFor, queueWeight, STAGE_LABELS, STAGE_TRANSITIONS, type EngagementStage } from "@/lib/vertebra/portal";

const usd = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;

const STAGE_ORDER: EngagementStage[] = ["paid", "intake", "forensics", "verdict", "delivered", "sow", "closed"];

type DeskView = "desk" | "queue" | "engagement" | "ledger";

/** Terminal stages sink; the rest sort by money-waiting × age × undecided-verdict. */
function sortQueue(queue: EngagementShape[], nowMs: number): EngagementShape[] {
  return [...queue].sort((a, b) => {
    const aDone = a.status === "closed" || a.status === "sow";
    const bDone = b.status === "closed" || b.status === "sow";
    if (aDone !== bDone) return aDone ? 1 : -1;
    return queueWeight(b, nowMs) - queueWeight(a, nowMs);
  });
}

/** Keyboard hint chip — the door's shortcut; inverts with the door. */
function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="door-kbd rounded border px-1.5 py-0.5 font-mono text-[8.5px] uppercase tracking-[0.08em]">
      {children}
    </kbd>
  );
}

/** The door's arrow — slides forward and goes dark as the light floods in. */
function DoorArrow() {
  return (
    <span aria-hidden className="door-arrow font-mono text-[13px]">
      →
    </span>
  );
}

/** Back out one level — always visible, always the same place. */
function BackBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2 rounded-lg border border-white/10 px-3 py-1.5 font-mono text-[9.5px] uppercase tracking-[0.14em] text-[#8E9194] transition-colors hover:border-white/30 hover:text-[#F4F5F2]"
    >
      <span aria-hidden>←</span> {label} <span className="text-[#5F6460]">esc</span>
    </button>
  );
}

export function PortalView({ snap, refresh }: { snap: CommandSnapshot; refresh: () => Promise<void> }) {
  const engagements = useMemo(() => snap.engagements ?? [], [snap.engagements]);
  const nowMs = snap.generatedAtMs || Date.now();
  const queue = useMemo(() => sortQueue(engagements, nowMs), [engagements, nowMs]);

  const [view, setView] = useState<DeskView>("desk");
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
        // Commitment point — advancing to `delivered` generates the audit
        // deliverable first (verdict gate enforced server-side), then moves
        // the stage. One button, both writes, the ledger records each.
        if (body.op === "stage" && body.to === "delivered" && !selected.deliverableUrl) {
          const dres = await fetch(`/api/portal/engagements/${selected.id}/deliver`, { method: "POST" });
          if (!dres.ok) {
            const detail = (await dres.json().catch(() => ({}))) as { error?: string; hint?: string };
            setError(detail.hint ?? detail.error ?? `deliver_${dres.status}`);
            return false;
          }
        }
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

  // ---- keyboard flow — one focus at a time -------------------------------- //
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // esc walks back out: engagement → queue → desk (ledger → desk).
      if (e.key === "Escape") {
        e.preventDefault();
        setView((v) => (v === "engagement" ? "queue" : "desk"));
        return;
      }
      // q toggles the queue door from the desk; from the engagement it leads out.
      if (e.key === "q") {
        e.preventDefault();
        setView((v) => (v === "queue" ? "desk" : "queue"));
        return;
      }
      // c — the money room, from anywhere.
      if (e.key === "c") {
        e.preventDefault();
        setView("ledger");
        return;
      }
      if (queue.length === 0) return;
      const idx = queue.findIndex((x) => x.id === cursorId);

      // e / enter — open the engagement under the cursor (never from inside it).
      if (view !== "engagement" && (e.key === "e" || e.key === "Enter")) {
        e.preventDefault();
        if (queue[Math.max(0, idx)]) setView("engagement");
        return;
      }
      // j / k move the cursor wherever the list is not hidden behind the detail.
      if (view !== "engagement" && (e.key === "j" || e.key === "ArrowDown")) {
        e.preventDefault();
        const next = queue[Math.min(queue.length - 1, idx + 1)];
        if (next) {
          setCursorId(next.id);
          queueRefs.current.get(next.id)?.scrollIntoView({ block: "nearest" });
        }
        return;
      }
      if (view !== "engagement" && (e.key === "k" || e.key === "ArrowUp")) {
        e.preventDefault();
        const prev = queue[Math.max(0, idx - 1)];
        if (prev) {
          setCursorId(prev.id);
          queueRefs.current.get(prev.id)?.scrollIntoView({ block: "nearest" });
        }
        return;
      }
      // a — advance the selected engagement one legal stage (working views only).
      if (view !== "desk" && view !== "ledger" && e.key === "a") {
        const cur = queue[idx];
        if (!cur) return;
        const idxCur = STAGE_ORDER.indexOf(cur.status as EngagementStage);
        const nextForward = (STAGE_TRANSITIONS[cur.status as EngagementStage] ?? [])
          .filter((s) => STAGE_ORDER.indexOf(s) > idxCur)
          .sort((x, y) => STAGE_ORDER.indexOf(x) - STAGE_ORDER.indexOf(y))[0];
        if (nextForward) void patch({ op: "stage", to: nextForward });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [queue, cursorId, view, patch]);

  // ---- desk readouts — honest, from the ledger ----------------------------- //
  const active = queue.filter((e) => e.status !== "closed" && e.status !== "sow");
  const underAudit = active.reduce((sum, e) => sum + e.amountUsd, 0);
  const undecided = queue.filter((e) => e.status === "verdict" && e.guaranteeCleared == null).length;
  const oldestPaidDays =
    active.length > 0 ? Math.max(...active.map((e) => Math.floor((nowMs - e.paidAtMs) / 86_400_000))) : 0;
  const cleared = queue.filter((e) => e.guaranteeCleared === true);
  const clearedUsd = cleared.reduce((sum, e) => sum + (e.confirmedLeakageUsd ?? 0), 0);
  const deliveredE = queue.filter((e) => e.status === "delivered");
  const sowE = queue.filter((e) => e.status === "sow");
  const closedE = queue.filter((e) => e.status === "closed");
  const deliveredUsd = deliveredE.reduce((sum, e) => sum + e.amountUsd, 0);
  const revShareBasis = clearedUsd * LEAKAGE_MODEL.revShareRate;

  const errorStrip = error ? (
    <p className="mx-auto w-full max-w-[780px] shrink-0 rounded-lg border border-white/20 bg-[#141614] px-4 py-2 font-mono text-[10.5px] uppercase tracking-[0.12em] text-[#FF8A7A]">
      {error}
    </p>
  ) : null;

  return (
    <div className="flex h-full flex-col overflow-hidden p-5">
      {/* ================= DESK — the quiet surface, three doors ============== */}
      {view === "desk" && (
        <>
          <div className="flex shrink-0 items-center justify-between">
            <SectionLabel>Margin Defense Desk</SectionLabel>
            <HudMeta node="AST-10" hash="e0a5" />
          </div>

          <div className="flex min-h-0 flex-1 items-center justify-center">
            <div className="w-full max-w-[620px] py-4">
              <p className="font-mono text-[9.5px] uppercase tracking-[0.24em] text-[#6E736E]">
                paid engagements · the audit desk
              </p>
              <h2 className="mt-3 font-display text-[30px] font-semibold leading-[1.05] tracking-[-0.035em] text-[#F4F5F2] sm:text-[36px]">
                Where money becomes work.
              </h2>
              <p className="mt-3 max-w-[500px] text-[12.5px] leading-relaxed text-[#8E9194]">
                The landing page closes the deal — this desk runs the audit. Three doors: the queue, the
                engagement, and the money the work returns.
              </p>

              {/* status line — live numbers, zero tiles */}
              <div className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-1.5 font-mono text-[9.5px] uppercase tracking-[0.16em] text-[#6E736E]">
                <span>
                  <span className="text-[#F4F5F2]">{active.length}</span> active
                </span>
                <span className="text-[#2E322E]">·</span>
                <span>
                  <span className="text-[#F4F5F2]">{usd(underAudit)}</span> under audit
                </span>
                <span className="text-[#2E322E]">·</span>
                <span>
                  <span className="text-[#F4F5F2]">{undecided}</span> verdict{undecided === 1 ? "" : "s"} undecided
                </span>
                <span className="text-[#2E322E]">·</span>
                <span>
                  oldest <span className="text-[#F4F5F2]">{oldestPaidDays}d</span>
                </span>
              </div>

              {/* the three doors — hover or focus and the light floods in */}
              <div className="mt-6 flex flex-col gap-3">
                <button
                  onClick={() => setView("queue")}
                  className="door flex items-center justify-between gap-4 px-6 py-5 text-left focus:outline-none"
                >
                  <span className="min-w-0">
                    <span className="block font-display text-[18px] font-semibold tracking-[-0.02em] text-[var(--door-title)] transition-colors duration-150">
                      Engagement Queue
                    </span>
                    <span className="mt-1 block truncate font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--door-meta)] transition-colors duration-150">
                      {queue.length} engagement{queue.length === 1 ? "" : "s"} · {usd(underAudit)} waiting ·
                      money-waiting × age
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-3">
                    <Kbd>Q</Kbd>
                    <DoorArrow />
                  </span>
                </button>

                <button
                  onClick={() => selected && setView("engagement")}
                  disabled={!selected}
                  className="door flex items-center justify-between gap-4 px-6 py-5 text-left focus:outline-none disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <span className="min-w-0">
                    <span className="block font-display text-[18px] font-semibold tracking-[-0.02em] text-[var(--door-title)] transition-colors duration-150">
                      Engagement
                    </span>
                    <span className="mt-1 block truncate font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--door-meta)] transition-colors duration-150">
                      {selected
                        ? `${selected.clientName} · ${STAGE_LABELS[selected.status as EngagementStage] ?? selected.status} — ${nextActionFor(selected).action}`
                        : "nothing on the cursor — open the queue"}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-3">
                    <Kbd>E</Kbd>
                    <DoorArrow />
                  </span>
                </button>

                <button
                  onClick={() => setView("ledger")}
                  className="door flex items-center justify-between gap-4 px-6 py-5 text-left focus:outline-none"
                >
                  <span className="min-w-0">
                    <span className="block font-display text-[18px] font-semibold tracking-[-0.02em] text-[var(--door-title)] transition-colors duration-150">
                      Close Ledger
                    </span>
                    <span className="mt-1 block truncate font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--door-meta)] transition-colors duration-150">
                      delivered {deliveredE.length} · sow {sowE.length} · closed {closedE.length} · rev-share basis{" "}
                      {usd(revShareBasis)}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-3">
                    <Kbd>C</Kbd>
                    <DoorArrow />
                  </span>
                </button>
              </div>

              <p className="mt-6 font-mono text-[8.5px] uppercase tracking-[0.2em] text-[#5F6460]">
                q queue · e engagement · c close ledger · j / k cursor · a advance stage · esc back
              </p>
            </div>
          </div>
        </>
      )}

      {/* ================= QUEUE — the ledger of paid work ==================== */}
      {view === "queue" && (
        <>
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-4">
              <BackBtn label="Desk" onClick={() => setView("desk")} />
              <SectionLabel>Engagement queue</SectionLabel>
            </div>
            <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-[#5F6460]">
              {queue.length} engagement{queue.length === 1 ? "" : "s"} · money-waiting × age
            </p>
          </div>

          {errorStrip && <div className="mt-3">{errorStrip}</div>}

          <div className="cc-scroll mx-auto mt-4 min-h-0 w-full max-w-[780px] flex-1 overflow-y-auto pb-2">
            {queue.length === 0 && (
              <div className="flex h-full min-h-[220px] flex-col items-center justify-center px-8 text-center">
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
                    setView("engagement");
                  }}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter" || ev.key === " ") {
                      ev.preventDefault();
                      setCursorId(e.id);
                      setView("engagement");
                    }
                  }}
                  className={`mb-2.5 cursor-pointer rounded-xl px-5 py-4 transition-all ${
                    isCursor ? "ink" : "neu hover:border-white/25"
                  } ${done ? "opacity-55" : ""}`}
                >
                  <div className="flex flex-wrap items-center gap-2.5">
                    <p
                      className={`font-display text-[16px] font-semibold tracking-[-0.02em] ${
                        isCursor ? "text-white" : "text-[#F4F5F2]"
                      }`}
                    >
                      {e.clientName}
                    </p>
                    <Chip tone={isCursor ? "inverted" : "raised"}>
                      {STAGE_LABELS[e.status as EngagementStage] ?? e.status}
                    </Chip>
                    {e.source === "portal_webhook" ? (
                      <Chip tone={isCursor ? "well" : "default"}>portal</Chip>
                    ) : (
                      <Chip tone={isCursor ? "well" : "default"}>manual</Chip>
                    )}
                    {!e.prospectName && e.status !== "closed" && <Chip tone={isCursor ? "well" : "default"}>unlinked</Chip>}
                    <p className="ml-auto font-display text-[17px] font-semibold tabular-nums text-[#F4F5F2]">
                      {usd(e.amountUsd)}
                    </p>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                    <p
                      className={`font-mono text-[10px] uppercase tracking-[0.1em] ${
                        isCursor ? "text-white/80" : "text-[#8E9194]"
                      }`}
                    >
                      ▸ {na.action}
                    </p>
                    <p className="font-mono text-[8.5px] uppercase tracking-[0.12em] text-[#5F6460]">
                      paid {Math.max(0, Math.floor((nowMs - e.paidAtMs) / 86_400_000))}d ago
                      {e.prospectName ? ` · ${e.prospectName}` : ""}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>

          <p className="shrink-0 pt-2 text-center font-mono text-[8.5px] uppercase tracking-[0.2em] text-[#5F6460]">
            j / k cursor · enter opens the engagement · esc back to the desk
          </p>
        </>
      )}

      {/* ================= CLOSE LEDGER — the money room ====================== */}
      {view === "ledger" && (
        <>
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-4">
              <BackBtn label="Desk" onClick={() => setView("desk")} />
              <SectionLabel>Close ledger</SectionLabel>
            </div>
            <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-[#5F6460]">
              live conversions · zero invented numbers
            </p>
          </div>

          <div className="cc-scroll mx-auto mt-4 min-h-0 w-full max-w-[780px] flex-1 overflow-y-auto pb-2">
            {/* summary — only what the ledger can prove */}
            <div className="neu-lg rounded-xl px-6 py-5">
              <p className="font-mono text-[9.5px] uppercase tracking-[0.2em] text-[#8E9194]">
                The money ledger — model {LEAKAGE_MODEL.version}
              </p>
              <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
                {(
                  [
                    ["guarantees cleared", `${cleared.length}`, `${usd(clearedUsd)} confirmed recoverable`],
                    [
                      "rev-share basis",
                      usd(revShareBasis),
                      `${Math.round(LEAKAGE_MODEL.revShareRate * 100)}% of confirmed leakage`,
                    ],
                    ["fees banked", usd(deliveredUsd), `${deliveredE.length} audit${deliveredE.length === 1 ? "" : "s"} delivered`],
                  ] as Array<[string, string, string]>
                ).map(([k, v, sub]) => (
                  <div key={k}>
                    <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-[#6E736E]">{k}</p>
                    <p className="mt-1 font-display text-[22px] font-semibold leading-none tracking-[-0.03em] tabular-nums text-[#F4F5F2]">
                      {v}
                    </p>
                    <p className="mt-1 font-mono text-[8.5px] uppercase tracking-[0.1em] text-[#5F6460]">{sub}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* conversion sections — each row traces to a real engagement */}
            {(
              [
                ["delivered — fee banked, deliverable sealed", deliveredE],
                ["sow — continuous margin defense live", sowE],
                ["closed — ledger sealed", closedE],
              ] as Array<[string, EngagementShape[]]>
            ).map(([label, rows]) =>
              rows.length > 0 ? (
                <div key={label} className="mt-5">
                  <p className="px-1 font-mono text-[9px] uppercase tracking-[0.18em] text-[#6E736E]">{label}</p>
                  <div className="mt-2">
                    {rows.map((e) => (
                      <div
                        key={e.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => {
                          setCursorId(e.id);
                          setView("engagement");
                        }}
                        onKeyDown={(ev) => {
                          if (ev.key === "Enter" || ev.key === " ") {
                            ev.preventDefault();
                            setCursorId(e.id);
                            setView("engagement");
                          }
                        }}
                        className="neu mb-2 cursor-pointer rounded-xl px-5 py-4 transition-all hover:border-white/25"
                      >
                        <div className="flex flex-wrap items-center gap-2.5">
                          <p className="font-display text-[15.5px] font-semibold tracking-[-0.02em] text-[#F4F5F2]">
                            {e.clientName}
                          </p>
                          <Chip tone="raised">{STAGE_LABELS[e.status as EngagementStage] ?? e.status}</Chip>
                          <p className="ml-auto font-display text-[16px] font-semibold tabular-nums text-[#F4F5F2]">
                            {usd(e.amountUsd)}
                          </p>
                        </div>
                        <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
                          <p className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-[#8E9194]">
                            {e.status === "delivered"
                              ? `fee banked${e.deliveredAtMs ? ` · delivered ${Math.max(0, Math.floor((nowMs - e.deliveredAtMs) / 86_400_000))}d ago` : ""}`
                              : e.status === "sow"
                                ? `recovery ops live${e.prospectName ? ` · ${e.prospectName}` : ""}`
                                : "guarantee honored · ledger sealed"}
                          </p>
                          {e.deliverableUrl && (
                            <a
                              href={e.deliverableUrl}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(ev) => ev.stopPropagation()}
                              className="font-mono text-[9px] uppercase tracking-[0.14em] text-[#8E9194] underline decoration-white/20 underline-offset-4 transition-colors hover:text-[#F4F5F2]"
                            >
                              deliverable ↗
                            </a>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null,
            )}

            {deliveredE.length === 0 && sowE.length === 0 && closedE.length === 0 && (
              <div className="mt-6 flex flex-col items-center justify-center px-8 text-center">
                <p className="font-display text-[15px] font-semibold text-[#F4F5F2]">Nothing delivered yet</p>
                <p className="mt-1.5 font-mono text-[10px] uppercase leading-relaxed tracking-[0.12em] text-[#5F6460]">
                  the desk works the queue — conversions land here the moment an audit leaves the building
                </p>
              </div>
            )}
          </div>

          <p className="shrink-0 pt-2 text-center font-mono text-[8.5px] uppercase tracking-[0.2em] text-[#5F6460]">
            rows open the engagement · esc back to the desk
          </p>
        </>
      )}

      {/* ================= ENGAGEMENT — one client, full depth ================ */}
      {view === "engagement" && (
        <>
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-4">
              <BackBtn label="Queue" onClick={() => setView("queue")} />
              {selected && (
                <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-[#5F6460]">
                  {selected.ref} · {STAGE_LABELS[selected.status as EngagementStage] ?? selected.status}
                </p>
              )}
            </div>
            <p className="hidden font-mono text-[8.5px] uppercase tracking-[0.2em] text-[#5F6460] sm:block">
              a advance stage · esc back
            </p>
          </div>

          {errorStrip && <div className="mt-3">{errorStrip}</div>}

          <div className="mt-3 min-h-0 flex-1">
            <div className="mx-auto h-full max-w-[900px]">
              {selected ? (
                <DeskDetail
                  engagement={selected}
                  onPatch={patch}
                  busy={busy}
                  nowMs={nowMs}
                  prospect={snap.leads.find((l) => l.id === selected.prospectId) ?? null}
                  refresh={refresh}
                />
              ) : (
                <div className="neu-lg flex h-full items-center justify-center rounded-lg">
                  <p className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-[#5F6460]">
                    no engagement on the cursor — esc to the queue
                  </p>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
