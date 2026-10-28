/**
 * Command Centre root — the 1-of-1 operator cockpit.
 *
 * Owns: snapshot state, socket bridge fan-out, the keyboard loop,
 * high-intent alert toasts + chime, dossier drawer, command palette.
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { CommandRail, type ViewKey } from "./CommandRail";
import { RadarView } from "./RadarView";
import { StrikeView, computeRanked, type StrikeFilter } from "./StrikeView";
import { TheatreView } from "./TheatreView";
import { PipelineView } from "./PipelineView";
import { OpsView } from "./OpsView";
import { DossierDrawer } from "./DossierDrawer";
import { LiveDot, SectionLabel } from "./bits";
import { chime } from "@/lib/vertebra/chime";
import {
  INTENT_LABELS,
  effectivePriority,
  isHighSignal,
  relTime,
  type CommandLead,
  type CommandSnapshot,
} from "@/lib/vertebra/command";

interface TelemetryPush {
  event: {
    id: string;
    prospectId: string;
    prospectName: string;
    qlvScore: number | null;
    eventType: string;
    url: string | null;
    city: string | null;
    country: string | null;
    device: string | null;
    durationMs: number | null;
    occurredAtMs: number;
    lastIntentHeat: number;
  };
  alert: { id: string; title: string; body: string } | null;
}

interface ReplyPush {
  reply: {
    replyId: string;
    prospectId: string;
    prospectName: string;
    qlvScore: number | null;
    intent: string;
    confidence: number;
    tier: number;
    action: string;
    draftSubject: string | null;
    receivedAtMs: number;
  };
}

interface Toast {
  id: string;
  kind: "alert" | "info";
  title: string;
  body: string;
  prospectId?: string;
}

const VIEW_TITLES: Record<ViewKey, string> = {
  radar: "Radar — live machine perception",
  strike: "Strike — today's action queue",
  theatre: "Theatre — spatial cluster board",
  pipeline: "Pipeline — machine state & triage",
  ops: "Ops — engine health",
};

export function CommandCentre() {
  const [snap, setSnap] = useState<CommandSnapshot | null>(null);
  const [view, setView] = useState<ViewKey>("radar");
  const [dossier, setDossier] = useState<CommandLead | null>(null);
  const [dossierOpen, setDossierOpen] = useState(false);
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [filter, setFilter] = useState<StrikeFilter>("all");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [connected, setConnected] = useState(false);
  const [clock, setClock] = useState("");
  const [fresh, setFresh] = useState<Map<string, number>>(new Map());
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const socketRef = useRef<Socket | null>(null);
  const alertSeen = useRef<Set<string>>(new Set());
  const bootAlerted = useRef(false);

  // ---- clock tick -------------------------------------------------------- //
  useEffect(() => {
    const t = setInterval(() => {
      setNow(Date.now());
      setClock(
        new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date()),
      );
    }, 1000);
    return () => clearInterval(t);
  }, []);

  // ---- snapshot loading -------------------------------------------------- //
  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/command", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as CommandSnapshot;
      setSnap(data);
      if (!bootAlerted.current) {
        bootAlerted.current = true;
        const recent = data.alerts.filter((a) => Date.now() - a.createdAtMs <= 15 * 60_000).slice(0, 2);
        for (const a of recent) {
          const key = `boot:${a.id}`;
          if (alertSeen.current.has(key)) continue;
          alertSeen.current.add(key);
          pushToast({ kind: "alert", title: a.title, body: a.body, prospectId: a.prospectId });
          chime("alert");
        }
      }
    } catch {
      /* offline — retry on next tick */
    }
  }, []);

  const pushToast = useCallback((t: Omit<Toast, "id">) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setToasts((prev) => [{ id, ...t }, ...prev].slice(0, 4));
    setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), 10_000);
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 60_000);
    return () => clearInterval(t);
  }, [refresh]);

  // ---- socket bridge ----------------------------------------------------- //
  useEffect(() => {
    const socket = io("/?XTransformPort=3003", {
      path: "/",
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionDelay: 2000,
      timeout: 10_000,
      forceNew: true,
    });
    socketRef.current = socket;

    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));

    socket.on("telemetry", (push: TelemetryPush) => {
      const ev = push.event;
      const atMs = ev.occurredAtMs || Date.now();
      setFresh((prev) => new Map(prev).set(ev.id, Date.now() + 90_000));

      setSnap((prev) => {
        if (!prev) return prev;
        const highSignal = isHighSignal(ev.eventType);
        const leads = prev.leads.map((lead) => {
          if (lead.id !== ev.prospectId) return lead;
          const telemetry = {
            lastEventType: ev.eventType,
            lastEventAtMs: atMs,
            lastHighSignalAtMs: highSignal ? atMs : lead.telemetry.lastHighSignalAtMs,
            events48h: lead.telemetry.events48h + 1,
            totalSessionMs: lead.telemetry.totalSessionMs + (ev.durationMs ?? 0),
          };
          const priority =
            effectivePriority(
              { qlvScore: lead.score?.qlvScore ?? null, lastHighSignalAtMs: telemetry.lastHighSignalAtMs, lastEventType: telemetry.lastEventType },
              atMs,
            ) * (lead.__called ? 0.5 : 1);
          return {
            ...lead,
            telemetry,
            lastIntentHeat: ev.lastIntentHeat ?? lead.lastIntentHeat,
            priority,
            highIntentNow:
              highSignal && telemetry.lastHighSignalAtMs != null && (lead.score?.qlvScore ?? 0) >= 85 && atMs - telemetry.lastHighSignalAtMs <= 15 * 60_000,
          };
        });
        const source = prev.leads.find((l) => l.id === ev.prospectId);
        const feed = [
          {
            id: ev.id,
            prospectId: ev.prospectId,
            prospectName: ev.prospectName,
            qlvScore: ev.qlvScore,
            clusterName: source?.clusterName ?? null,
            vertical: source?.vertical ?? null,
            eventType: ev.eventType,
            url: ev.url,
            city: ev.city,
            country: ev.country,
            device: ev.device,
            durationMs: ev.durationMs,
            occurredAtMs: atMs,
            alertFired: Boolean(push.alert),
          },
          ...prev.feed,
        ].slice(0, 40);
        return { ...prev, leads, feed };
      });

      const score = ev.qlvScore ?? 0;
      if (push.alert || (isHighSignal(ev.eventType) && score >= 85)) {
        const dedupe = `${ev.prospectId}:${ev.eventType}:${Math.floor(atMs / 900_000)}`;
        if (!alertSeen.current.has(dedupe)) {
          alertSeen.current.add(dedupe);
          pushToast({
            kind: "alert",
            title: push.alert?.title ?? "HIGH-INTENT PROSPECT ON PORTAL",
            body: push.alert?.body ?? [
              `Company: ${ev.prospectName}`,
              `QLV: ${score}/100`,
              `Location: ${ev.city ?? "—"}, ${ev.country ?? "—"}`,
              `Action: Call direct line immediately.`,
            ].join("\n"),
            prospectId: ev.prospectId,
          });
          chime("alert");
        }
      } else if (score >= 70 && isHighSignal(ev.eventType)) {
        pushToast({
          kind: "info",
          title: `${ev.eventType.replace(/_/g, " ")} · QLV ${score}`,
          body: `${ev.prospectName} — ${ev.city ?? "—"}, ${ev.country ?? "—"}`,
          prospectId: ev.prospectId,
        });
      }
    });

    socket.on("reply", (push: ReplyPush) => {
      const r = push.reply;
      pushToast({
        kind: r.tier === 2 ? "alert" : "info",
        title: r.tier === 2 ? `Reply agent · draft awaiting review` : `Reply agent · auto-resolved`,
        body: [
          `${r.prospectName} — QLV ${r.qlvScore ?? "—"}`,
          `${INTENT_LABELS[r.intent as keyof typeof INTENT_LABELS] ?? r.intent} (${Math.round((r.confidence ?? 0) * 100)}% conf)`,
          r.tier === 2 ? `Action: review the draft in Pipeline.` : `Action taken: ${r.action.replace(/_/g, " ")}.`,
        ].join("\n"),
        prospectId: r.prospectId,
      });
      chime(r.tier === 2 ? "alert" : "info");
      void refresh();
    });

    return () => {
      socket.removeAllListeners();
      socket.close();
      socketRef.current = null;
    };
  }, [pushToast, refresh]);

  // ---- stale fresh-event cleanup ---------------------------------------- //
  useEffect(() => {
    const t = setInterval(() => {
      setFresh((prev) => {
        const next = new Map(prev);
        for (const [k, until] of next) if (until < Date.now()) next.delete(k);
        return next.size === prev.size ? prev : next;
      });
    }, 30_000);
    return () => clearInterval(t);
  }, []);

  // ---- derived ----------------------------------------------------------- //
  const ranked = useMemo(() => (snap ? computeRanked(snap, filter, now) : []), [snap, filter, now]);
  const rankedIds = useMemo(() => ranked.map((l) => l.id), [ranked]);

  const openDossier = useCallback((lead: CommandLead) => {
    setDossier(lead);
    setDossierOpen(true);
  }, []);

  const openDossierById = useCallback(
    (prospectId: string) => {
      const lead = snap?.leads.find((l) => l.id === prospectId);
      if (lead) openDossier(lead);
    },
    [snap, openDossier],
  );

  // ---- operator actions -------------------------------------------------- //
  const doAction = useCallback(
    async (prospectId: string, action: "called" | "deferred" | "snoozed" | "booked", note?: string) => {
      const lead = snap?.leads.find((l) => l.id === prospectId);
      try {
        const res = await fetch("/api/actions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prospectId, action, note, hours: action === "snoozed" ? 24 : undefined }),
        });
        if (!res.ok) throw new Error(String(res.status));
        pushToast({
          kind: "info",
          title:
            action === "called" ? `Call logged — ${lead?.name ?? "prospect"}`
            : action === "deferred" ? `Deferred — ${lead?.name ?? "prospect"}`
            : action === "booked" ? `Booked — ${lead?.name ?? "prospect"}`
            : `Snoozed 24h — ${lead?.name ?? "prospect"}`,
          body: action === "deferred" ? "Returns to the queue on the next high-signal event." : undefined ?? "",
          prospectId,
        });
        void refresh();
      } catch {
        pushToast({ kind: "info", title: "Action failed", body: "The enclave did not acknowledge — try again." });
      }
    },
    [snap, pushToast, refresh],
  );

  const doTriage = useCallback(
    async (draftId: string, decision: "approved" | "discarded") => {
      try {
        const res = await fetch("/api/replies", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ draftId, decision }),
        });
        if (!res.ok) throw new Error(String(res.status));
        pushToast({
          kind: decision === "approved" ? "info" : "info",
          title: decision === "approved" ? "Draft approved & sent" : "Draft discarded",
          body: decision === "approved" ? "Logged against the prospect timeline." : "The agent will not reuse this angle.",
        });
        void refresh();
      } catch {
        pushToast({ kind: "info", title: "Triage failed", body: "The enclave did not acknowledge — try again." });
      }
    },
    [pushToast, refresh],
  );

  // ---- keyboard loop ----------------------------------------------------- //
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      if (e.key === "Escape") {
        if (paletteOpen) setPaletteOpen(false);
        else if (dossierOpen) setDossierOpen(false);
        return;
      }
      if (paletteOpen || dossierOpen) return;

      if (["1", "2", "3", "4", "5"].includes(e.key)) {
        setView((["radar", "strike", "theatre", "pipeline", "ops"] as ViewKey[])[Number(e.key) - 1]);
        return;
      }
      if (view !== "strike" || rankedIds.length === 0) return;

      if (e.key === "j" || e.key === "k") {
        e.preventDefault();
        const idx = cursorId ? rankedIds.indexOf(cursorId) : -1;
        const next = e.key === "j" ? Math.min(rankedIds.length - 1, idx + 1) : Math.max(0, idx <= 0 ? 0 : idx - 1);
        setCursorId(rankedIds[next]);
      } else if (e.key === "Enter") {
        const lead = snap?.leads.find((l) => l.id === cursorId);
        if (lead) openDossier(lead);
      } else if (e.key === "c") {
        const lead = snap?.leads.find((l) => l.id === cursorId);
        const phone = lead?.contact?.phone;
        if (phone) {
          e.preventDefault();
          window.location.href = `tel:${phone.replace(/\s/g, "")}`;
        }
      } else if (e.key === "x") {
        if (cursorId) void doAction(cursorId, "deferred");
      } else if (e.key === "s") {
        if (cursorId) void doAction(cursorId, "snoozed");
      } else if (e.key === "a") {
        const first = snap?.triage.pending[0];
        if (first?.draftId) void doTriage(first.draftId, "approved");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, rankedIds, cursorId, snap, paletteOpen, dossierOpen, doAction, doTriage, openDossier]);

  // ---- render ------------------------------------------------------------ //
  return (
    <div className="command-root fixed inset-0 flex overflow-hidden bg-[#0a0a0b] font-sans text-[#f2f2f4] antialiased">
      <CommandRail view={view} onView={setView} snap={snap} clock={clock || "--:--:--"} connected={connected} />

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-[#1a1a1e] px-6">
          <div className="flex items-center gap-3">
            <LiveDot level={connected ? "live" : "warn"} />
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-[#8b8b93]">{VIEW_TITLES[view]}</p>
          </div>
          <div className="flex items-center gap-4">
            <span className="hidden font-mono text-[10.5px] uppercase tracking-[0.14em] text-[#3f3f46] lg:inline">
              bridge {connected ? "connected" : "reconnecting"}
            </span>
            <button
              onClick={() => setPaletteOpen(true)}
              className="flex h-8 items-center gap-2 rounded-xl border border-[#232327] px-3 font-mono text-[10.5px] uppercase tracking-[0.12em] text-[#8b8b93] transition-colors hover:text-[#d6d6db]"
            >
              Jump <span className="rounded bg-[#1a1a1e] px-1.5 py-0.5 text-[9.5px]">⌘K</span>
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1">
          {!snap ? (
            <BootScreen />
          ) : (
            <>
              {view === "radar" && (
                <RadarView
                  snap={snap}
                  now={now}
                  freshEventIds={new Set([...fresh.entries()].filter(([, until]) => until > Date.now()).map(([id]) => id))}
                  onOpenDossier={openDossier}
                  onGoStrike={() => setView("strike")}
                  onGoPipeline={() => setView("pipeline")}
                />
              )}
              {view === "strike" && (
                <StrikeView
                  snap={snap}
                  ranked={ranked}
                  now={now}
                  cursorId={cursorId}
                  onCursor={setCursorId}
                  onOpenDossier={openDossier}
                  onAction={doAction}
                  filter={filter}
                  onFilter={(f) => {
                    setFilter(f);
                    setCursorId(null);
                  }}
                />
              )}
              {view === "theatre" && <TheatreView snap={snap} onOpenDossier={openDossier} />}
              {view === "pipeline" && (
                <PipelineView snap={snap} now={now} onOpenDossierId={openDossierById} onTriage={doTriage} />
              )}
              {view === "ops" && <OpsView snap={snap} />}
            </>
          )}
        </div>
      </main>

      {/* Alert toasts */}
      <div className="pointer-events-none fixed right-5 top-5 z-[80] flex w-[380px] max-w-[calc(100vw-40px)] flex-col gap-2.5">
        {toasts.map((t) => (
          <button
            key={t.id}
            onClick={() => {
              if (t.prospectId) openDossierById(t.prospectId);
              setToasts((prev) => prev.filter((x) => x.id !== t.id));
            }}
            className={`cc-toast pointer-events-auto rounded-2xl border px-4 py-3.5 text-left shadow-[0_20px_50px_-20px_rgba(0,0,0,0.9)] transition-transform hover:scale-[1.01] ${
              t.kind === "alert" ? "border-[#fafafa] bg-[#fafafa] text-[#0a0a0b]" : "border-[#2a2a2f] bg-[#161619] text-[#e4e4e8]"
            }`}
          >
            <div className="flex items-center gap-2">
              {t.kind === "alert" && <span className="size-1.5 rounded-full bg-[#0a0a0b] cc-blink" />}
              <p className={`font-mono text-[10.5px] font-medium uppercase tracking-[0.14em] ${t.kind === "alert" ? "text-[#0a0a0b]" : "text-[#8b8b93]"}`}>
                {t.title}
              </p>
            </div>
            <p className={`mt-1.5 whitespace-pre-line text-[12px] leading-relaxed ${t.kind === "alert" ? "text-[#26262b]" : "text-[#a8a8b0]"}`}>
              {t.body}
            </p>
          </button>
        ))}
      </div>

      <DossierDrawer lead={dossier} open={dossierOpen} onOpenChange={setDossierOpen} onAction={doAction} />

      {/* Command palette */}
      <Dialog open={paletteOpen} onOpenChange={setPaletteOpen}>
        <DialogContent className="command-root top-[18%] max-w-[560px] translate-y-0 gap-0 rounded-2xl border-[#232327] bg-[#101012] p-0 shadow-[0_40px_120px_-30px_rgba(0,0,0,0.95)] sm:top-[18%]">
          <DialogTitle className="sr-only">Command palette</DialogTitle>
          <Command className="bg-transparent">
            <CommandInput placeholder="Jump to a view, a lead, a draft…" className="border-b border-[#1e1e22] font-mono text-[13px]" />
            <CommandList className="cc-scroll max-h-[380px] p-2">
              <CommandEmpty className="py-6 text-center font-mono text-[11px] uppercase tracking-[0.14em] text-[#5c5c64]">
                No match
              </CommandEmpty>
              <CommandGroup heading="Views" className="text-[#5c5c64]">
                {(Object.keys(VIEW_TITLES) as ViewKey[]).map((v) => (
                  <CommandItem
                    key={v}
                    onSelect={() => {
                      setView(v);
                      setPaletteOpen(false);
                    }}
                    className="rounded-xl px-3 py-2.5 text-[13px] text-[#d6d6db] data-[selected=true]:bg-[#1a1a1e] data-[selected=true]:text-[#fafafa]"
                  >
                    {VIEW_TITLES[v]}
                  </CommandItem>
                ))}
              </CommandGroup>
              {snap && snap.triage.pending.length > 0 && (
                <CommandGroup heading="Pending drafts">
                  {snap.triage.pending.map((t) => (
                    <CommandItem
                      key={t.replyId}
                      onSelect={() => {
                        setView("pipeline");
                        setPaletteOpen(false);
                      }}
                      className="rounded-xl px-3 py-2.5 text-[13px] text-[#d6d6db] data-[selected=true]:bg-[#1a1a1e] data-[selected=true]:text-[#fafafa]"
                    >
                      Review draft — {t.prospectName}
                      <span className="ml-auto font-mono text-[10px] uppercase text-[#5c5c64]">{t.intent.replace(/_/g, " ")}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
              {snap && (
                <CommandGroup heading="Leads">
                  {snap.leads.map((l) => (
                    <CommandItem
                      key={l.id}
                      value={`${l.name} ${l.domain ?? ""} ${l.city ?? ""}`}
                      onSelect={() => {
                        openDossier(l);
                        setPaletteOpen(false);
                      }}
                      className="rounded-xl px-3 py-2.5 text-[13px] text-[#d6d6db] data-[selected=true]:bg-[#1a1a1e] data-[selected=true]:text-[#fafafa]"
                    >
                      {l.name}
                      <span className="ml-auto font-mono text-[10px] tabular-nums text-[#5c5c64]">
                        {l.score?.qlvScore ?? "—"} · {l.city ?? "—"}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function BootScreen() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4">
      <span className="size-2 rounded-full bg-[#fafafa] cc-pulse-dot" />
      <SectionLabel>Establishing uplink — loading command snapshot</SectionLabel>
    </div>
  );
}
