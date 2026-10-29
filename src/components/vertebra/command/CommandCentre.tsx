/**
 * Executive Enclave root — the 1-of-1 operator cockpit for Syntropic.
 *
 * Owns: snapshot state, socket bridge fan-out, the keyboard loop,
 * high-intent alert toasts + chime, dossier drawer, persona switcher,
 * command palette. Tailored for COO / VP Sales / Director of Inside Sales
 * at US & Canada industrial distributors.
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
import { PortalView } from "./portal/PortalView";
import { OpsView } from "./OpsView";
import { DossierDrawer } from "./DossierDrawer";
import { HudMeta, LiveDot } from "./bits";
import { chime } from "@/lib/vertebra/chime";
import { PERSONAS, personaDef, type PersonaId } from "@/lib/vertebra/persona";
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
  radar: "Radar — margin telemetry, live",
  strike: "Strike — recovery queue",
  theatre: "Theatre — spatial cluster board",
  pipeline: "Pipeline — machine state & triage",
  portal: "Portal — margin defense entry",
  ops: "Ops — engine health",
};

const VIEW_KEYS: ViewKey[] = ["radar", "strike", "theatre", "pipeline", "portal", "ops"];

export function CommandCentre() {
  const [snap, setSnap] = useState<CommandSnapshot | null>(null);
  const [view, setView] = useState<ViewKey>("radar");
  const [persona, setPersona] = useState<PersonaId>("coo");
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

  // ---- persona persistence ----------------------------------------------- //
  useEffect(() => {
    const saved = window.localStorage.getItem("syntropic:persona");
    if (saved && PERSONAS.some((p) => p.id === saved)) setPersona(saved as PersonaId);
  }, []);
  const onPersona = useCallback((p: PersonaId) => {
    setPersona(p);
    window.localStorage.setItem("syntropic:persona", p);
  }, []);

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

  // ---- persisted alert acknowledgement ----------------------------------- //
  // A displayed alert is an acknowledged alert: recorded server-side and in
  // localStorage so a reload never re-fires stale toasts.
  const ackAlerts = useCallback((alertIds: string[]) => {
    if (alertIds.length === 0) return;
    try {
      const KEY = "vertebra-acked-alerts";
      const acked: Set<string> = new Set(JSON.parse(localStorage.getItem(KEY) ?? "[]") as string[]);
      for (const id of alertIds) acked.add(id);
      localStorage.setItem(KEY, JSON.stringify([...acked].slice(-500)));
    } catch {
      /* storage unavailable — server ack still lands */
    }
    void fetch("/api/alerts/ack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alertIds }),
    }).catch(() => {});
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
        let storageAcked: Set<string> = new Set();
        try {
          storageAcked = new Set(JSON.parse(localStorage.getItem("vertebra-acked-alerts") ?? "[]") as string[]);
        } catch { /* ignore */ }
        const recent = data.alerts
          .filter((a) => Date.now() - a.createdAtMs <= 15 * 60_000)
          .filter((a) => a.acknowledgedAtMs == null && !storageAcked.has(a.id))
          .slice(0, 2);
        const displayed: string[] = [];
        for (const a of recent) {
          const key = `boot:${a.id}`;
          if (alertSeen.current.has(key)) continue;
          alertSeen.current.add(key);
          displayed.push(a.id);
          pushToast({ kind: "alert", title: a.title, body: a.body, prospectId: a.prospectId });
          chime("alert");
        }
        ackAlerts(displayed);
      }
    } catch {
      /* offline — retry on next tick */
    }
  }, [ackAlerts]);

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
          if (push.alert) ackAlerts([push.alert.id]);
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
  const activePersona = personaDef(persona);

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

      if (["1", "2", "3", "4", "5", "6"].includes(e.key)) {
        setView(VIEW_KEYS[Number(e.key) - 1]);
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
    <div className="command-root fixed inset-0 flex overflow-hidden bg-[#0B0C0B] font-sans text-[#F4F5F2] antialiased">
      <CommandRail view={view} onView={setView} snap={snap} clock={clock || "--:--:--"} connected={connected} personaCode={activePersona.code} />

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between gap-6 border-b border-white/[0.08] px-7">
          <div className="flex min-w-0 items-center gap-4">
            <LiveDot level={connected ? "live" : "warn"} />
            <p className="truncate font-mono text-[11px] uppercase tracking-[0.2em] text-[#8E9194]">{VIEW_TITLES[view]}</p>
            <span className="hidden max-w-[620px] truncate whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.14em] text-[#5F6460] xl:inline-block">
              · {activePersona.title}: {activePersona.mandate}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-6">
            <HudMeta node="AST-00" hash="0a11" className="hidden xl:inline-flex" />
            <button
              onClick={() => setPaletteOpen(true)}
              className="tactile-btn h-8 items-center gap-2 rounded-full border border-white/[0.12] bg-[#131513] px-3 font-mono text-[10.5px] uppercase tracking-[0.12em] text-[#8E9194] hover:text-[#F4F5F2] hover:border-white/25"
            >
              Jump <span className="rounded bg-[#1A1D1A] px-1.5 py-0.5 text-[9.5px]">⌘K</span>
            </button>
          </div>
        </header>

        {/* mobile view switcher — rail is hidden below md */}
        <div
          className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-white/[0.08] px-4 py-2 md:hidden"
          role="tablist"
          aria-label="Enclave views"
        >
          {VIEW_KEYS.map((k) => (
            <button
              key={k}
              role="tab"
              aria-selected={view === k}
              onClick={() => setView(k)}
              className={`h-7 shrink-0 rounded-full px-3 font-mono text-[9.5px] uppercase tracking-[0.1em] transition-all ${
                view === k
                  ? "bg-[#F4F5F2] text-[#0B0C0B]"
                  : "border border-white/[0.12] bg-[#131513] text-[#8E9194]"
              }`}
            >
              {k}
            </button>
          ))}
        </div>

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
                  persona={persona}
                  onPersona={onPersona}
                  connected={connected}
                  onOpenDossier={openDossier}
                  onQuickAction={(lead, action) => {
                    if (action === "call") {
                      const phone = lead.contact?.phone;
                      if (phone) window.location.href = `tel:${phone.replace(/\s/g, "")}`;
                    } else if (action === "defer") {
                      void doAction(lead.id, "deferred");
                    } else {
                      void doAction(lead.id, "snoozed");
                    }
                  }}
                  onAckAlerts={ackAlerts}
                  onGoStrike={() => setView("strike")}
                  onGoPipeline={() => setView("pipeline")}
                  onGoPortal={() => setView("portal")}
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
              {view === "portal" && <PortalView snap={snap} />}
              {view === "ops" && <OpsView snap={snap} />}
            </>
          )}
        </div>
      </main>

      {/* Alert toasts — alert = deep onyx inverse, info = white tactile */}
      <div className="pointer-events-none fixed right-5 top-5 z-[80] flex w-[380px] max-w-[calc(100vw-40px)] flex-col gap-2.5">
        {toasts.map((t) => (
          <button
            key={t.id}
            onClick={() => {
              if (t.prospectId) openDossierById(t.prospectId);
              setToasts((prev) => prev.filter((x) => x.id !== t.id));
            }}
            className={`cc-toast pointer-events-auto rounded-lg px-4 py-3.5 text-left transition-transform hover:scale-[1.01] ${
              t.kind === "alert"
                ? "ink shadow-[0_18px_50px_rgba(0,0,0,0.5)]"
                : "neu border-white/[0.14] shadow-[0_18px_50px_rgba(0,0,0,0.5)]"
            }`}
          >
            <div className="flex items-center gap-2">
              {t.kind === "alert" && <span className="size-1.5 rounded-full bg-[#F4F5F2] cc-blink" />}
              <p className={`font-mono text-[10.5px] font-medium uppercase tracking-[0.14em] ${t.kind === "alert" ? "text-white" : "text-[#8E9194]"}`}>
                {t.title}
              </p>
            </div>
            <p className={`mt-1.5 whitespace-pre-line text-[12px] leading-relaxed ${t.kind === "alert" ? "text-white/90" : "text-[#C9CCC7]"}`}>
              {t.body}
            </p>
          </button>
        ))}
      </div>

      <DossierDrawer lead={dossier} open={dossierOpen} onOpenChange={setDossierOpen} onAction={doAction} />

      {/* Command palette */}
      <Dialog open={paletteOpen} onOpenChange={setPaletteOpen}>
        <DialogContent className="command-root top-[18%] max-w-[560px] translate-y-0 gap-0 rounded-lg border-white/[0.14] bg-[#131513] p-0 shadow-[0_40px_120px_-30px_rgba(0,0,0,0.75)] sm:top-[18%]">
          <DialogTitle className="sr-only">Command palette</DialogTitle>
          <Command className="bg-transparent">
            <CommandInput placeholder="Jump to a view, a distributor, a draft…" className="border-b border-white/[0.10] font-mono text-[13px]" />
            <CommandList className="cc-scroll max-h-[380px] p-2">
              <CommandEmpty className="py-6 text-center font-mono text-[11px] uppercase tracking-[0.14em] text-[#5F6460]">
                No match
              </CommandEmpty>
              <CommandGroup heading="Views" className="text-[#6E736E]">
                {(Object.keys(VIEW_TITLES) as ViewKey[]).map((v) => (
                  <CommandItem
                    key={v}
                    onSelect={() => {
                      setView(v);
                      setPaletteOpen(false);
                    }}
                    className="rounded-lg px-3 py-2.5 text-[13px] text-[#E9EBE7] data-[selected=true]:bg-[#222522] data-[selected=true]:text-[#F4F5F2]"
                  >
                    {VIEW_TITLES[v]}
                  </CommandItem>
                ))}
              </CommandGroup>
              <CommandGroup heading="Persona view">
                {PERSONAS.map((p) => (
                  <CommandItem
                    key={p.id}
                    value={`persona ${p.code} ${p.title}`}
                    onSelect={() => {
                      onPersona(p.id);
                      setPaletteOpen(false);
                    }}
                    className="rounded-lg px-3 py-2.5 text-[13px] text-[#E9EBE7] data-[selected=true]:bg-[#222522] data-[selected=true]:text-[#F4F5F2]"
                  >
                    View as {p.code}
                    <span className="ml-auto font-mono text-[10px] uppercase text-[#6E736E]">
                      {persona === p.id ? "active" : p.title}
                    </span>
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
                      className="rounded-lg px-3 py-2.5 text-[13px] text-[#E9EBE7] data-[selected=true]:bg-[#222522] data-[selected=true]:text-[#F4F5F2]"
                    >
                      Review draft — {t.prospectName}
                      <span className="ml-auto font-mono text-[10px] uppercase text-[#6E736E]">{t.intent.replace(/_/g, " ")}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
              {snap && (
                <CommandGroup heading="Distributors">
                  {snap.leads.map((l) => (
                    <CommandItem
                      key={l.id}
                      value={`${l.name} ${l.domain ?? ""} ${l.city ?? ""}`}
                      onSelect={() => {
                        openDossier(l);
                        setPaletteOpen(false);
                      }}
                      className="rounded-lg px-3 py-2.5 text-[13px] text-[#E9EBE7] data-[selected=true]:bg-[#222522] data-[selected=true]:text-[#F4F5F2]"
                    >
                      {l.name}
                      <span className="ml-auto font-mono text-[10px] tabular-nums text-[#6E736E]">
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
      <span className="size-2 rounded-full bg-[#F4F5F2] cc-pulse-dot" />
      <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-[#8E9194]">Establishing uplink — loading enclave snapshot</p>
    </div>
  );
}
