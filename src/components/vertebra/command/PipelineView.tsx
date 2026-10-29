/**
 * PIPELINE — the operator's home deck. Frictionless by doctrine:
 *
 *  · Keyboard-first triage — j/k walks the gate, a approves, x discards,
 *    e edits in place, Enter opens the dossier, space batch-selects.
 *    The cursor row auto-expands: navigation IS reading.
 *  · Bulk bar — select several (or sweep everything ≥85% confidence in
 *    one verb) and triage the whole shelf in one motion.
 *  · Honest delivery — approved drafts surface sent vs staged straight
 *    from the reviewer note; the console never claims delivery it
 *    cannot prove.
 *  · Sequences are operable — Channel A runs its tick from here and
 *    shows the next due dispatches with countdowns; Channel B exports
 *    to the Josias queue in one verb.
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chip, EmptyHint, PillButton, SectionLabel, SoftCard } from "./bits";
import { INTENT_LABELS, money, relTime, type CommandSnapshot, type ReplyIntent, type TriageItem } from "@/lib/vertebra/command";
import {
  BULK_CONFIDENCE_THRESHOLD,
  PIPELINE_FILTERS,
  TRIAGE_SORTS,
  bulkPartition,
  countdownUntil,
  deliveryOf,
  matchPipelineFilter,
  nextCursorIdx,
  sortTriage,
  type PipelineFilter,
  type TriageSort,
} from "@/lib/vertebra/pipeline";

export interface TriageEdits {
  subject?: string;
  body?: string;
}

/** Funnel collapse preference — the operator's density choice survives reloads. */
const FUNNEL_KEY = "vertebra:pipeline-funnel";

export function PipelineView({
  snap,
  now,
  onOpenDossierId,
  onTriage,
  onBulkTriage,
  onRunTick,
  onExportHighTouch,
  suspended = false,
  focusReplyId = null,
  onFocusConsumed,
  onCursorMeta,
}: {
  snap: CommandSnapshot;
  now: number;
  onOpenDossierId: (prospectId: string) => void;
  onTriage: (draftId: string, decision: "approved" | "discarded", edits?: TriageEdits) => Promise<unknown>;
  onBulkTriage: (decisions: Array<{ draftId: string; decision: "approved" | "discarded" }>, label: string) => Promise<void>;
  onRunTick: () => Promise<void>;
  onExportHighTouch: (prospectId: string) => Promise<void>;
  /** True while the dossier / palette / grammar overlay holds the keyboard. */
  suspended?: boolean;
  /** Palette deep-link — the reply the operator jumped to. */
  focusReplyId?: string | null;
  onFocusConsumed?: () => void;
  /** Header readout — reports the gate cursor for the "gate 02/09 — name" line. */
  onCursorMeta?: (meta: { name: string; idx: number; total: number } | null) => void;
}) {
  const [tab, setTab] = useState<"triage" | "sequences">("triage");
  const [filter, setFilter] = useState<PipelineFilter>("all");
  const [sort, setSort] = useState<TriageSort>("newest");
  const [cursorIdx, setCursorIdx] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [manualOpen, setManualOpen] = useState<Set<string>>(new Set());
  const [editingReplyId, setEditingReplyId] = useState<string | null>(null);
  const [editSubject, setEditSubject] = useState("");
  const [editBody, setEditBody] = useState("");
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [funnelOpen, setFunnelOpen] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem(FUNNEL_KEY) !== "collapsed";
  });
  const subjectInputRef = useRef<HTMLInputElement | null>(null);
  const maxCount = Math.max(1, ...snap.funnel.map((f) => f.count));

  // Derived queue — filter → sort, then clamp the cursor.
  const pending = useMemo(
    () => sortTriage(snap.triage.pending.filter((i) => matchPipelineFilter(i, filter)), sort),
    [snap.triage.pending, filter, sort],
  );
  const cursor = pending.length ? Math.min(cursorIdx, pending.length - 1) : -1;
  const cursorItem = cursor >= 0 ? pending[cursor] : null;
  const { confident } = useMemo(() => bulkPartition(pending), [pending]);
  const selectedItems = useMemo(
    () => pending.filter((i) => selected.has(i.replyId) && i.draftId != null),
    [pending, selected],
  );

  const openEditor = useCallback((item: TriageItem) => {
    setEditingReplyId(item.replyId);
    setEditSubject(item.draftSubject ?? "");
    setEditBody(item.draftBody ?? "");
  }, []);

  const closeEditor = useCallback(() => setEditingReplyId(null), []);

  // Editor open → focus the subject line immediately.
  useEffect(() => {
    if (editingReplyId) subjectInputRef.current?.focus();
  }, [editingReplyId]);

  // Palette deep-link: land the cursor on the exact draft and open it.
  useEffect(() => {
    if (!focusReplyId) return;
    const idx = pending.findIndex((i) => i.replyId === focusReplyId);
    if (idx >= 0) {
      setTab("triage");
      setCursorIdx(idx);
      setManualOpen((prev) => new Set(prev).add(focusReplyId));
    }
    onFocusConsumed?.();
  }, [focusReplyId, pending, onFocusConsumed]);

  // Filter or sort change → cursor back to the top (predictable landing).
  useEffect(() => setCursorIdx(0), [filter, sort]);

  const toggleFunnel = useCallback(() => {
    setFunnelOpen((o) => {
      const next = !o;
      try {
        window.localStorage.setItem(FUNNEL_KEY, next ? "open" : "collapsed");
      } catch {
        /* storage unavailable — preference is best-effort */
      }
      return next;
    });
  }, []);

  // Gate cursor → header readout (mirrors strike's cursor line).
  useEffect(() => {
    onCursorMeta?.(cursorItem ? { name: cursorItem.prospectName, idx: cursor + 1, total: pending.length } : null);
  }, [cursorItem, cursor, pending.length, onCursorMeta]);

  const toggleSelect = useCallback((replyId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(replyId)) next.delete(replyId);
      else next.add(replyId);
      return next;
    });
  }, []);

  const act = useCallback(
    async (item: TriageItem, decision: "approved" | "discarded", edits?: TriageEdits) => {
      if (!item.draftId) return;
      setBusy((prev) => new Set(prev).add(item.replyId));
      try {
        await onTriage(item.draftId, decision, edits);
        setSelected((prev) => {
          const next = new Set(prev);
          next.delete(item.replyId);
          return next;
        });
        setEditingReplyId(null);
      } finally {
        setBusy((prev) => {
          const next = new Set(prev);
          next.delete(item.replyId);
          return next;
        });
      }
    },
    [onTriage],
  );

  const cycleFilter = useCallback(() => {
    setFilter((f) => PIPELINE_FILTERS[(PIPELINE_FILTERS.findIndex(([k]) => k === f) + 1) % PIPELINE_FILTERS.length][0]);
  }, []);

  // ---- keyboard loop — pipeline-scoped grammar (TheatreView pattern) ----- //
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (suspended) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (tab !== "triage") return;

      if (e.key === "j" || e.key === "k") {
        e.preventDefault();
        setCursorIdx((c) => nextCursorIdx(c, pending.length, e.key as "j" | "k"));
      } else if (e.key === "Enter" && cursorItem?.prospectId) {
        e.preventDefault();
        onOpenDossierId(cursorItem.prospectId);
      } else if (e.key === "a" && cursorItem?.draftId) {
        e.preventDefault();
        void act(cursorItem, "approved");
      } else if (e.key === "x" && cursorItem?.draftId) {
        e.preventDefault();
        void act(cursorItem, "discarded");
      } else if (e.key === "e" && cursorItem) {
        e.preventDefault();
        openEditor(cursorItem);
      } else if (e.key === " ") {
        if (cursorItem) {
          e.preventDefault();
          toggleSelect(cursorItem.replyId);
        }
      } else if (e.key === "f") {
        e.preventDefault();
        cycleFilter();
      } else if (e.key === "Escape" && (editingReplyId || selected.size > 0)) {
        e.preventDefault();
        setEditingReplyId(null);
        setSelected(new Set());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [suspended, tab, pending.length, cursorItem, editingReplyId, selected.size, act, onOpenDossierId, openEditor, toggleSelect, cycleFilter]);

  // Cursor walk scrolls the row into view.
  useEffect(() => {
    if (cursor < 0) return;
    const row = document.querySelector(`[data-triage-row="${pending[cursor]?.replyId}"]`);
    row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [cursor, pending]);

  return (
    <div className="flex h-full flex-col overflow-y-auto cc-scroll p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <SectionLabel>Pipeline — the machine, zoomed out</SectionLabel>
          <p className="mt-2 font-display text-[22px] font-semibold tracking-[-0.03em] text-[#F4F5F2]">
            {snap.triage.pending.length} drafts at the human gate · {money(snap.funnel[0]?.leakageUsd ?? 0)} leakage exposed
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={toggleFunnel}
            aria-label={funnelOpen ? "Collapse funnel strip" : "Expand funnel strip"}
            className="h-8 rounded-full border border-white/[0.12] bg-[#131513] px-3.5 font-mono text-[10.5px] uppercase tracking-[0.12em] text-[#8E9194] transition-all hover:text-[#F4F5F2]"
          >
            funnel {funnelOpen ? "▾" : "▸"}
          </button>
          {(
            [
              ["triage", `Triage · ${snap.triage.pending.length}`],
              ["sequences", "Sequences"],
            ] as Array<["triage" | "sequences", string]>
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`h-8 rounded-full px-3.5 font-mono text-[10.5px] uppercase tracking-[0.12em] transition-all ${
                tab === key
                  ? "bg-[#F4F5F2] text-[#0B0C0B]"
                  : "border border-white/[0.12] bg-[#131513] text-[#8E9194] hover:text-[#F4F5F2]"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Funnel — full cards when open, one honest line when collapsed */}
      {funnelOpen ? (
        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7">
          {snap.funnel.map((stage) => (
            <SoftCard key={stage.stage} className="px-4 py-3.5">
              <p className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-[#8E9194]">{stage.label}</p>
              <p className="mt-1.5 font-display text-[24px] font-semibold leading-none tracking-[-0.03em] tabular-nums text-[#F4F5F2]">{stage.count}</p>
              <div className="mt-2.5 h-[3px] w-full overflow-hidden rounded-full bg-[#232623]">
                <div className="h-full rounded-full bg-[#F4F5F2]" style={{ width: `${Math.max(6, (stage.count / maxCount) * 100)}%` }} />
              </div>
              <p className="mt-2 font-mono text-[10.5px] tabular-nums text-[#8E9194]">{money(stage.leakageUsd)} exposed</p>
            </SoftCard>
          ))}
        </div>
      ) : (
        <p className="mt-4 truncate font-mono text-[10px] uppercase tracking-[0.12em] text-[#6E736E]">
          {snap.funnel.map((s) => `${s.label} ${s.count}`).join(" · ")}
        </p>
      )}

      {tab === "triage" ? (
        <div className="mt-5 grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
          {/* ------------------------------------------------ gate inbox -- */}
          <section className="flex min-w-0 flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <SectionLabel>Drafts pending review — tier 2 · human gate</SectionLabel>
              <span className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-[#5F6460]">
                j/k move · a approve · x discard · e edit · ⏎ dossier · space select · f filter
              </span>
            </div>

            {/* toolbar — filters + sorts */}
            <div className="flex flex-wrap items-center gap-1.5">
              {PIPELINE_FILTERS.map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setFilter(key)}
                  className={`h-7 rounded-full px-3 font-mono text-[10px] uppercase tracking-[0.12em] transition-all ${
                    filter === key
                      ? "bg-[#F4F5F2] text-[#0B0C0B]"
                      : "border border-white/[0.10] bg-[#131513] text-[#8E9194] hover:text-[#F4F5F2]"
                  }`}
                >
                  {label}
                  <span className="ml-1.5 tabular-nums opacity-60">
                    {key === "all" ? pendingAllCount(snap) : key === "interested" ? pendingFamilyCount(snap, "interested") : pendingFamilyCount(snap, "objection")}
                  </span>
                </button>
              ))}
              <span className="mx-1 h-4 w-px bg-white/10" aria-hidden />
              {TRIAGE_SORTS.map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setSort(key)}
                  className={`h-7 rounded-full px-3 font-mono text-[10px] uppercase tracking-[0.12em] transition-all ${
                    sort === key
                      ? "bg-[#1A1D1A] text-[#F4F5F2] border border-white/25"
                      : "border border-transparent text-[#5F6460] hover:text-[#8E9194]"
                  }`}
                >
                  {label}
                </button>
              ))}
              {confident.length > 0 && (
                <PillButton
                  tone="well"
                  className="ml-auto h-7"
                  onClick={() =>
                    void onBulkTriage(
                      confident.filter((i) => i.draftId).map((i) => ({ draftId: i.draftId as string, decision: "approved" as const })),
                      `${confident.length} high-confidence draft${confident.length === 1 ? "" : "s"} (≥${Math.round(BULK_CONFIDENCE_THRESHOLD * 100)}% conf)`,
                    )
                  }
                >
                  Approve {confident.length} high-conf
                </PillButton>
              )}
            </div>

            {/* bulk bar — appears the moment anything is selected */}
            {selectedItems.length > 0 && (
              <div className="cc-rise sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-lg border border-white/[0.16] bg-[#1A1D1A] px-4 py-2.5 shadow-[0_12px_40px_rgba(0,0,0,0.45)]">
                <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-[#F4F5F2]">{selectedItems.length} selected</span>
                <span className="mx-1 h-4 w-px bg-white/10" aria-hidden />
                <PillButton
                  tone="dark"
                  className="h-7"
                  onClick={() =>
                    void onBulkTriage(
                      selectedItems.map((i) => ({ draftId: i.draftId as string, decision: "approved" as const })),
                      `${selectedItems.length} selected draft${selectedItems.length === 1 ? "" : "s"}`,
                    )
                  }
                >
                  Approve &amp; send
                </PillButton>
                <PillButton
                  tone="ghost"
                  className="h-7"
                  onClick={() =>
                    void onBulkTriage(
                      selectedItems.map((i) => ({ draftId: i.draftId as string, decision: "discarded" as const })),
                      `${selectedItems.length} selected draft${selectedItems.length === 1 ? "" : "s"}`,
                    )
                  }
                >
                  Discard
                </PillButton>
                <button
                  onClick={() => setSelected(new Set())}
                  className="ml-auto font-mono text-[10px] uppercase tracking-[0.14em] text-[#6E736E] transition-colors hover:text-[#F4F5F2]"
                >
                  esc · clear
                </button>
              </div>
            )}

            {pending.length === 0 && (
              <EmptyHint>{filter === "all" ? "Agent queue clear — every judgment call is yours" : `No ${filter === "objection" ? "objections" : "interested replies"} at the gate`}</EmptyHint>
            )}
            {pending.map((item, idx) => (
              <TriageRow
                key={item.replyId}
                item={item}
                idx={idx}
                total={pending.length}
                now={now}
                expanded={idx === cursor || selected.has(item.replyId) || manualOpen.has(item.replyId) || editingReplyId === item.replyId}
                selected={selected.has(item.replyId)}
                editing={editingReplyId === item.replyId}
                busy={busy.has(item.replyId)}
                editSubject={editSubject}
                editBody={editBody}
                subjectInputRef={editingReplyId === item.replyId ? subjectInputRef : undefined}
                onCursor={() => setCursorIdx(idx)}
                onToggleExpand={() =>
                  setManualOpen((prev) => {
                    const next = new Set(prev);
                    if (next.has(item.replyId)) next.delete(item.replyId);
                    else next.add(item.replyId);
                    return next;
                  })
                }
                onToggleSelect={() => toggleSelect(item.replyId)}
                onOpenDossierId={onOpenDossierId}
                onApprove={() => void act(item, "approved")}
                onDiscard={() => void act(item, "discarded")}
                onEdit={() => openEditor(item)}
                onEditChange={(field, value) => (field === "subject" ? setEditSubject(value) : setEditBody(value))}
                onEditSubmit={() =>
                  void act(item, "approved", {
                    subject: editSubject.trim() || undefined,
                    body: editBody.trim() || undefined,
                  })
                }
                onEditCancel={closeEditor}
              />
            ))}
          </section>

          {/* --------------------------------------- resolved side rail -- */}
          <section className="flex min-w-0 flex-col gap-3">
            <SectionLabel>Auto-resolved — tier 1 autonomy</SectionLabel>
            {snap.triage.auto.length === 0 && <EmptyHint>No autonomous resolutions yet</EmptyHint>}
            {snap.triage.auto.map((item) => (
              <SoftCard key={item.replyId} className="cc-rise px-5 py-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-[13.5px] font-medium text-[#E9EBE7]">{item.prospectName}</p>
                    <p className="mt-0.5 font-mono text-[10.5px] uppercase tracking-[0.1em] text-[#8E9194]">
                      {INTENT_LABELS[item.intent as ReplyIntent] ?? item.intent} · {item.draftStatus?.replace(/_/g, " ") ?? "no draft"}
                    </p>
                  </div>
                  <span className="shrink-0 font-mono text-[10px] tabular-nums text-[#6E736E]">{relTime(item.receivedAtMs, now)}</span>
                </div>
                {item.rescheduledToMs && (
                  <p className="mt-1.5 font-mono text-[10.5px] text-[#8E9194]">sequence pushed to {new Date(item.rescheduledToMs).toLocaleDateString()}</p>
                )}
              </SoftCard>
            ))}

            {snap.triage.closed.length > 0 && (
              <>
                <SectionLabel className="mt-2">Closed — your calls</SectionLabel>
                {snap.triage.closed.map((item) => {
                  const delivery = deliveryOf(item.draftStatus, item.reviewerNote);
                  return (
                    <SoftCard key={item.replyId} className="px-5 py-3 opacity-70">
                      <div className="flex items-center justify-between gap-3">
                        <p className="min-w-0 truncate text-[12.5px] text-[#8E9194]">{item.prospectName}</p>
                        <div className="flex shrink-0 items-center gap-1.5">
                          {delivery === "sent" && <Chip tone="raised">sent</Chip>}
                          {delivery === "staged" && <Chip tone="outline">staged</Chip>}
                          {delivery === "none" && item.draftStatus && <Chip tone="well">{item.draftStatus.replace(/_/g, " ")}</Chip>}
                          <span className="font-mono text-[9.5px] tabular-nums text-[#5F6460]">{relTime(item.sentAtMs ?? item.receivedAtMs, now)}</span>
                        </div>
                      </div>
                    </SoftCard>
                  );
                })}
              </>
            )}
          </section>
        </div>
      ) : (
        <SequencesTab snap={snap} now={now} onOpenDossierId={onOpenDossierId} onRunTick={onRunTick} onExportHighTouch={onExportHighTouch} />
      )}
    </div>
  );
}

// --------------------------------------------------------------------------- //
// Triage row — collapsed scan line, expanded full judgment surface
// --------------------------------------------------------------------------- //

function TriageRow({
  item,
  idx,
  total,
  now,
  expanded,
  selected,
  editing,
  busy,
  editSubject,
  editBody,
  subjectInputRef,
  onCursor,
  onToggleExpand,
  onToggleSelect,
  onOpenDossierId,
  onApprove,
  onDiscard,
  onEdit,
  onEditChange,
  onEditSubmit,
  onEditCancel,
}: {
  item: TriageItem;
  idx: number;
  total: number;
  now: number;
  expanded: boolean;
  selected: boolean;
  editing: boolean;
  busy: boolean;
  editSubject: string;
  editBody: string;
  subjectInputRef?: React.RefObject<HTMLInputElement | null>;
  onCursor: () => void;
  onToggleExpand: () => void;
  onToggleSelect: () => void;
  onOpenDossierId: (id: string) => void;
  onApprove: () => void;
  onDiscard: () => void;
  onEdit: () => void;
  onEditChange: (field: "subject" | "body", value: string) => void;
  onEditSubmit: () => void;
  onEditCancel: () => void;
}) {
  const context = [item.city ?? null, item.region ?? null].filter(Boolean).join(", ");
  return (
    <div
      data-triage-row={item.replyId}
      className={`cc-rise rounded-lg border transition-colors ${
        expanded ? "border-white/[0.18] bg-[#131513]" : "border-white/[0.07] bg-[#0E100E] hover:border-white/[0.14]"
      } ${selected ? "ring-1 ring-white/30" : ""}`}
    >
      {/* scan line — one row, everything needed to route attention */}
      <div className="flex cursor-default items-center gap-3 px-4 py-3" onClick={onCursor}>
        <button
          aria-label={selected ? "Deselect draft" : "Select draft"}
          aria-pressed={selected}
          onClick={(e) => {
            e.stopPropagation();
            onToggleSelect();
          }}
          className={`flex size-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors ${
            selected ? "border-[#F4F5F2] bg-[#F4F5F2] text-[#0B0C0B]" : "border-white/25 bg-transparent hover:border-white/50"
          }`}
        >
          {selected && (
            <svg viewBox="0 0 10 10" className="size-2.5" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M1.5 5.2 4 7.7 8.5 2.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>
        <span aria-hidden className={`w-1 shrink-0 self-stretch rounded-full ${expanded ? "bg-[#F4F5F2]" : "bg-transparent"}`} />
        <button onClick={() => onOpenDossierId(item.prospectId)} className="min-w-0 shrink-0 truncate font-display text-[14px] font-semibold tracking-[-0.01em] text-[#F4F5F2] hover:underline">
          {item.prospectName}
        </button>
        <Chip tone={item.intent === "interested" ? "inverted" : "raised"}>{INTENT_LABELS[item.intent as ReplyIntent] ?? item.intent}</Chip>
        {item.confidence != null && <Chip tone="outline">conf {Math.round(item.confidence * 100)}%</Chip>}
        {item.qlvScore != null && <Chip tone="well">QLV {item.qlvScore}</Chip>}
        {item.draftCount > 1 && <Chip tone="well">×{item.draftCount} drafts</Chip>}
        <span className="ml-auto hidden shrink-0 font-mono text-[10px] tabular-nums text-[#5F6460] md:inline" aria-hidden>
          {idx + 1}/{total}
        </span>
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-[#6E736E]">{relTime(item.receivedAtMs, now)}</span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleExpand();
          }}
          aria-label={expanded ? "Collapse row" : "Expand row"}
          className="shrink-0 font-mono text-[10px] text-[#5F6460] transition-colors hover:text-[#F4F5F2]"
        >
          {expanded ? "▾" : "▸"}
        </button>
      </div>

      {!expanded && (
        <p className="truncate px-4 pb-3 pl-[68px] text-[12px] text-[#5F6460]">
          {item.subject || "(no subject)"} — {item.body}
        </p>
      )}

      {expanded && (
        <div className="px-4 pb-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-[#6E736E]">
            {[
              item.fromEmail,
              context || null,
              item.erpName ? `ERP ${item.erpName}` : null,
              item.leakageUsd != null ? `${money(item.leakageUsd)} leakage` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>

          {/* inbound — pressed well */}
          <div className="neu-well mt-2.5 rounded-lg px-4 py-3">
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#8E9194]">inbound</p>
            <p className="mt-1 text-[13px] text-[#E9EBE7]">{item.subject || "(no subject)"}</p>
            <p className="mt-1.5 whitespace-pre-line text-[12.5px] leading-relaxed text-[#8E9194]">{item.body}</p>
          </div>

          {/* agent draft — editor when editing, machine voice otherwise */}
          {editing ? (
            <div className="ink mt-2.5 rounded-lg px-4 py-3.5">
              <div className="flex items-center justify-between">
                <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/70">editing agent draft</p>
                <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-white/55">⌘⏎ save &amp; send · esc cancel</span>
              </div>
              <input
                ref={subjectInputRef}
                value={editSubject}
                onChange={(e) => onEditChange("subject", e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    onEditSubmit();
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    onEditCancel();
                  }
                }}
                aria-label="Draft subject"
                placeholder="Subject"
                className="mt-2.5 w-full rounded-md border border-white/20 bg-black/30 px-3 py-2 text-[13px] text-white outline-none placeholder:text-white/40 focus:border-white/50"
              />
              <textarea
                value={editBody}
                onChange={(e) => onEditChange("body", e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    onEditSubmit();
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    onEditCancel();
                  }
                }}
                aria-label="Draft body"
                placeholder="Body"
                rows={7}
                className="mt-2 w-full resize-y rounded-md border border-white/20 bg-black/30 px-3 py-2 text-[12.5px] leading-relaxed text-white/95 outline-none placeholder:text-white/40 focus:border-white/50"
              />
            </div>
          ) : (
            item.draftBody && (
              <div className="ink mt-2.5 rounded-lg px-4 py-3.5">
                <div className="flex items-center justify-between">
                  <p className="truncate font-mono text-[10px] uppercase tracking-[0.14em] text-white/70">agent draft — {item.draftSubject}</p>
                  <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.14em] text-white/55">langgraph · reply agent</span>
                </div>
                <p className="mt-1.5 whitespace-pre-line text-[12.5px] leading-relaxed text-white/95">{item.draftBody}</p>
              </div>
            )
          )}
          {item.rationale && <p className="mt-2 text-[11.5px] italic leading-relaxed text-[#6E736E]">{item.rationale}</p>}

          <div className="mt-3.5 flex flex-wrap gap-2">
            {editing ? (
              <>
                <PillButton tone="dark" onClick={onEditSubmit} disabled={busy}>
                  Save &amp; send
                </PillButton>
                <PillButton tone="ghost" onClick={onEditCancel}>
                  Cancel
                </PillButton>
              </>
            ) : (
              <>
                <PillButton tone="dark" onClick={onApprove} disabled={!item.draftId || busy}>
                  Approve &amp; send
                </PillButton>
                <PillButton tone="well" onClick={onEdit} disabled={!item.draftBody || busy}>
                  Edit
                </PillButton>
                <PillButton tone="ghost" onClick={onDiscard} disabled={!item.draftId || busy}>
                  Discard
                </PillButton>
                <span className="ml-auto hidden font-mono text-[9.5px] uppercase tracking-[0.12em] text-[#5F6460] sm:inline">
                  a · e · x
                </span>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------- //
// Sequences — Channel A operable, Channel B exportable
// --------------------------------------------------------------------------- //

function SequencesTab({
  snap,
  now,
  onOpenDossierId,
  onRunTick,
  onExportHighTouch,
}: {
  snap: CommandSnapshot;
  now: number;
  onOpenDossierId: (id: string) => void;
  onRunTick: () => Promise<void>;
  onExportHighTouch: (prospectId: string) => Promise<void>;
}) {
  const [ticking, setTicking] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);

  const channelACounts: Record<string, number> = {};
  for (const lead of snap.leads) {
    if (!lead.dispatch || lead.dispatch.channel !== "channel_a_automated_email") continue;
    channelACounts[lead.dispatch.status] = (channelACounts[lead.dispatch.status] ?? 0) + 1;
  }
  const nextDue = snap.leads
    .filter((l) => l.dispatch?.channel === "channel_a_automated_email" && l.dispatch.status === "queued" && l.dispatch.scheduledAtMs != null)
    .sort((a, b) => (a.dispatch?.scheduledAtMs ?? 0) - (b.dispatch?.scheduledAtMs ?? 0))
    .slice(0, 6);
  const highTouchRows = snap.leads
    .filter((l) => l.highTouch)
    .sort((a, b) => (b.highTouch?.qlvScore ?? 0) - (a.highTouch?.qlvScore ?? 0));
  const exportQueued = highTouchRows.filter((l) => !l.highTouch?.exportedAtMs);

  const runTick = async () => {
    setTicking(true);
    try {
      await onRunTick();
    } finally {
      setTicking(false);
    }
  };

  const exportOne = async (prospectId: string) => {
    setExporting(prospectId);
    try {
      await onExportHighTouch(prospectId);
    } finally {
      setExporting(null);
    }
  };

  return (
    <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
      {/* Channel A */}
      <SoftCard className="px-6 py-5">
        <div className="mb-3 flex items-center justify-between">
          <SectionLabel>Channel A — automated sequences</SectionLabel>
          <PillButton tone="dark" className="h-8" onClick={() => void runTick()} disabled={ticking}>
            {ticking ? "Running…" : "Run tick"}
          </PillButton>
        </div>
        <div className="flex flex-col gap-2.5">
          {Object.entries(channelACounts).map(([status, count]) => (
            <div key={status} className="flex items-center justify-between">
              <Chip tone={status === "sent" ? "raised" : "outline"}>{status}</Chip>
              <span className="font-mono text-[13px] tabular-nums text-[#E9EBE7]">{count}</span>
            </div>
          ))}
          {Object.keys(channelACounts).length === 0 && <EmptyHint>No channel A dispatch rows</EmptyHint>}
        </div>
        {nextDue.length > 0 && (
          <div className="mt-4 border-t border-white/[0.08] pt-3">
            <p className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-[#5F6460]">next due</p>
            <div className="mt-2 flex flex-col gap-1.5">
              {nextDue.map((l) => (
                <div key={l.id} className="flex items-center justify-between gap-3">
                  <button onClick={() => onOpenDossierId(l.id)} className="min-w-0 truncate text-left text-[12.5px] text-[#C9CCC7] hover:text-[#F4F5F2] hover:underline">
                    {l.name}
                  </button>
                  <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-[#8E9194]">
                    {countdownUntil(l.dispatch?.scheduledAtMs ?? null, now)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
        <p className="mt-4 border-t border-white/[0.08] pt-3 text-[12px] leading-relaxed text-[#8E9194]">
          {snap.ops.channelACount} sequence rows total · {snap.ops.dispatchesSent24h} touched in the last 24h. Outbox:{" "}
          {snap.ops.outboxPending} pending / {snap.ops.outboxPublished} published.
        </p>
      </SoftCard>

      {/* Channel B */}
      <SoftCard className="px-6 py-5">
        <div className="mb-3 flex items-center justify-between">
          <SectionLabel>Channel B — Josias high-touch queue</SectionLabel>
          {exportQueued.length > 1 && (
            <PillButton
              tone="well"
              className="h-8"
              onClick={() => {
                void (async () => {
                  for (const l of exportQueued) {
                    setExporting(l.id);
                    await onExportHighTouch(l.id);
                  }
                  setExporting(null);
                })();
              }}
            >
              Export all {exportQueued.length}
            </PillButton>
          )}
        </div>
        <div className="flex flex-col gap-2.5">
          {highTouchRows.map((l) => {
            const exported = Boolean(l.highTouch?.exportedAtMs);
            return (
              <div key={l.id} className="flex items-center justify-between gap-3 rounded-full border border-white/[0.12] bg-[#131513] px-4 py-2.5">
                <button onClick={() => onOpenDossierId(l.id)} className="min-w-0 truncate text-left text-[13px] text-[#E9EBE7] transition-colors hover:text-white">
                  {l.name}
                </button>
                <div className="flex shrink-0 items-center gap-2.5">
                  <span className="font-mono text-[11px] tabular-nums text-[#8E9194]">QLV {l.highTouch?.qlvScore}</span>
                  {exported ? (
                    <Chip tone="raised">exported</Chip>
                  ) : (
                    <PillButton tone="ghost" className="h-7" onClick={() => void exportOne(l.id)} disabled={exporting === l.id}>
                      {exporting === l.id ? "…" : "Export"}
                    </PillButton>
                  )}
                </div>
              </div>
            );
          })}
          {highTouchRows.length === 0 && <EmptyHint>No high-touch accounts queued</EmptyHint>}
        </div>
      </SoftCard>
    </div>
  );
}

// ---- filter-count helpers (full unfiltered queue, for the pill badges) ---- //

function pendingAllCount(snap: CommandSnapshot): number {
  return snap.triage.pending.length;
}

function pendingFamilyCount(snap: CommandSnapshot, family: "interested" | "objection"): number {
  return snap.triage.pending.filter((i) =>
    family === "interested" ? i.intent === "interested" : i.intent === "objection_price" || i.intent === "objection_erp",
  ).length;
}
