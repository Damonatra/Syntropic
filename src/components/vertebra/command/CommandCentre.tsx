/**
 * Executive Enclave root — the 1-of-1 operator cockpit for Syntropic.
 *
 * Owns: snapshot state (with localStorage boot hydration for outage-proof
 * paint), socket bridge fan-out, the keyboard loop, high-intent alert toasts
 * + chime, dossier drawer, persona switcher, command palette. Tailored for
 * COO / VP Sales / Director of Inside Sales at US & Canada industrial
 * distributors.
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { CommandRail, type ViewKey } from "./CommandRail";
import { RadarView } from "./RadarView";
import { StrikeView, STRIKE_FILTERS, computeRanked, type StrikeFilter } from "./StrikeView";
import { TheatreView } from "./TheatreView";
import { PipelineView } from "./PipelineView";
import { PortalView } from "./portal/PortalView";
import { OpsView } from "./OpsView";
import { SourcingView } from "./SourcingView";
import { DossierDrawer } from "./DossierDrawer";
import { HudMeta, LiveDot } from "./bits";
import { chime } from "@/lib/vertebra/chime";
import { onConsoleRefresh } from "@/lib/vertebra/console-bus";
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
  body?: string;
  prospectId?: string;
  /** Tier-2 reply toasts deep-link the gate: click lands the cursor on this draft. */
  replyId?: string;
}

/** M7 — the grammar overlay's single source of truth. */
const SHORTCUTS: Array<[string, string, string]> = [
  ["global", "1 – 7", "switch deck"],
  ["global", "⌘K", "command jump"],
  ["global", "?", "this overlay"],
  ["strike", "j / k", "move cursor"],
  ["strike", "enter", "open dossier"],
  ["strike", "e", "dossier + cold email desk"],
  ["strike", "c", "dial contact"],
  ["strike", "x", "defer"],
  ["strike", "s", "snooze 24h"],
  ["strike", "f", "cycle filter"],
  ["strike", "esc", "close / dismiss"],
  ["pipeline", "j / k", "walk the gate"],
  ["pipeline", "a", "approve & send"],
  ["pipeline", "x", "discard"],
  ["pipeline", "e", "edit draft in place"],
  ["pipeline", "enter", "open dossier"],
  ["pipeline", "space", "select for bulk"],
  ["pipeline", "f", "cycle intent filter"],
  ["ops", "j / k", "move cursor"],
  ["ops", "a", "ack — real (quiet this window)"],
  ["ops", "f", "ack — false positive"],
  ["ops", "h", "ack — handled"],
  ["ops", "enter", "open subject drawer"],
];

const VIEW_TITLES: Record<ViewKey, string> = {
  radar: "Radar — margin telemetry, live",
  strike: "Strike — recovery queue",
  theatre: "Theatre — spatial cluster board",
  pipeline: "Pipeline — machine state & triage",
  portal: "Portal — engagement desk",
  ops: "Ops — engine health",
  sourcing: "Sourcing — who's next through the door",
};

const VIEW_KEYS: ViewKey[] = ["radar", "strike", "theatre", "pipeline", "portal", "ops", "sourcing"];

/** localStorage key for the last good snapshot — boot paint before the network answers. */
const SNAPSHOT_CACHE_KEY = "vertebra:last-snapshot";

export function CommandCentre() {
  const [snap, setSnap] = useState<CommandSnapshot | null>(null);
  const [view, setView] = useState<ViewKey>("radar");
  // Deep link — a URL carrying theatre board params (tl/tt/tc/tk) means the
  // operator followed a board link: land on the Theatre, not the Radar. Runs
  // post-mount (SSR-safe); never yanks an operator who already switched views.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.has("tl") || p.has("tt") || p.has("tc") || p.has("tk")) {
      setView((v) => (v === "radar" ? "theatre" : v));
    }
  }, []);
  const [persona, setPersona] = useState<PersonaId>("coo");
  const [dossier, setDossier] = useState<CommandLead | null>(null);
  const [dossierOpen, setDossierOpen] = useState(false);
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [cursorScrollTick, setCursorScrollTick] = useState(0);
  const [filter, setFilter] = useState<StrikeFilter>("all");
  // M5 — optimistic action ledger + one-shot guard
  const [acted, setActed] = useState<Record<string, string>>({});
  const actingRef = useRef<Set<string>>(new Set());
  // M7 — keyboard grammar surface
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [dossierFocusCompose, setDossierFocusCompose] = useState(false);
  // Pipeline deep-link — a palette draft-jump lands the gate cursor on this reply.
  const [pipelineFocusReply, setPipelineFocusReply] = useState<string | null>(null);
  // Header readout — mirrors strike's "cursor 02/09" line for the gate.
  const [pipelineCursorMeta, setPipelineCursorMeta] = useState<{ name: string; idx: number; total: number } | null>(null);
  const onPipelineCursorMeta = useCallback((meta: { name: string; idx: number; total: number } | null) => {
    setPipelineCursorMeta((prev) =>
      prev?.name === meta?.name && prev?.idx === meta?.idx && prev?.total === meta?.total ? prev : meta,
    );
  }, []);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [connected, setConnected] = useState(false);
  // Operator identity — the signed session names whoever is at the stick.
  const [operator, setOperator] = useState<{ username: string; displayName: string; role: string } | null>(null);
  useEffect(() => {
    fetch("/api/gate")
      .then((r) => r.json())
      .then((d: { operator?: { username: string; displayName: string; role: string } | null }) => setOperator(d.operator ?? null))
      .catch(() => {});
  }, []);
  const signOut = () => {
    void fetch("/api/gate", { method: "DELETE" })
      .catch(() => {})
      .finally(() => {
        window.location.href = "/gate";
      });
  };
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

  // ---- boot hydration — last known truth from localStorage ---------------- //
  // Paints instantly on reload with the previous snapshot while the network
  // fetch is in flight; the staleness watchdog flags its age until the fresh
  // snapshot lands. Alerts acked from this browser stay acked so the backlog
  // never flashes rows the operator already dismissed.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(SNAPSHOT_CACHE_KEY);
      if (!raw) return;
      const cached = JSON.parse(raw) as CommandSnapshot;
      if (!cached || typeof cached.generatedAtMs !== "number" || Date.now() - cached.generatedAtMs > 7 * 86_400_000) return;
      let storageAcked: Set<string> = new Set();
      try {
        storageAcked = new Set(JSON.parse(window.localStorage.getItem("vertebra-acked-alerts") ?? "[]") as string[]);
      } catch {
        /* ignore malformed ack ledger */
      }
      setSnap({
        ...cached,
        alerts: cached.alerts.filter((a) => a.acknowledgedAtMs != null || !storageAcked.has(a.id)),
      });
    } catch {
      /* corrupted cache — the network snapshot will replace it */
    }
  }, []);

  // ---- snapshot loading -------------------------------------------------- //
  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/command", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as CommandSnapshot;
      setSnap(data);
      try {
        window.localStorage.setItem(SNAPSHOT_CACHE_KEY, JSON.stringify(data));
      } catch {
        /* quota or privacy mode — cache is best-effort */
      }
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

  // ---- console refresh bus — one beat everywhere -------------------------- //
  // Any write anywhere (arm, probe, batch, reveal, tick, ack, domain change)
  // fires the bus; the root snapshot reloads on the same beat the panels do.
  // Debounced so a burst of writes costs one fetch, not ten.
  const busTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const off = onConsoleRefresh(() => {
      if (busTimer.current) clearTimeout(busTimer.current);
      busTimer.current = setTimeout(() => void refresh(), 250);
    });
    return () => {
      off();
      if (busTimer.current) clearTimeout(busTimer.current);
    };
  }, [refresh]);

  // M5 — fresh snapshot arrived: optimistic dims yield to the real state.
  useEffect(() => {
    if (snap) setActed({});
  }, [snap]);

  // M5 — filter memory: restore the last strike filter, persist every change.
  useEffect(() => {
    try {
      const saved = localStorage.getItem("vertebra:strike-filter") as StrikeFilter | null;
      if (saved && STRIKE_FILTERS.some(([k]) => k === saved)) setFilter(saved);
    } catch {
      /* private mode — default to all */
    }
  }, []);
  const handleFilter = useCallback((f: StrikeFilter) => {
    setFilter(f);
    try {
      localStorage.setItem("vertebra:strike-filter", f);
    } catch {
      /* private mode */
    }
  }, []);

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
          r.tier === 2 ? `Action: tap to review the draft at the gate.` : `Action taken: ${r.action.replace(/_/g, " ")}.`,
        ].join("\n"),
        prospectId: r.prospectId,
        replyId: r.tier === 2 ? r.replyId : undefined,
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
  const strikeCursorIdx = view === "strike" ? ranked.findIndex((l) => l.id === cursorId) : -1;
  const strikeCursorName = strikeCursorIdx >= 0 ? ranked[strikeCursorIdx].name : null;

  const openDossier = useCallback((lead: CommandLead, opts?: { focusCompose?: boolean }) => {
    setDossierFocusCompose(Boolean(opts?.focusCompose));
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
    async (prospectId: string, action: "called" | "deferred" | "snoozed" | "booked" | "note", note?: string) => {
      if (actingRef.current.has(prospectId)) return; // M5 — one-shot: a second click mid-flight is ignored
      actingRef.current.add(prospectId);
      setActed((prev) => ({ ...prev, [prospectId]: action })); // optimistic dim until fresh truth
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
            : action === "note" ? `Note logged — ${lead?.name ?? "prospect"}`
            : `Snoozed 24h — ${lead?.name ?? "prospect"}`,
          body: action === "deferred" ? "Returns to the queue on the next high-signal event." : undefined,
          prospectId,
        });
        void refresh();
      } catch {
        setActed((prev) => {
          const next = { ...prev };
          delete next[prospectId]; // action refused — remove the dim, the card is still live
          return next;
        });
        pushToast({ kind: "info", title: "Action failed", body: "The enclave did not acknowledge — try again." });
      } finally {
        actingRef.current.delete(prospectId); // M5 — release the one-shot guard
      }
    },
    [snap, pushToast, refresh],
  );

  const doTriage = useCallback(
    async (draftId: string, decision: "approved" | "discarded", edits?: { subject?: string; body?: string }) => {
      try {
        const res = await fetch("/api/replies", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ draftId, decision, ...edits }),
        });
        if (!res.ok) throw new Error(String(res.status));
        const out = (await res.json().catch(() => null)) as { delivery?: { status: string } } | null;
        const staged = out?.delivery?.status === "staged";
        pushToast({
          kind: "info",
          title: decision === "approved" ? (staged ? "Draft approved — staged" : "Draft approved & sent") : "Draft discarded",
          body:
            decision === "approved"
              ? staged
                ? "No mail provider configured — the send is queued honestly, not faked."
                : "Logged against the prospect timeline."
              : "The agent will not reuse this angle.",
        });
        void refresh();
        return out;
      } catch {
        pushToast({ kind: "info", title: "Triage failed", body: "The enclave did not acknowledge — try again." });
      }
    },
    [pushToast, refresh],
  );

  /** Bulk triage — sequential PATCHes (rail guardrails apply per-request), one honest summary. */
  const doBulkTriage = useCallback(
    async (decisions: Array<{ draftId: string; decision: "approved" | "discarded" }>, label: string) => {
      if (decisions.length === 0) return;
      let approved = 0;
      let discarded = 0;
      let staged = 0;
      let failed = 0;
      for (const d of decisions) {
        try {
          const res = await fetch("/api/replies", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(d),
          });
          if (!res.ok) throw new Error(String(res.status));
          const out = (await res.json().catch(() => null)) as { delivery?: { status: string } } | null;
          if (d.decision === "approved") {
            approved += 1;
            if (out?.delivery?.status === "staged") staged += 1;
          } else {
            discarded += 1;
          }
        } catch {
          failed += 1;
        }
      }
      pushToast({
        kind: failed > 0 ? "alert" : "info",
        title: `Bulk triage — ${label}`,
        body: `${approved} approved${staged > 0 ? ` (${staged} staged)` : ""} · ${discarded} discarded${failed > 0 ? ` · ${failed} refused` : ""}`,
      });
      void refresh();
    },
    [pushToast, refresh],
  );

  /** Channel A tick from the pipeline deck. */
  const doRunTick = useCallback(async () => {
    try {
      const res = await fetch("/api/ops/tick", { method: "POST" });
      if (!res.ok) throw new Error(String(res.status));
      const out = (await res.json()) as { due: number; sent: number; stopped: number; deferred: number; failed: number; provider: string };
      pushToast({
        kind: "info",
        title: `Tick — ${out.due} due`,
        body: `${out.sent} sent · ${out.stopped} stopped · ${out.deferred} deferred · ${out.failed} failed (${out.provider})`,
      });
      void refresh();
    } catch {
      pushToast({ kind: "info", title: "Tick failed", body: "The enclave did not acknowledge — try again." });
    }
  }, [pushToast, refresh]);

  /** Channel B — export a high-touch account to the Josias queue, honestly. */
  const doExportHighTouch = useCallback(
    async (prospectId: string) => {
      const lead = snap?.leads.find((l) => l.id === prospectId);
      try {
        const res = await fetch("/api/high-touch/export", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prospectId }),
        });
        if (!res.ok) throw new Error(String(res.status));
        pushToast({ kind: "info", title: `Exported — ${lead?.name ?? "account"}`, body: "Handed to the Josias queue · outbox event published." });
        void refresh();
      } catch {
        pushToast({ kind: "info", title: "Export failed", body: "The enclave did not acknowledge — try again." });
      }
    },
    [snap, pushToast, refresh],
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
        if (shortcutsOpen) setShortcutsOpen(false);
        else if (paletteOpen) setPaletteOpen(false);
        else if (dossierOpen) setDossierOpen(false);
        return;
      }
      if (e.key === "?") {
        e.preventDefault();
        setShortcutsOpen((o) => !o);
        return;
      }
      if (shortcutsOpen || paletteOpen || dossierOpen) return;

      if (["1", "2", "3", "4", "5", "6", "7"].includes(e.key)) {
        setView(VIEW_KEYS[Number(e.key) - 1]);
        return;
      }
      if (view !== "strike" || rankedIds.length === 0) return;

      if (e.key === "j" || e.key === "k") {
        e.preventDefault();
        const idx = cursorId ? rankedIds.indexOf(cursorId) : -1;
        const next = e.key === "j" ? Math.min(rankedIds.length - 1, idx + 1) : Math.max(0, idx <= 0 ? 0 : idx - 1);
        setCursorId(rankedIds[next]);
        setCursorScrollTick((t) => t + 1); // M2: keyboard-sourced moves scroll the card into view
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
      } else if (e.key === "e") {
        const lead = snap?.leads.find((l) => l.id === cursorId);
        if (lead) openDossier(lead, { focusCompose: true }); // M7 — straight to the cold email desk
      } else if (e.key === "f") {
        // M7 — cycle filters: all → critical → hot → now → all (persists via handleFilter)
        const idx = STRIKE_FILTERS.findIndex(([k]) => k === filter);
        const next = STRIKE_FILTERS[(idx + 1) % STRIKE_FILTERS.length][0];
        handleFilter(next);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, rankedIds, cursorId, snap, paletteOpen, dossierOpen, shortcutsOpen, filter, doAction, openDossier, handleFilter]);

  // ---- render ------------------------------------------------------------ //
  return (
    <div className="command-root fixed inset-0 flex overflow-hidden bg-[#0B0C0B] font-sans text-[#F4F5F2] antialiased">
      <CommandRail view={view} onView={setView} snap={snap} clock={clock || "--:--:--"} connected={connected} personaCode={activePersona.code} operator={operator} />

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between gap-6 border-b border-white/[0.08] px-7">
          <div className="flex min-w-0 items-center gap-4">
            <LiveDot level={connected ? "live" : "warn"} />
            <p className="truncate font-mono text-[11px] uppercase tracking-[0.2em] text-[#8E9194]">{VIEW_TITLES[view]}</p>
            {view === "strike" && strikeCursorIdx >= 0 && (
              <span
                aria-live="polite"
                className="hidden max-w-[380px] shrink-0 truncate whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.14em] text-[#F4F5F2] lg:inline-block"
              >
                · cursor {String(strikeCursorIdx + 1).padStart(2, "0")}/{String(ranked.length).padStart(2, "0")} — {strikeCursorName}
              </span>
            )}
            {view === "pipeline" && pipelineCursorMeta && (
              <span
                aria-live="polite"
                className="hidden max-w-[380px] shrink-0 truncate whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.14em] text-[#F4F5F2] lg:inline-block"
              >
                · gate {String(pipelineCursorMeta.idx).padStart(2, "0")}/{String(pipelineCursorMeta.total).padStart(2, "0")} — {pipelineCursorMeta.name}
              </span>
            )}
            <span className="hidden max-w-[620px] truncate whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.14em] text-[#5F6460] xl:inline-block">
              · {activePersona.title}: {activePersona.mandate}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-6">
            <HudMeta node="AST-00" hash="0a11" className="hidden xl:inline-flex" />
            {operator && (
              <div className="hidden items-center gap-2 md:flex">
                <span
                  title={`signed in as ${operator.username}${operator.role ? ` · ${operator.role}` : ""}`}
                  className="flex h-8 items-center rounded-full border border-white/[0.12] bg-[#131513] px-3 font-mono text-[10.5px] uppercase tracking-[0.12em] text-[#8E9194]"
                >
                  {operator.displayName}
                </span>
                <button
                  onClick={signOut}
                  title="Sign out"
                  className="tactile-btn h-8 rounded-full border border-white/[0.12] bg-[#131513] px-3 font-mono text-[9.5px] uppercase tracking-[0.12em] text-[#8E9194]"
                >
                  Exit
                </button>
              </div>
            )}
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
                  onGoTheatre={() => setView("theatre")}
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
                  onFilter={handleFilter}
                  scrollTick={cursorScrollTick}
                  acted={acted}
                />
              )}
              {view === "theatre" && (
                <TheatreView snap={snap} onOpenDossier={openDossier} filter={filter} onFilter={handleFilter} />
              )}
              {view === "pipeline" && (
                <PipelineView
                  snap={snap}
                  now={now}
                  onOpenDossierId={openDossierById}
                  onTriage={doTriage}
                  onBulkTriage={doBulkTriage}
                  onRunTick={doRunTick}
                  onExportHighTouch={doExportHighTouch}
                  suspended={dossierOpen || paletteOpen || shortcutsOpen}
                  focusReplyId={pipelineFocusReply}
                  onFocusConsumed={() => setPipelineFocusReply(null)}
                  onCursorMeta={onPipelineCursorMeta}
                />
              )}
              {view === "portal" && <PortalView snap={snap} refresh={refresh} />}
              {view === "ops" && <OpsView snap={snap} connected={connected} onGoPortal={() => setView("portal")} />}
              {view === "sourcing" && <SourcingView onOpenDossier={openDossierById} />}
            </>
          )}
        </div>
      </main>

      {/* M7 — keyboard grammar overlay (?) */}
      {shortcutsOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Keyboard shortcuts"
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-6"
          onClick={() => setShortcutsOpen(false)}
        >
          <div
            className="w-full max-w-[560px] rounded-xl border border-white/[0.14] bg-[#131513] p-6 shadow-[0_30px_80px_rgba(0,0,0,0.6)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[#F4F5F2]">enclave keyboard grammar</p>
              <button
                type="button"
                onClick={() => setShortcutsOpen(false)}
                className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#6E736E] transition-colors hover:text-[#F4F5F2]"
              >
                esc · close
              </button>
            </div>
            <div className="mt-5 grid grid-cols-1 gap-x-10 gap-y-1 sm:grid-cols-2">
              {SHORTCUTS.map(([group, keys, label]) => (
                <div key={`${group}-${keys}`} className="flex items-baseline justify-between gap-3 border-b border-white/[0.05] py-1.5">
                  <span className="truncate text-[12px] text-[#C9CCC7]">
                    <span className="mr-2 font-mono text-[9px] uppercase tracking-[0.16em] text-[#5F6460]">{group}</span>
                    {label}
                  </span>
                  <kbd className="shrink-0 rounded border border-white/[0.16] bg-[#0B0C0B] px-1.5 py-0.5 font-mono text-[10px] text-[#F4F5F2]">{keys}</kbd>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Alert toasts — alert = deep onyx inverse, info = white tactile */}
      <div className="pointer-events-none fixed right-5 top-5 z-[80] flex w-[380px] max-w-[calc(100vw-40px)] flex-col gap-2.5">
        {toasts.map((t) => (
          <button
            key={t.id}
            onClick={() => {
              if (t.replyId) {
                // Tier-2 draft toasts land the gate cursor on the exact reply.
                setView("pipeline");
                setPipelineFocusReply(t.replyId);
              } else if (t.prospectId) {
                openDossierById(t.prospectId);
              }
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
            {t.body && (
              <p className={`mt-1.5 whitespace-pre-line text-[12px] leading-relaxed ${t.kind === "alert" ? "text-white/90" : "text-[#C9CCC7]"}`}>
                {t.body}
              </p>
            )}
          </button>
        ))}
      </div>

      <DossierDrawer lead={dossier} open={dossierOpen} onOpenChange={setDossierOpen} onAction={doAction} focusCompose={dossierFocusCompose} />

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
                        setPipelineFocusReply(t.replyId);
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
