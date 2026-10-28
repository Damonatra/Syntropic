'use client';

/**
 * Syntropic Backbone — Layer 4 Command Tower.
 * Fully wired to the SQLite/Prisma backbone APIs (R-01…R-07, X-1…X-3):
 *  - Ledger figures stream from /api/ledger (single source of truth).
 *  - Intercept stream polls every 2s; >$2,500 defenses fire Telegram alerts.
 *  - HITL queue handles OCR + dispatch-failure rerouting with owners.
 *  - Unified inbox persists messages; threads mark read on open.
 *  - Call room launches a real local WebRTC preview.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Activity, UploadCloud, UserCheck, MessageSquare, Calendar as CalendarIcon, Bell, Database,
  Check, CheckCircle2, Send, Video, Clock, ArrowUpRight, AlertTriangle, Mic, MicOff,
  VideoOff, PhoneOff, Loader2, Trophy, TrendingUp, DollarSign, ShieldCheck, Users,
  KeyRound, MailPlus, Ban, Copy, Eye, ShieldCheck as ShieldCheckIcon, History as HistoryIcon, Rewind,
  Plus, Link2, ExternalLink, Flag, UserX, ChevronLeft, ChevronRight, ChevronDown, X,
} from 'lucide-react';
import {
  ARTIFACT, LiveDot, ViewHeader, FilledPill, GhostPill, BlushChip, QuietChip, IntelCard,
  ArenaPanel, MarginPanel, RevsharePanel, GuaranteePanel, TrafficPanel, GeoHubPanel, ShipsLogPanel, SeasonStrip, fmtUsd,
  AuditFunnelStrip, AuditLogList,
} from './primitives';
import { parseCommand, type ParsedCommand } from '@/lib/say-it-plainly';
import type {
  CommandLogView, FounderAbsenceView, GeoIntelView, HitlAction, HitlView, InterceptView, InviteView, LedgerView, MessageView,
  PortalAccessView, ReconcileView, ScheduleSessionView, ScheduleStatus, SeasonsView, TenantView,
} from '@/lib/types';

export type BackboneTab = 'telemetry' | 'ingestion_hitl' | 'tenants_audits' | 'communications' | 'calendar_calls';

type TelegramToast = { title: string; body: string } | null;
type CallState = 'idle' | 'connecting' | 'live' | 'error';
type RevealedCode = { tenant: string; email: string; code: string; hint: string } | null;

const NAV: { id: BackboneTab; num: string; label: string; icon: React.ElementType }[] = [
  { id: 'telemetry', num: '01', label: 'Live telemetry', icon: Activity },
  { id: 'ingestion_hitl', num: '02', label: 'Ingestion & HITL', icon: UploadCloud },
  { id: 'tenants_audits', num: '03', label: 'Tenants & audits', icon: UserCheck },
  { id: 'communications', num: '04', label: 'Unified inbox', icon: MessageSquare },
  { id: 'calendar_calls', num: '05', label: 'Schedule', icon: CalendarIcon },
];

const relTime = (iso: string) => {
  const mins = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `${mins} min${mins === 1 ? '' : 's'} ago`;
  return `${Math.round(mins / 60)}h ago`;
};

/** Task 22 — compact duration voice for the verdict clock ("3h 42m"). */
const fmtDuration = (ms: number) => {
  const mins = Math.max(1, Math.round(ms / 60000));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  return mins % 60 === 0 ? `${h}h` : `${h}h ${mins % 60}m`;
};

const clockTime = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour12: false });

/* ── The operating day — grid geometry & vocabulary ─────────── */
const DAY_START_MIN = 7 * 60; // 7:00 AM
const DAY_END_MIN = 20 * 60; // 8:00 PM — the operating window
const DAY_SPAN = DAY_END_MIN - DAY_START_MIN;
const HOURS = Array.from({ length: 14 }, (_, i) => 7 + i); // 7..20 ticks
const HOUR_PX = 96; // vertical scale of the day grid — 96px per hour keeps every block readable
const GRID_H = (DAY_SPAN / 60) * HOUR_PX; // full grid body height
const hourLabel = (h: number) => (h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`);

const dayKey = (input: string | Date) => {
  const d = typeof input === 'string' ? new Date(input) : input;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const todayKey = () => dayKey(new Date());
const hm = (input: string | number | Date) =>
  new Date(input).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const minutesOf = (input: string | number | Date) => {
  const d = new Date(input);
  return d.getHours() * 60 + d.getMinutes();
};
const toTimeInput = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const hoursLabel = (mins: number) => `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
// Task 23 — inbox day separators (relTime above already voices the aging chips).
const dayLabel = (input: string | number | Date) => {
  const d = new Date(input);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
};

const STATUS_LABEL: Record<ScheduleStatus, string> = {
  SCHEDULED: 'Scheduled', CONFIRMED: 'Confirmed', LIVE: 'Live',
  COMPLETED: 'Completed', NO_SHOW: 'No-show', CANCELLED: 'Cancelled',
};

const ENGAGEMENT_TYPES = [
  '48-hr executive audit briefing', '15-min technical discovery', 'Margin review',
  'Strategy session', 'Executive briefing', 'Engine review', 'HITL war-room',
  'Ledger reconciliation', 'Founder sync',
];

const mailboxLabel: Record<TenantView['mailboxStatus'], string> = {
  ACTIVE: 'Active',
  LOCKED: 'Locked — migration window',
  MISSING: 'Not provisioned',
};

export default function SyntropicBackboneCommandTower() {
  const [activeTab, setActiveTab] = useState<BackboneTab>('telemetry');
  const [activeWidgetModal, setActiveWidgetModal] = useState<string | null>('accounts');
  const toggleWidget = (id: string) => setActiveWidgetModal((prev) => (prev === id ? null : id));

  // ── Backbone data ────────────────────────────────────────────
  const [ledger, setLedger] = useState<LedgerView | null>(null);
  const [tenants, setTenants] = useState<TenantView[]>([]);
  const [hitlQueue, setHitlQueue] = useState<HitlView[]>([]);
  const [events, setEvents] = useState<InterceptView[]>([]);
  const [messages, setMessages] = useState<MessageView[]>([]);
  // The schedule — the operating day board (sessions + founder absences).
  const [schedule, setSchedule] = useState<{ sessions: ScheduleSessionView[]; absences: FounderAbsenceView[] } | null>(null);
  // Phase 11.9 — GEO-IP intelligence slice (SSE-refreshed).
  const [geo, setGeo] = useState<GeoIntelView | null>(null);
  // The Ship's Log — append-only command journal, refreshed with the slow loop.
  const [commandLog, setCommandLog] = useState<CommandLogView[]>([]);
  // Reconciliation stamp — the station audits itself; drift must read $0.
  const [reconcile, setReconcile] = useState<ReconcileView | null>(null);
  const [reconciling, setReconciling] = useState(false);
  // Time travel — '' means live; a YYYY-MM-DD re-anchors the whole deck.
  const [timeTravel, setTimeTravel] = useState('');
  // Arena seasons — weekly head-to-head + the belt, computed from the ledger.
  const [seasons, setSeasons] = useState<SeasonsView | null>(null);

  // ── UI state ─────────────────────────────────────────────────
  const [activeChatTenant, setActiveChatTenant] = useState('Apex Piping & Supply');
  const [newMessageText, setNewMessageText] = useState('');
  // Task 23 — the composer's in-flight flag: no double sends, no lost drafts.
  const [sendingMsg, setSendingMsg] = useState(false);
  // Active operator — drives the personal workspace + arena target editing.
  const [currentUser, setCurrentUser] = useState<string>('Damon');
  const [toast, setToast] = useState<TelegramToast>(null);
  const [simulating, setSimulating] = useState(false);
  const [busyRef, setBusyRef] = useState<string | null>(null);
  // Task 22 — queue triage: the tab's filter and the inline override editor.
  const [queueFilter, setQueueFilter] = useState<'pending' | 'all' | 'resolved'>('pending');
  const [overrideOpen, setOverrideOpen] = useState<string | null>(null);
  const [overrideDraft, setOverrideDraft] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seenEvents = useRef<Set<string> | null>(null);
  const seenHitl = useRef<Set<string> | null>(null);
  const activeTenantRef = useRef(activeChatTenant);
  // Task 23 — the tower thread pins to the newest message (ref below), like
  // the enclave's direct line already does; a growing thread must not hide
  // the latest turn.
  // Inbox honesty plumbing: the poll loop and the SSE listeners read the
  // visible tab through a ref (the loops are mounted once), and markRead
  // guards against no-op writes without re-binding to the messages array.
  const activeTabRef = useRef<BackboneTab>('telemetry');
  const messagesRef = useRef<MessageView[]>([]);
  const threadScrollRef = useRef<HTMLDivElement | null>(null);

  // Portal invite management (Tenants tab) — issue, reveal-once, revoke.
  const [invites, setInvites] = useState<InviteView[]>([]);
  const [portalAccess, setPortalAccess] = useState<PortalAccessView[]>([]);
  const [revealedCode, setRevealedCode] = useState<RevealedCode>(null);
  const [inviteBusy, setInviteBusy] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);
  // Task 18 — per-tenant ship's-log trail on the tenant cards (one open at a time).
  const [trailTenant, setTrailTenant] = useState<string | null>(null);

  // ── WebRTC call room (R-07) ──────────────────────────────────
  const [callState, setCallState] = useState<CallState>('idle');
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  // ICE configuration pulled once from /api/rtc/config — STUN always,
  // TURN relay when TURN_URL/USERNAME/CREDENTIAL env is set.
  const rtcConfigRef = useRef<{ iceServers: RTCIceServer[]; turnConfigured: boolean } | null>(null);
  const [rtcMode, setRtcMode] = useState<'local' | 'turn' | null>(null);
  const [relayCount, setRelayCount] = useState(0);
  const pcRef = useRef<RTCPeerConnection | null>(null);

  const showToast = useCallback((title: string, body: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ title, body });
    toastTimer.current = setTimeout(() => setToast(null), 4200);
  }, []);

  // Active-operator persistence + quarterly target adjustments (PATCH /api/team/[id]).
  useEffect(() => {
    const saved = window.localStorage.getItem('backbone.currentUser');
    if (saved && ['Damon', 'Josias'].includes(saved)) setCurrentUser(saved);
  }, []);
  const switchUser = (name: string) => {
    setCurrentUser(name);
    window.localStorage.setItem('backbone.currentUser', name);
  };

  const fetchJson = useCallback(async <T,>(url: string, init?: RequestInit): Promise<T> => {
    const res = await fetch(url, { cache: 'no-store', ...init });
    if (!res.ok) throw new Error(`${url} → ${res.status}`);
    return res.json() as Promise<T>;
  }, []);

  const handleUpdateTarget = useCallback(
    async (memberId: string, nextTarget: number) => {
      // Optimistic tick; server reconciliation follows via the 6s slow poll.
      setLedger((prev) =>
        prev
          ? { ...prev, team: prev.team.map((m) => (m.id === memberId ? { ...m, qOutboundTarget: nextTarget } : m)) }
          : prev,
      );
      try {
        await fetchJson(`/api/team/${memberId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ qOutboundTarget: nextTarget, actor: currentUser }),
        });
        showToast('Target updated', `Quarterly outbound target set to ${nextTarget.toLocaleString()} — persisted to the backbone and signed in the ship's log.`);
      } catch {
        showToast('Update failed', 'Could not persist the target — the next poll will restore the server value.');
      }
    },
    [fetchJson, showToast, currentUser],
  );

  const refreshIntercept = useCallback(
    async (detect: boolean) => {
      const rows = await fetchJson<InterceptView[]>('/api/intercept');
      if (detect && seenEvents.current) {
        for (const e of rows) {
          if (!seenEvents.current.has(e.id) && e.diffCents > 250_000) {
            showToast(
              'High-value intercept detected',
              `+${fmtUsd(e.diffCents, true)} defended on ${e.tenantName} — Telegram alert dispatched to the stream.`,
            );
          }
        }
      }
      seenEvents.current = new Set(rows.map((r) => r.id));
      setEvents(rows);
    },
    [fetchJson, showToast],
  );

  const refreshHitl = useCallback(
    async (detect: boolean) => {
      const rows = await fetchJson<HitlView[]>('/api/hitl');
      if (detect && seenHitl.current) {
        for (const i of rows) {
          if (seenHitl.current.has(i.id)) continue;
          if (i.kind === 'DISPATCH_FAILURE') {
            showToast(
              'Dispatch failure rerouted to HITL',
              `${i.ref} · ${i.tenantName} — ${i.failureReason === 'MAILBOX_NOT_FOUND' ? 'mailbox not found' : 'mailbox locked'}. Manual resolution required.`,
            );
          } else {
            showToast(
              'Low-confidence OCR item queued',
              `${i.ref} · ${i.tenantName} — confidence ${i.confidenceScore}% <95. Telegram alert dispatched.`,
            );
          }
        }
      }
      seenHitl.current = new Set(rows.map((r) => r.id));
      setHitlQueue(rows);
    },
    [fetchJson, showToast],
  );

  // Task 23 — refreshMessages is shared by the poll loop, the SSE listeners
  // and the composer, so every path lands on the same state.
  const refreshMessages = useCallback(async () => {
    try {
      setMessages(await fetchJson<MessageView[]>('/api/messages'));
    } catch {
      // Polling loop will resync.
    }
  }, [fetchJson]);

  // Task 23 — the Seen receipt only fires when a human is actually looking:
  // no no-op writes, and the poll loop never clears a flag behind the
  // operator's back while another tab is on screen.
  const markRead = useCallback(async (tenant: string) => {
    if (!messagesRef.current.some((m) => m.tenantName === tenant && m.unread)) return;
    await fetch('/api/messages/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantName: tenant }),
    }).catch(() => undefined);
  }, []);

  // Invite management (issue / reveal-once / revoke) against /api/invites.
  const refreshInvites = useCallback(async () => {
    const data = await fetchJson<{ invites: InviteView[]; access: PortalAccessView[] }>('/api/invites');
    setInvites(data.invites);
    setPortalAccess(data.access);
  }, [fetchJson]);

  useEffect(() => {
    if (activeTab === 'tenants_audits') refreshInvites().catch(() => undefined);
  }, [activeTab, refreshInvites]);

  const issueInvite = useCallback(
    async (tenantName: string) => {
      setInviteBusy(tenantName);
      setCopiedCode(false);
      try {
        const data = await fetchJson<{ invite: InviteView; code: string }>('/api/invites', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tenantName, issuedBy: currentUser }),
        });
        setRevealedCode({ tenant: tenantName, email: data.invite.email, code: data.code, hint: data.invite.codeHint });
        await refreshInvites();
        showToast('Invite issued', `Fresh access code for ${tenantName} — outboxed to ${data.invite.email} (simulated SMTP). Shown once below.`);
      } catch {
        showToast('Invite failed', 'Could not issue the invite — check the dev log and retry.');
      } finally {
        setInviteBusy(null);
      }
    },
    [currentUser, fetchJson, refreshInvites, showToast],
  );

  const revokeAccess = useCallback(
    async (tenantName: string) => {
      setInviteBusy(tenantName);
      try {
        await fetchJson('/api/invites', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tenantName, action: 'revoke', issuedBy: currentUser }),
        });
        setRevealedCode((prev) => (prev?.tenant === tenantName ? null : prev));
        await refreshInvites();
        showToast('Portal access disabled', `${tenantName} — code revoked, live enclave sessions invalidated. The next sign-in will be refused.`);
      } catch {
        showToast('Revoke failed', 'Could not disable portal access — check the dev log and retry.');
      } finally {
        setInviteBusy(null);
      }
    },
    [currentUser, fetchJson, refreshInvites, showToast],
  );

  const copyRevealed = useCallback(() => {
    if (!revealedCode) return;
    navigator.clipboard?.writeText(revealedCode.code).catch(() => undefined);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  }, [revealedCode]);

  const refreshSlow = useCallback(async () => {
    const asOfQuery = timeTravel ? `?asOf=${encodeURIComponent(timeTravel)}` : '';
    const [l, t, m, board] = await Promise.all([
      fetchJson<LedgerView>(`/api/ledger${asOfQuery}`),
      fetchJson<TenantView[]>('/api/tenants'),
      fetchJson<MessageView[]>('/api/messages'),
      fetchJson<{ sessions: ScheduleSessionView[]; absences: FounderAbsenceView[] }>('/api/calls'),
    ]);
    setLedger(l);
    setTenants(t);
    setMessages(m);
    setSchedule(board);
    fetchJson<CommandLogView[]>(`/api/command-log?limit=60${timeTravel ? `&asOf=${encodeURIComponent(timeTravel)}` : ''}`)
      .then(setCommandLog)
      .catch(() => undefined);
    // Seasons are ledger-derived — the live board only; history doesn't travel.
    if (!timeTravel) {
      fetchJson<SeasonsView>('/api/arena/seasons').then(setSeasons).catch(() => undefined);
    }
    return m;
  }, [fetchJson, timeTravel]);

  // Geo slice re-pull — called on load and every time the SSE stream
  // carries a landing/enclave traffic event (Phase 11.9 live geo stream).
  const refreshGeo = useCallback(async () => {
    try {
      setGeo(await fetchJson<GeoIntelView>('/api/backbone/geo'));
    } catch {
      // Slice unavailable — the panel keeps its last computed snapshot.
    }
  }, [fetchJson]);

  // Reconciliation — recompute every headline figure through independent
  // code paths and stamp the masthead. Clicking the pill re-runs the audit.
  const runReconcile = useCallback(
    async (announce: boolean) => {
      setReconciling(true);
      try {
        const result = await fetchJson<ReconcileView>('/api/ledger/reconcile');
        setReconcile(result);
        if (announce) {
          const failed = result.checks.filter((c) => !c.match);
          showToast(
            result.ok ? 'Books reconciled' : 'Drift detected',
            result.ok
              ? `${result.checks.length} independent checks passed — every figure recomputed from raw rows, drift $0. Logged to the ship's log.`
              : `${failed.length} check(s) disagree: ${failed.map((f) => f.key).join(', ')}. The masthead stamp stays red until the ledger answers for it.`,
          );
        }
      } catch {
        if (announce) showToast('Reconciliation failed', 'The self-audit could not complete — check the dev log and retry.');
      } finally {
        setReconciling(false);
      }
    },
    [fetchJson, showToast],
  );

  // Initial load + polling loops (2s intercept SLA · 6s ledger/comms).
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await refreshIntercept(false);
        await refreshSlow();
        await refreshHitl(false);
        await refreshGeo();
      } catch {
        // Backend warming up — polling loops will recover.
      }
    })();
    runReconcile(false);
    const fast = setInterval(() => { refreshIntercept(true).catch(() => undefined); }, 2000);
    const slow = setInterval(() => {
      (async () => {
        try {
          const m = await refreshSlow();
          await refreshHitl(true);
          if (!alive) return;
          // Task 23 — auto-read only while the inbox is the visible tab.
          // From any other tab a client message keeps its unread flag (and
          // its rail badge) until someone actually opens the thread.
          const tenant = activeTenantRef.current;
          if (activeTabRef.current === 'communications' && m.some((x) => x.tenantName === tenant && x.unread)) {
            await markRead(tenant);
            setMessages(await fetchJson<MessageView[]>('/api/messages'));
          }
        } catch {
          // Transient — next tick retries.
        }
      })();
    }, 6000);
    return () => {
      alive = false;
      clearInterval(fast);
      clearInterval(slow);
    };
  }, [refreshIntercept, refreshSlow, refreshHitl, refreshGeo, markRead, fetchJson, runReconcile]);

  // SSE push layer — the traffic event refreshes the geo slice instantly
  // (landing surfaces + enclave logins/uploads appear within one beat).
  useEffect(() => {
    const es = new EventSource('/api/telemetry/stream');
    const onTraffic = () => {
      refreshGeo().catch(() => undefined);
      // Nudge the funnel card too — the 6s poll reconciles the rest.
      fetchJson<LedgerView>('/api/ledger').then(setLedger).catch(() => undefined);
    };
    es.addEventListener('traffic', onTraffic);
    // Task 23 — the inbox joins the push layer: client and team messages now
    // land on the tower in one beat (the enclave already streamed; the tower
    // used to wait out the 6s poll). While the inbox is the visible tab, a
    // message on the open thread is read on arrival — the client's Seen
    // receipt stays truthful because a human is on screen.
    const onMessage = (ev: MessageEvent) => {
      void refreshMessages();
      try {
        const data = JSON.parse(String(ev.data)) as { tenantName?: string };
        if (data.tenantName && data.tenantName === activeTenantRef.current && activeTabRef.current === 'communications') {
          void markRead(data.tenantName).then(refreshMessages);
        }
      } catch {
        // Malformed frame — the poll loop resyncs.
      }
    };
    es.addEventListener('message', onMessage as EventListener);
    es.addEventListener('thread-read', () => void refreshMessages());
    return () => {
      es.removeEventListener('traffic', onTraffic);
      es.removeEventListener('message', onMessage as EventListener);
      es.close();
    };
  }, [refreshGeo, fetchJson, refreshMessages, markRead]);

  // Task 23 — the open thread marks itself read on switch; the poll loop and
  // SSE handlers keep it read while the inbox stays on screen.
  useEffect(() => {
    activeTabRef.current = activeTab;
    if (activeTab === 'communications') {
      void markRead(activeTenantRef.current).then(refreshMessages);
    }
  }, [activeTab, markRead, refreshMessages]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    activeTenantRef.current = activeChatTenant;
    (async () => {
      await markRead(activeChatTenant);
      await refreshMessages();
    })();
  }, [activeChatTenant, markRead, refreshMessages]);

  // Task 23 — the default thread follows the tenant list, not a hardcoded name.
  useEffect(() => {
    if (tenants.length > 0 && !tenants.some((t) => t.name === activeChatTenant)) {
      setActiveChatTenant(tenants[0].name);
    }
  }, [tenants, activeChatTenant]);

  // ── Actions ──────────────────────────────────────────────────
  const act = useCallback(
    async (ref: string, action: HitlAction, opts?: { sku?: string }) => {
      setBusyRef(ref);
      try {
        const data = await fetchJson<{ dispatch?: { status: string; reason?: string; failureRef?: string }; alertDelivery?: string }>(
          `/api/hitl/${encodeURIComponent(ref)}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, actor: currentUser, ...(opts?.sku ? { sku: opts.sku } : {}) }),
          },
        );
        await Promise.all([refreshHitl(true), refreshIntercept(true), refreshSlow()]);
        if (action === 'RETRY' && data.dispatch?.status === 'FAILED') {
          showToast('Retry blocked', `${ref} — mailbox still locked. Item remains in the HITL queue for manual resolution.`);
        } else if (action === 'APPROVE' && data.dispatch?.status === 'DISPATCHED') {
          showToast('Verified & dispatched', `${ref} approved — margin defended now attached to the client portal ledger.`);
        } else if (action === 'RETRY' && data.dispatch?.status === 'DISPATCHED') {
          showToast('Dispatch restored', `${ref} — mailbox reachable again, draft delivered. Failure resolved.`);
        } else if (action === 'OVERRIDE') {
          setOverrideOpen(null);
          setOverrideDraft('');
          showToast(
            'Override recorded',
            opts?.sku
              ? `${ref} — corrected SKU stored. The Ship's Log keeps the before → after.`
              : `${ref} — manual review retained; the low-confidence parse is set aside.`,
          );
        } else if (action === 'NOTIFY') {
          showToast('Owner re-notified', `${ref} — Telegram delivery: ${data.alertDelivery ?? 'UNKNOWN'}.`);
        }
      } catch {
        showToast('Action failed', `${ref} could not be ${action.toLowerCase()}d — check the dev log and retry.`);
      } finally {
        setBusyRef(null);
      }
    },
    [fetchJson, refreshHitl, refreshIntercept, refreshSlow, showToast, currentUser],
  );

  const handleSimulate = useCallback(async () => {
    setSimulating(true);
    try {
      await fetchJson('/api/intercept/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actor: currentUser }),
      });
      await Promise.all([refreshIntercept(true), refreshHitl(true), refreshSlow()]);
    } catch {
      showToast('Simulation failed', 'Inbound RFQ could not be ingested — check the dev log.');
    } finally {
      setSimulating(false);
    }
  }, [fetchJson, refreshHitl, refreshIntercept, refreshSlow, showToast, currentUser]);

  // ── The schedule — the operating day (tab 05) ────────────────
  const [schedDay, setSchedDay] = useState('');
  const [schedView, setSchedView] = useState<'day' | 'week'>('day');
  const [statusFilter, setStatusFilter] = useState<ScheduleStatus | 'AT_RISK' | null>(null);
  const [openBlock, setOpenBlock] = useState<ScheduleSessionView | null>(null);
  const [creating, setCreating] = useState(false);
  const [absenceFor, setAbsenceFor] = useState<string | null>(null);
  const [schedBusy, setSchedBusy] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [nowMs, setNowMs] = useState<number | null>(null);
  const [resched, setResched] = useState<{ start: string; end: string } | null>(null);
  const [linkDraft, setLinkDraft] = useState('');
  const [notesDraft, setNotesDraft] = useState('');
  const [absenceReason, setAbsenceReason] = useState('SICK');
  const [absenceNote, setAbsenceNote] = useState('');
  const [draft, setDraft] = useState({
    clientName: '', type: ENGAGEMENT_TYPES[0], date: '', start: '10:00', durMin: 30,
    hostId: '', joinUrl: '', notes: '', internal: false,
  });

  // Wall-clock tick — drives the now-line and the header clock (mounted
  // only, so SSR and hydration never disagree about the time).
  useEffect(() => {
    setNowMs(Date.now());
    setSchedDay((prev) => prev || todayKey());
    const tick = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(tick);
  }, []);

  const patchEngagement = useCallback(
    async (id: string, patch: Record<string, unknown>, announce?: { title: string; body: string }) => {
      setSchedBusy(true);
      try {
        const data = await fetchJson<{ session: ScheduleSessionView }>(`/api/calls/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...patch, actor: currentUser }),
        });
        setOpenBlock((prev) => (prev && prev.id === id ? data.session : prev));
        await refreshSlow();
        if (announce) showToast(announce.title, announce.body);
        return data.session;
      } catch {
        showToast('Schedule update failed', 'The engagement could not be updated — check the dev log and retry.');
        return null;
      } finally {
        setSchedBusy(false);
      }
    },
    [fetchJson, refreshSlow, showToast, currentUser],
  );

  const createEngagement = useCallback(
    async (payload: Record<string, unknown>) => {
      setSchedBusy(true);
      try {
        const data = await fetchJson<{ session: ScheduleSessionView }>('/api/calls', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...payload, actor: currentUser }),
        });
        await refreshSlow();
        setCreating(false);
        showToast(
          'Engagement scheduled',
          `${data.session.clientName} — ${data.session.type} at ${hm(data.session.scheduledAt)} · signed into the ship's log.`,
        );
      } catch {
        showToast('Could not schedule', 'The engagement was not created — check the dev log and retry.');
      } finally {
        setSchedBusy(false);
      }
    },
    [fetchJson, refreshSlow, showToast, currentUser],
  );

  const markUnavailable = useCallback(
    async (memberId: string) => {
      setSchedBusy(true);
      try {
        const data = await fetchJson<{ moved: number; toName: string | null; absence: FounderAbsenceView }>('/api/calls/absence', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ memberId, reason: absenceReason, note: absenceNote, day: schedDay || todayKey(), actor: currentUser }),
        });
        await refreshSlow();
        setAbsenceFor(null);
        setAbsenceNote('');
        showToast(
          `${data.absence.memberName} is out`,
          data.moved > 0
            ? `${data.moved} engagement${data.moved === 1 ? '' : 's'} reassigned to ${data.toName} — printed on the banner, remembered by the ship's log.`
            : data.absence.reassignments + '.',
        );
      } catch {
        showToast('Could not mark unavailable', 'Check the dev log and retry.');
      } finally {
        setSchedBusy(false);
      }
    },
    [absenceNote, absenceReason, fetchJson, refreshSlow, showToast, currentUser, schedDay],
  );

  const markAvailable = useCallback(
    async (absenceId: string) => {
      setSchedBusy(true);
      try {
        await fetchJson('/api/calls/absence', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: absenceId, actor: currentUser }),
        });
        await refreshSlow();
        showToast('Founder returned', 'The day stays as it was handled — engagements keep the hosts that covered them.');
      } catch {
        showToast('Could not update', 'Check the dev log and retry.');
      } finally {
        setSchedBusy(false);
      }
    },
    [fetchJson, refreshSlow, showToast, currentUser],
  );

  const copyJoin = (url: string) => {
    navigator.clipboard?.writeText(url).catch(() => undefined);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  };

  const openEngagement = (s: ScheduleSessionView) => {
    setOpenBlock(s);
    setResched(null);
    setLinkDraft('');
    setNotesDraft(s.notes);
  };

  const applyResched = async () => {
    if (!openBlock || !resched) return;
    const base = new Date(openBlock.scheduledAt);
    const [sh, sm] = resched.start.split(':').map(Number);
    const [eh, em] = resched.end.split(':').map(Number);
    if ([sh, sm, eh, em].some((n) => Number.isNaN(n))) return;
    const start = new Date(base);
    start.setHours(sh, sm, 0, 0);
    const end = new Date(start);
    end.setHours(eh, em, 0, 0);
    if (end.getTime() <= start.getTime()) {
      showToast('Check the times', 'The end must come after the start — the day refuses impossible blocks.');
      return;
    }
    await patchEngagement(openBlock.id, { scheduledAt: start.toISOString(), endsAt: end.toISOString() }, {
      title: 'Engagement moved',
      body: `${openBlock.clientName} now sits at ${hm(start)}–${hm(end)} — the move is signed into the ship's log.`,
    });
    setResched(null);
  };

  const submitCreate = async () => {
    const [hh, mm] = draft.start.split(':').map(Number);
    if (Number.isNaN(hh) || Number.isNaN(mm)) return;
    const start = new Date(`${draft.date || todayKey()}T00:00:00`);
    start.setHours(hh, mm, 0, 0);
    const end = new Date(start.getTime() + draft.durMin * 60_000);
    const clientName = draft.internal ? 'Internal' : draft.clientName;
    if (!clientName) {
      showToast('Pick a client', 'Choose which tenant the engagement belongs to — or mark it internal.');
      return;
    }
    await createEngagement({
      clientName,
      type: draft.type,
      scheduledAt: start.toISOString(),
      endsAt: end.toISOString(),
      hostId: draft.hostId || null,
      joinUrl: draft.joinUrl.trim() || null,
      notes: draft.notes,
      isInternal: draft.internal,
    });
    setDraft((d) => ({ ...d, joinUrl: '', notes: '' }));
  };


  // Task 23 — one sender for the composer and the command line. Fails loudly:
  // a refused send keeps the draft, toasts, and logs nothing (the server only
  // signs MESSAGE_SENT rows it actually persisted).
  const sendMessageTo = useCallback(
    async (tenantName: string, text: string): Promise<boolean> => {
      try {
        await fetchJson('/api/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tenantName, text, actor: currentUser }),
        });
        await refreshMessages();
        return true;
      } catch {
        return false;
      }
    },
    [currentUser, fetchJson, refreshMessages],
  );

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = newMessageText.trim();
    if (!text || sendingMsg) return;
    setSendingMsg(true);
    const ok = await sendMessageTo(activeChatTenant, text);
    setSendingMsg(false);
    if (ok) {
      setNewMessageText('');
    } else {
      showToast('Message not sent', `The direct line to ${activeChatTenant} refused the send — your draft is kept in the composer. Check the connection and try again.`);
    }
  };

  // ── Say it plainly — the command line (the station listens) ──
  const [commandInput, setCommandInput] = useState('');
  const [commandDraft, setCommandDraft] = useState<ParsedCommand | null>(null);
  const [commandBusy, setCommandBusy] = useState(false);

  const submitCommand = (e: React.FormEvent) => {
    e.preventDefault();
    if (!commandInput.trim()) return;
    const draft = parseCommand(commandInput, {
      currentUser,
      teamNames: ledger?.team.map((m) => m.name) ?? [],
      tenantNames: tenants.map((t) => t.name),
      hitlRefs: hitlQueue.filter((h) => h.status === 'PENDING').map((h) => h.ref),
    });
    setCommandDraft(draft);
  };

  const executeCommand = async () => {
    if (!commandDraft || commandDraft.kind === 'unknown') return;
    setCommandBusy(true);
    try {
      if (commandDraft.kind === 'target') {
        const member = ledger?.team.find((m) => m.name === commandDraft.memberName);
        if (member) await handleUpdateTarget(member.id, commandDraft.target);
      } else if (commandDraft.kind === 'hitl') {
        await act(commandDraft.ref, commandDraft.action);
      } else if (commandDraft.kind === 'invite') {
        await issueInvite(commandDraft.tenantName);
      } else if (commandDraft.kind === 'message') {
        const ok = await sendMessageTo(commandDraft.tenantName, commandDraft.text);
        if (ok) {
          showToast('Message sent', `Delivered to the ${commandDraft.tenantName} enclave line — signed in the ship's log.`);
        } else {
          showToast('Message not sent', `${commandDraft.tenantName} — the direct line refused the send. Nothing was logged; try again.`);
        }
        refreshSlow().catch(() => undefined);
      }
      setCommandDraft(null);
      setCommandInput('');
    } finally {
      setCommandBusy(false);
    }
  };

  // ── WebRTC handlers ──────────────────────────────────────────
  const launchRoom = useCallback(async () => {
    setCallState('connecting');
    try {
      // R-07: resolve ICE servers (STUN + optional TURN relay) before the room opens.
      let rtc = rtcConfigRef.current;
      if (!rtc) {
        const res = await fetch('/api/rtc/config', { cache: 'no-store' }).catch(() => null);
        const data: unknown = res && res.ok ? await res.json().catch(() => null) : null;
        const raw = (data as { iceServers?: unknown; turnConfigured?: unknown }) ?? {};
        rtc = {
          iceServers: Array.isArray(raw.iceServers) ? (raw.iceServers as RTCIceServer[]) : [],
          turnConfigured: Boolean(raw.turnConfigured),
        };
        rtcConfigRef.current = rtc;
        setRtcMode(rtc.turnConfigured ? 'turn' : 'local');
      }

      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localStreamRef.current = stream;
      setMicOn(true);
      setCamOn(true);

      // With TURN configured, warm a real peer connection and gather relay
      // candidates so the room can be joined via the relay behind strict NATs.
      if (rtc.turnConfigured && typeof RTCPeerConnection !== 'undefined') {
        pcRef.current?.close();
        const pc = new RTCPeerConnection({ iceServers: rtc.iceServers });
        pcRef.current = pc;
        stream.getTracks().forEach((track) => pc.addTrack(track, stream));
        pc.createOffer().then((offer) => pc.setLocalDescription(offer)).catch(() => undefined);
        setRelayCount(0);
        pc.addEventListener('icecandidate', (ev) => {
          if (ev.candidate?.candidate.includes('typ relay')) setRelayCount((n) => n + 1);
        });
      }
      setCallState('live');
    } catch {
      setCallState('error');
    }
  }, []);

  useEffect(() => {
    if (callState === 'live' && videoRef.current && localStreamRef.current) {
      videoRef.current.srcObject = localStreamRef.current;
    }
  }, [callState]);

  const endCall = useCallback(() => {
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    pcRef.current?.close();
    pcRef.current = null;
    setCallState('idle');
  }, []);

  const toggleMic = () => {
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (track) { track.enabled = !track.enabled; setMicOn(track.enabled); }
  };
  const toggleCam = () => {
    const track = localStreamRef.current?.getVideoTracks()[0];
    if (track) { track.enabled = !track.enabled; setCamOn(track.enabled); }
  };
  useEffect(() => () => { localStreamRef.current?.getTracks().forEach((t) => t.stop()); }, []);

  // ── Derived ──────────────────────────────────────────────────
  // Task 22 — the queue's weight, arranged from the same rows the tab renders.
  // No second source: the strip, the chips, and the cards all read hitlQueue.
  const pendingItems = hitlQueue.filter((i) => i.status === 'PENDING');
  const pendingCount = pendingItems.length;
  const resolvedItems = hitlQueue.filter((i) => i.status !== 'PENDING');
  const awaitingCents = pendingItems.reduce((s, i) => s + i.extractedMarginLossCents, 0);
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const verifiedToday = resolvedItems.filter((i) => i.status === 'APPROVED' && new Date(i.updatedAt) >= dayStart);
  const verifiedTodayCents = verifiedToday.reduce((s, i) => s + i.extractedMarginLossCents, 0);
  const verdictDurations = resolvedItems.map((i) => Math.max(0, +new Date(i.updatedAt) - +new Date(i.createdAt)));
  const avgVerdictMs = verdictDurations.length
    ? verdictDurations.reduce((a, b) => a + b, 0) / verdictDurations.length
    : null;
  const activeTenant = tenants.find((t) => t.name === activeChatTenant);
  const visibleMessages = messages.filter((m) => m.tenantName === activeChatTenant);
  // Task 23 — the inbox is arranged from the same rows the thread renders (no
  // second source, no new queries): unread-first, then most-recent activity.
  const unreadTotal = messages.filter((m) => m.unread).length;
  const channels = tenants
    .map((t) => {
      const thread = messages.filter((m) => m.tenantName === t.name);
      const last = thread[thread.length - 1];
      return {
        name: t.name,
        unread: thread.filter((m) => m.unread).length,
        lastText: last?.text ?? null,
        lastDirection: (last?.direction ?? null) as 'team' | 'client' | null,
        lastIso: last?.createdAt ?? null,
        lastAtMs: last ? +new Date(last.createdAt) : 0,
      };
    })
    .sort((a, b) => Number(b.unread > 0) - Number(a.unread > 0) || b.lastAtMs - a.lastAtMs);
  const activeChannel = channels.find((c) => c.name === activeChatTenant) ?? null;

  // Task 23 — pin the thread to the newest message on arrival and on switch
  // (defined here because it reads the derived thread length).
  useEffect(() => {
    const el = threadScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visibleMessages.length, activeChatTenant]);
  // Time-travel mode — the ledger panels re-anchor; the live wire stays present.
  const traveling = Boolean(ledger?.asOf);

  // ── Schedule derived — the operating day ─────────────────────
  const hosts = ledger?.team ?? [];
  const yOf = (min: number) => ((Math.min(DAY_END_MIN, Math.max(DAY_START_MIN, min)) - DAY_START_MIN) / 60) * HOUR_PX;
  const endMinOf = (s: ScheduleSessionView) =>
    Math.min(DAY_END_MIN, s.endsAt ? minutesOf(s.endsAt) : minutesOf(s.scheduledAt) + 30);
  const durOf = (s: ScheduleSessionView) => Math.max(0, endMinOf(s) - Math.max(DAY_START_MIN, minutesOf(s.scheduledAt)));
  const durLabel = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m}m`);
  const isTodayView = Boolean(schedDay) && schedDay === todayKey();
  const nowY = isTodayView && nowMs ? yOf(minutesOf(nowMs)) : null;
  const dayTitle = schedDay
    ? new Date(`${schedDay}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
    : '';
  const shiftDay = (delta: number) => {
    if (!schedDay) return;
    const d = new Date(`${schedDay}T12:00:00`);
    d.setDate(d.getDate() + delta);
    setSchedDay(dayKey(d));
  };
  const weekDays = (() => {
    if (!schedDay) return [] as string[];
    const base = new Date(`${schedDay}T12:00:00`);
    const monday = new Date(base);
    monday.setDate(base.getDate() - ((base.getDay() + 6) % 7));
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      return dayKey(d);
    });
  })();
  const daySessions = (schedule?.sessions ?? []).filter((s) => dayKey(s.scheduledAt) === schedDay && s.status !== 'CANCELLED');
  const statusCounts = daySessions.reduce<Record<string, number>>((acc, s) => {
    acc[s.status] = (acc[s.status] ?? 0) + 1;
    return acc;
  }, {});
  const atRiskCount = daySessions.filter((s) => s.atRiskReasons.length > 0).length;
  const shownSessions = statusFilter
    ? daySessions.filter((s) => (statusFilter === 'AT_RISK' ? s.atRiskReasons.length > 0 : s.status === statusFilter))
    : daySessions;
  const unowned = daySessions.filter((s) => !s.hostId);
  const dayAbsences = (schedule?.absences ?? []).filter((a) => a.day === schedDay && !a.resolvedAt);
  const minutesFor = (hostId: string) =>
    daySessions
      .filter((s) => s.hostId === hostId)
      .reduce((acc, s) => acc + Math.max(0, endMinOf(s) - minutesOf(s.scheduledAt)), 0);
  const foundersOnShift = Math.max(0, hosts.length - dayAbsences.length);
  const rows: { key: string; memberId: string | null; memberName: string; tone: 'ink' | 'blush' | 'steel'; blocks: ScheduleSessionView[]; absent: FounderAbsenceView | null }[] = [
    ...hosts.map((m) => ({
      key: m.id,
      memberId: m.id,
      memberName: m.fullName || m.name,
      tone: m.tone,
      blocks: shownSessions.filter((s) => s.hostId === m.id),
      absent: dayAbsences.find((a) => a.memberId === m.id) ?? null,
    })),
    ...(shownSessions.some((s) => !s.hostId)
      ? [{ key: 'unassigned', memberId: null as string | null, memberName: 'Needs an owner', tone: 'steel' as const, blocks: shownSessions.filter((s) => !s.hostId), absent: null as FounderAbsenceView | null }]
      : []),
  ];
  const prepBufferShown = (s: ScheduleSessionView, siblings: ScheduleSessionView[]) =>
    !s.isInternal &&
    (s.status === 'SCHEDULED' || s.status === 'CONFIRMED' || s.status === 'LIVE') &&
    minutesOf(s.scheduledAt) - 15 >= DAY_START_MIN &&
    !siblings.some((p) => p.id !== s.id && minutesOf(p.scheduledAt) < minutesOf(s.scheduledAt) && endMinOf(p) > minutesOf(s.scheduledAt) - 15);
  const blockTone = (s: ScheduleSessionView) => {
    if (s.status === 'LIVE') return 'bg-blush border-sienna/40 text-sienna';
    if (s.status === 'NO_SHOW') return 'bg-fog border-hairline text-ash line-through';
    if (s.status === 'CANCELLED') return 'bg-fog border-hairline text-ash opacity-60 line-through';
    if (s.status === 'COMPLETED') return s.isInternal ? 'bg-mist border-hairline text-smoke' : 'bg-fog border-hairline text-smoke';
    if (s.isInternal) return 'bg-mist border-dashed border-steel/40 text-steel';
    return s.atRiskReasons.length > 0
      ? 'bg-paper border-sienna/50 text-ink ring-1 ring-sienna/25'
      : 'bg-paper border-hairline text-ink shadow-[0_1px_2px_rgba(0,0,0,0.05)]';
  };
  const statusChipTone = (active: boolean, danger = false) =>
    `inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12px] font-medium transition-colors ${
      active
        ? danger
          ? 'border-sienna bg-blush text-sienna'
          : 'border-ink bg-ink text-paper'
        : 'border-hairline bg-paper text-steel hover:text-ink'
    }`;

  return (
    <div className="flex min-h-screen flex-col bg-paper text-ink selection:bg-blush selection:text-sienna">
      {/* ── Masthead ─────────────────────────────────────────────── */}
      <header className="sticky top-0 z-50 border-b border-hairline bg-paper/85 backdrop-blur-md">
        <div className="mx-auto flex h-16 w-full max-w-[1280px] items-center justify-between px-5 sm:px-8 lg:px-10">
          <div className="flex min-w-0 items-center gap-4">
            <Link href="/backbone" className="shrink-0 font-display text-[21px] leading-none tracking-[-0.01em] text-ink">
              backbone
            </Link>
            <span className="hidden text-[13px] text-smoke sm:inline">v1.9.0 · live</span>
            {/* Reconciliation stamp — the station audits itself. Click to re-run. */}
            <button
              type="button"
              onClick={() => runReconcile(true)}
              disabled={reconciling || !reconcile}
              title={reconcile ? `Self-audit ${reconcile.ok ? 'passed' : 'FLAGGED'} at ${new Date(reconcile.checkedAt).toLocaleTimeString('en-US', { hour12: false })} — click to re-run` : 'Running the self-audit…'}
              className={`hidden items-center gap-2 rounded-full border px-3 py-1.5 text-[12px] transition-colors md:inline-flex ${
                !reconcile
                  ? 'border-hairline text-smoke'
                  : reconcile.ok
                    ? 'border-hairline text-steel hover:bg-mist hover:text-ink'
                    : 'border-sienna/40 bg-blush text-sienna hover:bg-blush/80'
              }`}
            >
              {reconciling ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} /> : <ShieldCheckIcon className="h-3.5 w-3.5" strokeWidth={1.75} />}
              {reconcile
                ? reconcile.ok
                  ? `reconciled · drift $0 · ${new Date(reconcile.checkedAt).toLocaleTimeString('en-US', { hour12: false })}`
                  : `drift ${(reconcile.driftCents / 100).toFixed(2)} — flagged`
                : 'reconciling…'}
            </button>
            <span className="hidden items-center gap-2 rounded-full border border-hairline px-3 py-1.5 text-[12px] text-steel lg:inline-flex">
              <LiveDot />
              Operational · Telemetry live
            </span>
          </div>

          <div className="flex shrink-0 items-center gap-3">
            <button
              onClick={handleSimulate}
              disabled={simulating}
              className="inline-flex items-center gap-2 rounded-full border border-ink px-3.5 py-1.5 text-[13px] font-medium text-ink transition-colors hover:bg-mist disabled:opacity-50"
            >
              {simulating ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} /> : <Bell className="h-3.5 w-3.5" strokeWidth={1.75} />}
              <span className="hidden sm:inline">Simulate inbound RFQ</span>
              <span className="sm:hidden">RFQ</span>
            </button>
            <label className="hidden items-center gap-2 rounded-full border border-hairline py-1.5 pl-3 pr-2 text-[12.5px] text-steel md:inline-flex">
              <Users className="h-3.5 w-3.5" strokeWidth={1.75} />
              Active profile
              <select
                value={currentUser}
                onChange={(e) => switchUser(e.target.value)}
                aria-label="Active profile"
                className="cursor-pointer appearance-none bg-transparent pr-1 text-[12.5px] font-medium text-ink outline-none"
              >
                <option value="Damon">Damon (Lead Architect)</option>
                <option value="Josias">Josias (Execution Lead)</option>
              </select>
            </label>
            <div className="hidden items-center gap-2 text-[13px] text-steel xl:flex">
              <Database className="h-3.5 w-3.5" strokeWidth={1.75} />
              SQLite · WAL · Prisma
            </div>
          </div>
        </div>
      </header>

      {/* ── Telegram toast ───────────────────────────────────────── */}
      {toast && (
        <div
          role="status"
          className="fixed right-4 top-20 z-[60] flex max-w-sm items-start gap-3 rounded-[20px] bg-blush p-4 text-sienna shadow-[0_0_0_1px_rgba(93,42,26,0.06),0_12px_40px_rgba(0,0,0,0.14)] animate-in fade-in slide-in-from-top-2 duration-300 sm:right-8"
        >
          <Bell className="mt-0.5 h-5 w-5 shrink-0" strokeWidth={1.75} />
          <div>
            <div className="text-[13px] font-medium">{toast.title}</div>
            <div className="mt-0.5 text-[12px] leading-relaxed text-sienna/80">{toast.body}</div>
          </div>
        </div>
      )}

      {/* ── Body ─────────────────────────────────────────────────── */}
      <div className="mx-auto flex w-full max-w-[1280px] flex-1 flex-col gap-8 px-5 py-8 sm:px-8 md:flex-row md:gap-10 md:py-12 lg:px-10">
        {/* Quiet rail */}
        <aside className="shrink-0 md:w-60">
          <div className="md:sticky md:top-24">
            <div className="mb-3 text-[13px] text-ash">Command modules</div>
            <nav aria-label="Command modules" className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 md:mx-0 md:flex-col md:overflow-visible md:px-0 md:pb-0">
              {NAV.map(({ id, num, label, icon: Icon }) => {
                const active = activeTab === id;
                return (
                  <button
                    key={id}
                    onClick={() => setActiveTab(id)}
                    aria-current={active ? 'page' : undefined}
                    className={`inline-flex shrink-0 items-center gap-2.5 rounded-full px-4 py-2.5 text-[14px] transition-colors md:w-full ${
                      active ? 'bg-ink text-paper' : 'text-steel hover:bg-mist hover:text-ink'
                    }`}
                  >
                    <Icon className="h-4 w-4" strokeWidth={1.75} />
                    <span className="tabular-nums opacity-55">{num}</span>
                    <span className="whitespace-nowrap font-medium">{label}</span>
                    {id === 'ingestion_hitl' && pendingCount > 0 && (
                      <span className="ml-auto hidden h-5 min-w-5 items-center justify-center rounded-full bg-blush px-1.5 text-[11px] font-medium text-sienna md:inline-flex">
                        {pendingCount}
                      </span>
                    )}
                    {id === 'communications' && unreadTotal > 0 && (
                      <span
                        className="ml-auto hidden h-5 min-w-5 items-center justify-center rounded-full bg-blush px-1.5 text-[11px] font-medium text-sienna md:inline-flex"
                        aria-label={`${unreadTotal} unread message${unreadTotal === 1 ? '' : 's'}`}
                      >
                        {unreadTotal}
                      </span>
                    )}
                  </button>
                );
              })}
            </nav>

            {/* Personal workspace (active operator) */}
            <div className="mt-10 hidden rounded-2xl bg-mist p-4 md:block">
              <div className="mb-2.5 flex items-center justify-between">
                <span className="text-[13px] font-medium text-steel">Personal workspace</span>
                <span className="text-[11px] uppercase tracking-wide text-smoke">{currentUser}</span>
              </div>
              {(() => {
                const me = ledger?.team.find((m) => m.name === currentUser);
                const pct = me && me.qOutboundTarget > 0 ? Math.min(100, Math.round((me.qOutboundCompleted / me.qOutboundTarget) * 100)) : 0;
                return me ? (
                  <div className="space-y-2 text-[12px]">
                    <div className="flex items-center justify-between">
                      <span className="text-smoke">My outbound goal</span>
                      <span className="font-medium tabular-nums text-ink">
                        {me.qOutboundCompleted} / {me.qOutboundTarget}
                      </span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-paper">
                      <div className="h-full rounded-full bg-sienna transition-all duration-500" style={{ width: `${pct}%` }} />
                    </div>
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-smoke">Q4 progress</span>
                      <span className="tabular-nums text-steel">{pct}% completed</span>
                    </div>
                  </div>
                ) : (
                  <div className="text-[12px] text-smoke">Syncing operator…</div>
                );
              })()}
            </div>

            {/* Local storage status */}
            <div className="mt-3 hidden rounded-2xl bg-mist p-4 md:block">
              <div className="mb-2.5 text-[13px] font-medium text-steel">Local storage</div>
              <div className="space-y-2 text-[12px]">
                {[
                  ['Database', 'SQLite active'],
                  ['WAL mode', 'Enabled'],
                  ['Rev-share ledger', ledger ? `${fmtUsd(ledger.revShareCents)} defended` : 'Syncing…'],
                ].map(([k, v]) => (
                  <div key={k} className="flex items-center justify-between gap-3">
                    <span className="text-smoke">{k}</span>
                    <span className="text-right font-medium text-ink">{v}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </aside>

        {/* Workspace */}
        <main className="min-w-0 flex-1">
          {/* ════ 01 · TELEMETRY ════ */}
          {activeTab === 'telemetry' && (
            <div className="animate-in fade-in duration-300">
              <ViewHeader
                tag="System telemetry & founder intel"
                title="Agency"
                accent="command"
                rest="deck"
                sub="Live figures stream from the SQLite financial ledger. Click any widget card to inspect conversion pipelines, founder performance, and financial velocity."
              />

              {/* Time travel — the station as time machine. Every ledger panel
                  re-anchors to the chosen day; the live wire stays in the present. */}
              <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2.5 rounded-2xl bg-mist px-4 py-3">
                <span className="flex items-center gap-2 text-[13px] font-medium text-ink">
                  <Rewind className="h-3.5 w-3.5 text-sienna" strokeWidth={1.75} />
                  Time travel
                </span>
                <input
                  type="date"
                  aria-label="View the deck as of a past date"
                  value={timeTravel}
                  max={new Date().toISOString().slice(0, 10)}
                  onChange={(e) => setTimeTravel(e.target.value)}
                  className="h-8 rounded-full border border-hairline bg-paper px-3 text-[12.5px] tabular-nums text-ink outline-none transition-shadow focus-visible:shadow-[0_0_0_2px_rgba(93,42,26,0.25)]"
                />
                {timeTravel ? (
                  <>
                    <BlushChip>
                      <HistoryIcon className="h-3 w-3" strokeWidth={1.75} />
                      Viewing ledger as of {timeTravel}
                    </BlushChip>
                    <button
                      type="button"
                      onClick={() => setTimeTravel('')}
                      className="inline-flex items-center gap-1.5 rounded-full border border-ink px-3 py-1 text-[12px] font-medium text-ink transition-colors hover:bg-mist"
                    >
                      Return to live
                    </button>
                    <span className="text-[12px] text-smoke">Team counters are engine-reported live state — they don't travel.</span>
                  </>
                ) : (
                  <span className="text-[12px] text-smoke">Pick a date to re-anchor every horizon — lifetime, monthly, and the 24h delta all move with it.</span>
                )}
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
                <IntelCard
                  id="accounts"
                  active={activeWidgetModal === 'accounts'}
                  onToggle={toggleWidget}
                  icon={Trophy}
                  label="Active accounts"
                  value={<>{ledger ? ledger.activeAccounts : '—'} <span className="text-[13px] font-normal text-smoke">/ sprint target {ledger ? ledger.sprintTarget : 10}</span></>}
                  hint="Team arena — targets & conversion"
                  spark={{ id: 'spark-accounts', path: 'M2 24 C 14 22, 20 15, 30 16 S 50 22, 60 13 S 84 4, 98 7' }}
                />
                <IntelCard
                  id="margin"
                  active={activeWidgetModal === 'margin'}
                  onToggle={toggleWidget}
                  icon={TrendingUp}
                  label="Margin defended"
                  value={ledger ? fmtUsd(ledger.marginDefendedCents) : '—'}
                  hint="Client directory"
                  spark={{ id: 'spark-margin', path: 'M2 20 C 16 24, 26 12, 40 14 S 66 20, 78 10 S 92 6, 98 8' }}
                />
                <IntelCard
                  id="revshare"
                  active={activeWidgetModal === 'revshare'}
                  onToggle={toggleWidget}
                  icon={DollarSign}
                  label="Syntropic 20% rev-share"
                  value={ledger ? fmtUsd(ledger.revShareCents) : '—'}
                  hint="Financial horizons"
                  peach
                  spark={{ id: 'spark-revshare', path: 'M2 26 C 18 26, 26 18, 40 19 S 62 10, 76 12 S 92 4, 98 5' }}
                />
                <IntelCard
                  id="guarantee"
                  active={activeWidgetModal === 'guarantee'}
                  onToggle={toggleWidget}
                  icon={ShieldCheck}
                  label="Audit guarantee status"
                  value={ledger ? `${Math.round(ledger.guaranteePassRate * 100)}% passed` : '—'}
                  hint="Audit sales log"
                />
                <IntelCard
                  id="traffic"
                  active={activeWidgetModal === 'traffic'}
                  onToggle={toggleWidget}
                  icon={Eye}
                  label="Today · traffic"
                  value={ledger?.traffic ? ledger.traffic.uniqueSessions.toLocaleString('en-US') : traveling ? '—' : '0'}
                  hint={traveling ? 'Funnel — lives in the present' : "Funnel — today's intake"}
                />
              </div>

              {ledger && activeWidgetModal === 'accounts' && (
                <ArenaPanel
                  ledger={ledger}
                  currentUser={currentUser}
                  seasons={traveling ? null : seasons}
                  onUpdateTarget={handleUpdateTarget}
                  onClose={() => setActiveWidgetModal(null)}
                />
              )}
              {ledger && activeWidgetModal === 'margin' && <MarginPanel ledger={ledger} onClose={() => setActiveWidgetModal(null)} />}
              {ledger && activeWidgetModal === 'revshare' && <RevsharePanel ledger={ledger} onClose={() => setActiveWidgetModal(null)} />}
              {ledger && activeWidgetModal === 'guarantee' && (
                <GuaranteePanel
                  ledger={ledger}
                  onClose={() => setActiveWidgetModal(null)}
                  onOpenAuditBook={() => {
                    setActiveWidgetModal(null);
                    setActiveTab('tenants_audits');
                  }}
                />
              )}
              {ledger && activeWidgetModal === 'traffic' && ledger.traffic && (
                <TrafficPanel traffic={ledger.traffic} onClose={() => setActiveWidgetModal(null)} />
              )}

              {/* Phase 11.9 — Inbound industrial hubs (live geo stream). */}
              {/* Time travel leaves today's map behind — the geo slice is a present-tense artifact. */}
              {geo && !traveling && <GeoHubPanel geo={geo} />}

              {/* Intercept stream — live only. Time travel pauses the wire. */}
              {traveling ? (
                <section className={`mt-6 p-6 sm:p-8 ${ARTIFACT}`}>
                  <div className="flex items-center gap-2 text-[15px] font-medium text-ink">
                    <Activity className="h-4 w-4 text-smoke" strokeWidth={1.75} />
                    Live intercept stream
                  </div>
                  <p className="mt-2 max-w-xl text-[14px] leading-relaxed text-steel">
                    The wire only exists in the present — intercepts stream in real time and are not replayed by the ledger.
                    Return to live to watch the defense engine work; the ship's log below still shows everything as it stood on {timeTravel}.
                  </p>
                </section>
              ) : (
              <section className={`mt-6 p-2 sm:p-3 ${ARTIFACT}`}>
                <div className="flex flex-wrap items-center justify-between gap-2 px-3 pb-2 pt-2.5 sm:px-4">
                  <h2 className="flex items-center gap-2 text-[15px] font-medium text-ink">
                    <Activity className="h-4 w-4 text-sienna" strokeWidth={1.75} />
                    Live intercept stream
                    <span className="hidden font-normal text-steel sm:inline">· under 90s response SLA</span>
                  </h2>
                  <span className="text-[12px] text-smoke">Auto-refresh · 2s</span>
                </div>
                <div className="divide-y divide-hairline">
                  {events.map((log) => (
                    <div
                      key={log.id}
                      className="flex flex-col justify-between gap-2 rounded-2xl px-3 py-3 transition-colors hover:bg-fog sm:px-4 lg:flex-row lg:items-center"
                    >
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
                        <span className="tabular-nums text-smoke">{clockTime(log.createdAt)}</span>
                        <span className="rounded-full bg-mist px-2.5 py-0.5 text-[12px] text-ink">{log.tenantName}</span>
                        <span className="text-ink">{log.item}</span>
                      </div>
                      <div className="flex items-center gap-3 text-[13px]">
                        {log.origCents > 0 && <span className="tabular-nums text-smoke line-through">{fmtUsd(log.origCents, true)}</span>}
                        <span className="font-medium tabular-nums text-ink">{fmtUsd(log.defendedCents, true)}</span>
                        <span className="rounded-full bg-mist px-2.5 py-0.5 text-[12px] tabular-nums text-ink">+{fmtUsd(log.diffCents, true)}</span>
                        <span className="hidden items-center gap-1 text-[12px] text-steel md:inline-flex">
                          {log.source === 'HITL_APPROVAL' ? 'Attached via HITL approval' : `Injected into ${log.channel}`}
                          <ArrowUpRight className="h-3 w-3" strokeWidth={1.75} />
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
              )}

              {/* The Ship's Log — append-only command journal (attribution feature) */}
              <ShipsLogPanel log={commandLog} />

              {/* Say it plainly — one input, confirmable drafts, no guessing */}
              <section className={`mt-4 p-6 sm:p-8 ${ARTIFACT}`}>
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline pb-5">
                  <div>
                    <div className="text-[14px] text-ash">One input · parsed into a draft · confirmed by you</div>
                    <h3 className="mt-1.5 flex items-center gap-2.5 font-display text-[26px] font-normal leading-[1.18] tracking-[-0.01em] text-ink">
                      Say it <em className="italic">plainly</em>
                    </h3>
                  </div>
                  <span className="inline-flex items-center gap-2 rounded-full bg-mist px-3 py-1 text-[12px] font-medium text-steel">
                    Signed as {currentUser}
                  </span>
                </div>

                <form onSubmit={submitCommand} className="flex flex-col gap-2 pt-5 sm:flex-row">
                  <input
                    type="text"
                    value={commandInput}
                    onChange={(e) => setCommandInput(e.target.value)}
                    placeholder='Say it plainly — "raise my target to 180" · "approve HITL-8092" · "invite gulf to the portal"'
                    aria-label="Plain-English command line"
                    className="h-11 flex-1 rounded-2xl border border-hairline bg-fog px-4 text-[14px] text-ink transition-colors placeholder:text-smoke focus:border-ink/30 focus:bg-paper focus:outline-none"
                  />
                  <FilledPill type="submit" className="h-11 shrink-0">
                    Parse draft
                  </FilledPill>
                </form>

                {commandDraft && (
                  <div className="mt-4 animate-in fade-in slide-in-from-bottom-1 duration-200 rounded-2xl bg-fog p-4 sm:p-5">
                    {commandDraft.kind === 'unknown' ? (
                      <>
                        <div className="text-[12px] font-medium uppercase tracking-[0.06em] text-sienna">Couldn't parse that</div>
                        <p className="mt-1.5 text-[13.5px] leading-relaxed text-steel">{commandDraft.hint}</p>
                      </>
                    ) : (
                      <>
                        <div className="text-[12px] font-medium uppercase tracking-[0.06em] text-smoke">Draft command · parsed from plain English</div>
                        <div className="mt-1.5 text-[15px] font-medium text-ink">{commandDraft.summary}</div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <FilledPill onClick={executeCommand} disabled={commandBusy}>
                            {commandBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} /> : <Check className="h-3.5 w-3.5" strokeWidth={2} />}
                            Confirm & execute
                          </FilledPill>
                          <GhostPill onClick={() => setCommandDraft(null)} disabled={commandBusy}>
                            Discard
                          </GhostPill>
                        </div>
                        <p className="mt-2.5 text-[12px] text-smoke">
                          Nothing runs until you confirm — the station listens, but never acts on its own.
                        </p>
                      </>
                    )}
                  </div>
                )}

                {!commandDraft && (
                  <div className="mt-3.5 flex flex-wrap gap-x-4 gap-y-1.5 text-[12px] text-smoke">
                    <span>Try:</span>
                    {[
                      'raise my target to 180',
                      'approve HITL-8092',
                      'invite gulf to the portal',
                      "message apex saying we're on it",
                    ].map((example) => (
                      <button
                        key={example}
                        type="button"
                        onClick={() => setCommandInput(example)}
                        className="rounded-full bg-fog px-2.5 py-1 font-mono text-[11.5px] text-steel transition-colors hover:bg-mist hover:text-ink"
                      >
                        {example}
                      </button>
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}

          {/* ════ 02 · INGESTION & HITL ════ */}
          {activeTab === 'ingestion_hitl' && (
            <div className="animate-in fade-in duration-300">
              <ViewHeader
                tag="Spatial OCR & human-in-the-loop"
                title="Ingestion &"
                accent="quality"
                rest="control"
                sub="Docling spatial parsing flags every line item under 95% confidence. Telegram alerts dispatch the moment an item lands in the queue — dispatch failures reroute here, overrides capture the corrected SKU, and every verdict is signed to the Ship's Log."
              />

              {/* Task 22 — the queue's weight: pending load, dollars waiting on a
                  verdict, today's throughput, and how fast items clear. All
                  arranged from the same queue rows rendered below. */}
              <div className="mb-5 grid grid-cols-2 gap-px overflow-hidden rounded-[20px] bg-black/5 shadow-[0_0_0_1px_rgba(4,23,43,0.05),0_16px_24px_-8px_rgba(0,0,0,0.10),0_6px_10px_-6px_rgba(0,0,0,0.08)] md:grid-cols-4">
                {[
                  {
                    label: 'In the queue',
                    value: `${pendingCount}`,
                    micro: pendingCount > 0 ? 'items awaiting a verdict' : 'clear — nothing pending',
                  },
                  {
                    label: 'Awaiting verification',
                    value: fmtUsd(awaitingCents, true),
                    micro: 'identified loss on pending items',
                  },
                  {
                    // Approved ≠ attached — the mailbox gate can still fail an
                    // approval into a dispatch-failure item. The queue speaks
                    // in verdicts; the ledger alone claims attachments.
                    label: 'Approved today',
                    value: `${verifiedToday.length}`,
                    micro: `${fmtUsd(verifiedTodayCents, true)} identified on approved items`,
                  },
                  {
                    label: 'Avg time to verdict',
                    value: avgVerdictMs !== null ? fmtDuration(avgVerdictMs) : '—',
                    micro: `across ${resolvedItems.length} resolved ${resolvedItems.length === 1 ? 'item' : 'items'}`,
                  },
                ].map((s) => (
                  <div key={s.label} className="bg-paper p-5">
                    <div className="text-[11.5px] font-medium uppercase tracking-[0.08em] text-smoke">{s.label}</div>
                    <div className="mt-2 font-display text-[26px] leading-none tracking-[-0.01em] text-ink tabular-nums">{s.value}</div>
                    <div className="mt-1.5 text-[12px] text-steel">{s.micro}</div>
                  </div>
                ))}
              </div>

              <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-1.5" role="group" aria-label="Queue filter">
                  {(['pending', 'all', 'resolved'] as const).map((f) => {
                    const count = f === 'pending' ? pendingCount : f === 'resolved' ? resolvedItems.length : hitlQueue.length;
                    const active = queueFilter === f;
                    return (
                      <button
                        key={f}
                        type="button"
                        aria-pressed={active}
                        onClick={() => setQueueFilter(f)}
                        className={`cursor-pointer rounded-full px-3.5 py-1.5 text-[12.5px] transition-colors ${
                          active ? 'bg-ink font-medium text-paper' : 'text-steel hover:bg-mist'
                        }`}
                      >
                        {f === 'pending' ? 'Pending' : f === 'all' ? 'All' : 'Resolved'}
                        <span className="ml-1.5 tabular-nums opacity-70">{count}</span>
                      </button>
                    );
                  })}
                </div>
                {pendingCount > 0 ? (
                  <BlushChip>
                    <LiveDot />
                    {pendingCount} action required
                  </BlushChip>
                ) : (
                  <span className="text-[13px] text-steel">Queue clear — all items verified</span>
                )}
              </div>

              <div className="space-y-4">
                {queueFilter !== 'resolved' && (
                  <>
                    {pendingItems.map((item) => {
                      const isFailure = item.kind === 'DISPATCH_FAILURE';
                      const busy = busyRef === item.ref;
                      const ageHrs = (Date.now() - new Date(item.createdAt).getTime()) / 3600e3;
                      return (
                        <article key={item.id} className={`space-y-5 p-5 sm:p-6 ${ARTIFACT}`}>
                          <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px]">
                                <span className="font-medium text-steel">{item.ref}</span>
                                <span className="text-smoke">·</span>
                                <span className="text-steel">{item.tenantName}</span>
                                <span className="text-smoke">({relTime(item.createdAt)})</span>
                                {ageHrs >= 24 ? (
                                  <BlushChip>
                                    <AlertTriangle className="h-3 w-3" strokeWidth={1.75} />
                                    Aging · {Math.floor(ageHrs)}h in queue
                                  </BlushChip>
                                ) : ageHrs >= 4 ? (
                                  <QuietChip>{Math.floor(ageHrs)}h in queue</QuietChip>
                                ) : null}
                                {isFailure && <AlertTriangle className="h-3.5 w-3.5 text-sienna" strokeWidth={1.75} />}
                              </div>
                              <div className="mt-1.5 text-[17px] font-medium tracking-[-0.009em] text-ink">
                                {isFailure ? (item.skuParsed ?? `Draft → ${item.tenantName} mailbox`) : item.skuParsed}
                              </div>
                              <div className="mt-1 text-[13px] text-steel">
                                {isFailure ? 'Automated draft injection' : <>Source file · <span className="text-ink">{item.pdfName}</span></>}
                              </div>
                            </div>

                            <div className="shrink-0 text-left sm:text-right">
                              {isFailure ? (
                                <>
                                  <div className="text-[12px] text-steel">Dispatch failure</div>
                                  <BlushChip className="mt-1.5">
                                    <AlertTriangle className="h-3 w-3" strokeWidth={1.75} />
                                    {item.failureReason === 'MAILBOX_NOT_FOUND' ? 'Mailbox not found' : 'Mailbox locked'}
                                  </BlushChip>
                                  <div className="mt-1.5 text-[12px] text-steel">Owner · <span className="font-medium text-ink">{item.owner}</span></div>
                                </>
                              ) : (
                                <>
                                  <div className="text-[12px] text-steel">Docling confidence</div>
                                  <div className="mt-0.5 text-[22px] font-medium tabular-nums text-ink">{item.confidenceScore}%</div>
                                  {/* Task 22 — the parse against its floor: fill = confidence, tick = the 95% HITL floor. */}
                                  <div className="mt-2 flex items-center gap-2 sm:justify-end">
                                    <div className="relative h-[3px] w-24 rounded-full bg-mist">
                                      <div
                                        className="absolute inset-y-0 left-0 rounded-full bg-ash"
                                        style={{ width: `${Math.min(100, item.confidenceScore ?? 0)}%` }}
                                      />
                                      <div className="absolute -inset-y-[2px] w-px bg-sienna" style={{ left: '95%' }} />
                                    </div>
                                    <span className="text-[11px] text-smoke">floor 95</span>
                                  </div>
                                  <BlushChip className="mt-1.5">+{fmtUsd(item.extractedMarginLossCents, true)} loss identified</BlushChip>
                                </>
                              )}
                            </div>
                          </div>

                          <div className="flex flex-col gap-2.5 border-t border-black/5 pt-4 sm:flex-row sm:items-center sm:justify-end">
                            <button
                              type="button"
                              onClick={() => act(item.ref, 'NOTIFY')}
                              disabled={busy}
                              className="cursor-pointer text-left text-[13px] text-steel underline decoration-black/15 underline-offset-4 transition-colors hover:text-ink disabled:cursor-wait disabled:opacity-50 sm:mr-auto"
                            >
                              Re-notify owner
                            </button>
                            {overrideOpen === item.ref ? (
                              <>
                                <input
                                  value={overrideDraft}
                                  onChange={(e) => setOverrideDraft(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter' && overrideDraft.trim() && !busy) act(item.ref, 'OVERRIDE', { sku: overrideDraft });
                                    if (e.key === 'Escape') {
                                      setOverrideOpen(null);
                                      setOverrideDraft('');
                                    }
                                  }}
                                  autoFocus
                                  placeholder={`Corrected SKU — currently "${item.skuParsed ?? '—'}"`}
                                  aria-label={`Corrected SKU for ${item.ref}`}
                                  className="min-w-0 flex-1 rounded-full border border-black/10 bg-paper px-4 py-2.5 text-[13.5px] text-ink outline-none transition-colors placeholder:text-smoke focus:border-steel"
                                />
                                <GhostPill
                                  onClick={() => {
                                    setOverrideOpen(null);
                                    setOverrideDraft('');
                                  }}
                                  disabled={busy}
                                >
                                  Cancel
                                </GhostPill>
                                <FilledPill onClick={() => act(item.ref, 'OVERRIDE', { sku: overrideDraft })} disabled={busy || !overrideDraft.trim()}>
                                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} /> : <Check className="h-3.5 w-3.5" strokeWidth={2} />}
                                  Save override
                                </FilledPill>
                              </>
                            ) : isFailure ? (
                              <>
                                <GhostPill onClick={() => act(item.ref, 'RETRY')} disabled={busy}>
                                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} /> : null}
                                  Retry dispatch
                                </GhostPill>
                                <FilledPill onClick={() => act(item.ref, 'RESOLVE')} disabled={busy}>
                                  <Check className="h-3.5 w-3.5" strokeWidth={2} />
                                  Mark resolved
                                </FilledPill>
                              </>
                            ) : (
                              <>
                                <GhostPill
                                  onClick={() => {
                                    setOverrideDraft(item.skuParsed ?? '');
                                    setOverrideOpen(item.ref);
                                  }}
                                  disabled={busy}
                                >
                                  Manual override SKU
                                </GhostPill>
                                <FilledPill onClick={() => act(item.ref, 'APPROVE')} disabled={busy}>
                                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} /> : <Check className="h-3.5 w-3.5" strokeWidth={2} />}
                                  Approve & dispatch to portal
                                </FilledPill>
                              </>
                            )}
                          </div>
                        </article>
                      );
                    })}
                    {pendingItems.length === 0 && (
                      <div className={`p-6 text-[13.5px] leading-relaxed text-steel ${ARTIFACT}`}>
                        Nothing pending — new low-confidence parses and dispatch failures land here the moment they are flagged.
                      </div>
                    )}
                  </>
                )}

                {queueFilter !== 'pending' && (
                  <div className={ARTIFACT}>
                    <div className="border-b border-black/5 px-5 py-3.5 text-[11.5px] font-medium uppercase tracking-[0.08em] text-smoke">
                      The record — {resolvedItems.length} resolved {resolvedItems.length === 1 ? 'item' : 'items'}
                    </div>
                    {resolvedItems.length > 0 ? (
                      <div className="divide-y divide-black/5 px-5">
                        {resolvedItems.map((i) => (
                          <div key={i.id} className="flex items-center justify-between gap-4 py-2.5">
                            <div className="flex min-w-0 items-center gap-2 text-[13px]">
                              <span className="shrink-0 font-medium text-steel">{i.ref}</span>
                              <span className="text-smoke">·</span>
                              <span className="truncate text-steel">{i.tenantName}</span>
                              <span className="truncate text-smoke">— {i.kind === 'DISPATCH_FAILURE' ? 'dispatch failure' : i.skuParsed}</span>
                            </div>
                            <div className="flex shrink-0 items-center gap-3 text-[12px]">
                              <span className={i.status === 'APPROVED' ? 'font-medium text-sienna' : 'text-steel'}>
                                {i.status === 'APPROVED'
                                  ? i.extractedMarginLossCents > 0
                                    ? `Approved · ${fmtUsd(i.extractedMarginLossCents, true)} identified`
                                    : 'Approved'
                                  : i.status === 'OVERRIDDEN'
                                    ? 'Overridden'
                                    : 'Resolved'}
                              </span>
                              <span className="text-smoke tabular-nums" title={new Date(i.updatedAt).toLocaleString()}>
                                {relTime(i.updatedAt)}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="px-5 py-4 text-[13px] text-steel">No verdicts yet — resolved items file themselves here.</div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ════ 03 · TENANTS & AUDITS ════ */}
          {activeTab === 'tenants_audits' && (
            <div className="animate-in fade-in duration-300">
              <ViewHeader
                tag="Tenant enclave management"
                title="Enterprise clients &"
                accent="audits"
                rest=""
                sub="Isolated AST boundaries per tenant, invite-only portal access, and the audit book — sales, conversion, and identified leakage recomputed from the ledger on every poll."
              />

              {/* Task 18 — the audit book lives here: funnel + money, server-computed. */}
              {ledger && <AuditFunnelStrip rollup={ledger.auditRollup} asOf={ledger.asOf} />}

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {tenants.map((tenant) => {
                  const access = portalAccess.find((a) => a.name === tenant.name);
                  const activeInvite = invites.find((i) => i.tenantName === tenant.name && i.status !== 'REVOKED');
                  const accessLabel = !access?.hasCode
                    ? 'Disabled — no active code'
                    : activeInvite?.status === 'PENDING'
                      ? 'Invite pending — first sign-in'
                      : 'Access active';
                  const revealing = revealedCode?.tenant === tenant.name;
                  // Task 18 — account health: ledger, HITL queue, and schedule joined per tenant.
                  const client = ledger?.clients.find((c) => c.name === tenant.name);
                  const pendingHitl = hitlQueue.filter((h) => h.tenantName === tenant.name && h.status === 'PENDING').length;
                  const upcoming = (schedule?.sessions ?? [])
                    .filter((s) => s.clientName === tenant.name && !s.isInternal && ['SCHEDULED', 'CONFIRMED', 'LIVE'].includes(s.status))
                    .sort((a, b) => +new Date(a.scheduledAt) - +new Date(b.scheduledAt));
                  const nextCall = upcoming.find((s) => s.status === 'LIVE') ?? upcoming[0];
                  const trailRows = commandLog.filter((r) => r.target === tenant.name || r.detail.includes(tenant.name)).slice(0, 5);
                  return (
                  <article key={tenant.name} className="space-y-4 rounded-[24px] bg-mist p-6">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h3 className="font-display text-[26px] font-normal leading-[1.18] tracking-[-0.01em] text-ink">{tenant.name}</h3>
                        <div className="mt-1 text-[13px] text-steel">{tenant.erp} · AST isolated boundary</div>
                      </div>
                      <BlushChip className="shrink-0">{tenant.status}</BlushChip>
                    </div>

                    <div className="space-y-2 border-t border-black/5 pt-4 text-[13px]">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-steel">Deposit / fee</span>
                        <span className="font-medium text-ink">{tenant.depositLabel}</span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-steel">Margin recovery baseline</span>
                        <span className="font-medium text-ink">{tenant.guaranteeLabel}</span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-steel">Outlook mailbox</span>
                        <span className={`font-medium ${tenant.mailboxStatus === 'ACTIVE' ? 'text-ink' : 'text-sienna'}`}>
                          {mailboxLabel[tenant.mailboxStatus]}
                        </span>
                      </div>
                    </div>

                    {/* Task 18 — account health: ledger figures, HITL load, next engagement */}
                    <div className="space-y-2 border-t border-black/5 pt-4 text-[13px]">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-[13px] font-medium text-ink">Account health</span>
                        {client && (
                          <QuietChip>
                            {client.paymentStatus === 'PAID' ? 'Paid' : client.paymentStatus === 'OVERDUE' ? 'Overdue' : 'Pending'}
                          </QuietChip>
                        )}
                      </div>
                      {client ? (
                        <>
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-steel">Margin defended</span>
                            <span className="font-medium tabular-nums text-ink">
                              {fmtUsd(client.totalDefendedCents)}
                              {client.last24hDeltaCents !== 0 && (
                                <span className={`ml-1.5 text-[11.5px] ${client.last24hDeltaCents > 0 ? 'text-sienna' : 'text-smoke'}`}>
                                  {client.last24hDeltaCents > 0 ? '+' : '−'}{fmtUsd(Math.abs(client.last24hDeltaCents))} 24h
                                </span>
                              )}
                            </span>
                          </div>
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-steel">Rev-share (monthly)</span>
                            <span className="font-medium tabular-nums text-ink">{fmtUsd(client.monthlyRevShareCents)}</span>
                          </div>
                          {client.leakageVector && (
                            <div className="flex items-start justify-between gap-3">
                              <span className="shrink-0 text-steel">Primary leak</span>
                              <span className="text-right font-medium text-ink">{client.leakageVector}</span>
                            </div>
                          )}
                        </>
                      ) : (
                        <p className="text-[12.5px] leading-relaxed text-steel">Not on the ledger yet — no defended margin to show.</p>
                      )}
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-steel">Pending HITL reviews</span>
                        <span className={`font-medium tabular-nums ${pendingHitl > 0 ? 'text-sienna' : 'text-ink'}`}>{pendingHitl}</span>
                      </div>
                      <div className="flex items-start justify-between gap-3">
                        <span className="shrink-0 text-steel">Next engagement</span>
                        {nextCall ? (
                          <span className="text-right font-medium text-ink">
                            {nextCall.type}
                            <span className="ml-1.5 text-[11.5px] text-smoke">
                              {new Date(nextCall.scheduledAt).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}
                              {nextCall.status === 'LIVE' ? ' · live now' : ''}
                            </span>
                          </span>
                        ) : (
                          <span className="text-steel">Nothing scheduled</span>
                        )}
                      </div>
                    </div>

                    {/* Portal access — invite-only, replaces demo codes */}
                    <div className="space-y-3 border-t border-black/5 pt-4">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2 text-[13px] font-medium text-ink">
                          <KeyRound className="h-3.5 w-3.5 text-steel" strokeWidth={1.75} />
                          Portal access
                        </div>
                        <span className={`text-[12px] font-medium ${access?.hasCode ? 'text-ink' : 'text-sienna'}`}>
                          {accessLabel}
                        </span>
                      </div>
                      <div className="text-[12px] leading-relaxed text-steel">
                        {access?.contactEmail || 'No contact email on file'}
                        {activeInvite && <> · invite <span className="font-mono text-[11.5px] text-ink">{activeInvite.codeHint}</span> ({activeInvite.status.toLowerCase()}, issued by {activeInvite.issuedBy})</>}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <GhostPill onClick={() => issueInvite(tenant.name)} disabled={inviteBusy === tenant.name}>
                          {inviteBusy === tenant.name ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} /> : <MailPlus className="h-3.5 w-3.5" strokeWidth={1.75} />}
                          Email new invite
                        </GhostPill>
                        {access?.hasCode && (
                          <GhostPill onClick={() => revokeAccess(tenant.name)} disabled={inviteBusy === tenant.name}>
                            <Ban className="h-3.5 w-3.5" strokeWidth={1.75} />
                            Disable access
                          </GhostPill>
                        )}
                      </div>
                      {revealing && revealedCode && (
                        <div className="rounded-2xl bg-blush p-4 text-sienna">
                          <div className="flex items-center justify-between gap-3">
                            <div className="text-[12px] font-medium uppercase tracking-[0.06em]">Access code — shown once</div>
                            <button
                              onClick={copyRevealed}
                              className="inline-flex items-center gap-1.5 rounded-full border border-sienna/30 px-2.5 py-1 text-[12px] font-medium transition-colors hover:bg-sienna/10"
                            >
                              {copiedCode ? <Check className="h-3 w-3" strokeWidth={2} /> : <Copy className="h-3 w-3" strokeWidth={1.75} />}
                              {copiedCode ? 'Copied' : 'Copy'}
                            </button>
                          </div>
                          <div className="mt-1.5 font-mono text-[16px] font-medium tracking-wide">{revealedCode.code}</div>
                          <p className="mt-1.5 text-[12px] leading-relaxed text-sienna/80">
                            Delivered to {revealedCode.email} (outbox · simulated SMTP). It replaces any previous code and signs this tenant into exactly one enclave — store it now; it will not be shown again.
                          </p>
                        </div>
                      )}
                    </div>

                    {/* Task 18 — per-tenant ship's-log trail (attributed rows only) */}
                    {trailRows.length > 0 && (
                      <div className="space-y-2 border-t border-black/5 pt-4">
                        <button
                          onClick={() => setTrailTenant(trailTenant === tenant.name ? null : tenant.name)}
                          className="inline-flex items-center gap-1.5 text-[13px] font-medium text-ink transition-colors hover:text-sienna"
                        >
                          <HistoryIcon className="h-3.5 w-3.5 text-steel" strokeWidth={1.75} />
                          Tenant trail — last {trailRows.length} log row{trailRows.length === 1 ? '' : 's'}
                          <ChevronDown
                            className={`h-3.5 w-3.5 text-steel transition-transform ${trailTenant === tenant.name ? 'rotate-180' : ''}`}
                            strokeWidth={1.75}
                          />
                        </button>
                        {trailTenant === tenant.name && (
                          <div className="space-y-1.5 rounded-xl bg-paper p-3.5">
                            {trailRows.map((r) => (
                              <div key={r.id} className="text-[12.5px] leading-relaxed">
                                <span className="font-mono text-[11px] text-smoke">
                                  {new Date(r.createdAt).toLocaleTimeString('en-US', { hour12: false })}
                                </span>
                                <span className="mx-1.5 rounded-full bg-mist px-1.5 py-0.5 text-[10.5px] font-medium text-steel">{r.actor}</span>
                                <span className="text-ink">{r.detail || r.action.toLowerCase().replace(/_/g, ' ')}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    <a
                      href={`/portal?tenant=${encodeURIComponent(tenant.name)}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 pt-1 text-[14px] text-ink underline-offset-4 hover:underline"
                    >
                      Open client enclave view <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={1.75} />
                    </a>
                  </article>
                  );
                })}
              </div>

              {/* Task 18 — the audit sales log closes the tab: every record, linked to its enclave. */}
              {ledger && <AuditLogList audits={ledger.audits} rollup={ledger.auditRollup} />}
            </div>
          )}

          {/* ════ 04 · UNIFIED INBOX ════ */}
          {activeTab === 'communications' && (
            <div className="animate-in fade-in duration-300">
              <ViewHeader
                tag="Unified communications"
                title="Client executive"
                accent="messages"
                rest=""
                sub="One direct enclave line per tenant — every portal message and executive reply in one thread, marked seen only when someone actually reads it."
              />

              <section className={`overflow-hidden ${ARTIFACT}`}>
                <div className="grid h-[560px] grid-cols-1 md:h-[600px] md:grid-cols-12">
                  {/* Channel list — arranged from the same rows as the thread:
                      unread first, then most-recent activity, each channel
                      showing its last message and its weight. */}
                  <div className="flex min-h-0 flex-col border-b border-hairline p-4 md:col-span-4 md:border-b-0 md:border-r">
                    <div className="px-2 pb-3 text-[13px] text-ash">Active enclave channels</div>
                    <div className="scroll-slim max-h-40 space-y-1 overflow-y-auto md:max-h-none md:flex-1">
                      {channels.map((c) => {
                        const active = activeChatTenant === c.name;
                        return (
                          <button
                            key={c.name}
                            onClick={() => setActiveChatTenant(c.name)}
                            aria-current={active ? 'true' : undefined}
                            aria-label={`${c.name}${c.unread > 0 ? `, ${c.unread} unread` : ''}`}
                            className={`w-full rounded-2xl px-3.5 py-3 text-left transition-colors ${active ? 'bg-mist' : 'hover:bg-fog'}`}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="truncate text-[14px] text-ink" title={c.name}>{c.name}</span>
                              {c.unread > 0 ? (
                                <span className="shrink-0 rounded-full bg-blush px-1.5 text-[11px] font-medium tabular-nums text-sienna">{c.unread}</span>
                              ) : c.lastIso ? (
                                <span className="shrink-0 text-[11px] tabular-nums text-smoke" title={new Date(c.lastIso).toLocaleString()}>{relTime(c.lastIso)}</span>
                              ) : null}
                            </div>
                            <div className="mt-0.5 truncate text-[12px] text-smoke">
                              {c.lastText
                                ? `${c.lastDirection === 'team' ? 'You: ' : ''}${c.lastText}`
                                : 'Direct enclave line · no messages yet'}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Thread */}
                  <div className="flex min-h-0 flex-col bg-fog md:col-span-8">
                    <div className="flex items-center justify-between border-b border-hairline bg-paper px-5 py-3.5">
                      <div>
                        <div className="text-[15px] font-medium text-ink">{activeChatTenant}</div>
                        {/* Task 23 — real thread state, not a fabricated presence line:
                            last activity and unread weight, arranged from the same rows. */}
                        <div className="mt-0.5 flex items-center gap-2 text-[12px] text-steel">
                          {activeChannel && activeChannel.lastIso
                            ? `Last message ${relTime(activeChannel.lastIso)}${activeChannel.unread > 0 ? ` · ${activeChannel.unread} unread` : ''}`
                            : 'Direct line · no messages yet'}
                        </div>
                      </div>
                      {activeTenant && activeTenant.mailboxStatus !== 'ACTIVE' && (
                        <QuietChip className="shrink-0 text-sienna">
                          <AlertTriangle className="h-3 w-3" strokeWidth={1.75} />
                          Mailbox {activeTenant.mailboxStatus === 'LOCKED' ? 'locked' : 'missing'}
                        </QuietChip>
                      )}
                    </div>

                    <div ref={threadScrollRef} className="scroll-slim flex-1 space-y-3 overflow-y-auto p-4 sm:p-5">
                      {visibleMessages.length === 0 ? (
                        <div className="grid h-full place-items-center text-[13px] text-smoke">
                          No messages yet — open the conversation with a hello.
                        </div>
                      ) : (
                        visibleMessages.map((msg, idx) => {
                          // Task 23 — day separators from the message dates; the
                          // bubble side reads the server-stamped direction, never
                          // a sender-string guess.
                          const newDay = idx === 0 || dayKey(visibleMessages[idx - 1].createdAt) !== dayKey(msg.createdAt);
                          const own = msg.direction === 'team';
                          return (
                            <div key={msg.id} className="space-y-3">
                              {newDay && (
                                <div className="flex items-center gap-3 py-1" role="separator" aria-label={dayLabel(msg.createdAt)}>
                                  <span className="h-px flex-1 bg-hairline" />
                                  <span className="text-[11px] font-medium uppercase tracking-wide text-smoke">{dayLabel(msg.createdAt)}</span>
                                  <span className="h-px flex-1 bg-hairline" />
                                </div>
                              )}
                              <div
                                className={`max-w-[420px] rounded-[16px] px-4 py-3 ${
                                  own ? 'ml-auto bg-ink text-paper' : 'border border-hairline bg-paper text-ink'
                                }`}
                              >
                                <div className={`mb-1 flex items-center justify-between gap-6 text-[11px] ${own ? 'text-paper/60' : 'text-smoke'}`}>
                                  <span>{msg.sender}</span>
                                  <span className="tabular-nums" title={new Date(msg.createdAt).toLocaleString()}>
                                    {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                  </span>
                                </div>
                                <p className="whitespace-pre-wrap text-[14px] leading-relaxed">{msg.text}</p>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>

                    <form onSubmit={handleSendMessage} className="flex items-center gap-2 border-t border-hairline bg-paper p-4">
                      <input
                        type="text"
                        value={newMessageText}
                        onChange={(e) => setNewMessageText(e.target.value)}
                        placeholder="Reply on the direct enclave line…"
                        aria-label={`Message ${activeChatTenant}`}
                        className="h-11 flex-1 rounded-2xl border border-hairline bg-paper px-4 text-[14px] text-ink transition-colors placeholder:text-smoke focus:border-ink/30 focus:outline-none"
                      />
                      <button
                        type="submit"
                        disabled={sendingMsg || !newMessageText.trim()}
                        aria-label="Send message"
                        aria-busy={sendingMsg}
                        className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-ink text-paper transition-colors hover:bg-[#33363b] disabled:opacity-50"
                      >
                        {sendingMsg ? <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} /> : <Send className="h-4 w-4" strokeWidth={1.75} />}
                      </button>
                    </form>
                  </div>
                </div>
              </section>
            </div>
          )}

                    {/* ════ 05 · THE SCHEDULE — the operating day ════ */}
          {activeTab === 'calendar_calls' && (
            <div className="animate-in fade-in duration-300 xl:-mr-8 min-[1536px]:-mr-20 min-[1792px]:-mr-28">
              <ViewHeader
                tag="The operating day · one grid, nothing hidden"
                title="Client engagements &"
                accent="internal blocks"
                rest=""
                sub="Hours run down the ruler, founders hold the columns — every block reads in full. Paste a Zoom link and join in one click; AT-RISK is earned from live tenant state, never typed by hand. The enclave room below stays the internal line."
              />

              {traveling || !schedDay ? (
                <section className={`p-6 sm:p-8 ${ARTIFACT}`}>
                  <div className="flex items-center gap-2 text-[15px] font-medium text-ink">
                    <CalendarIcon className="h-4 w-4 text-smoke" strokeWidth={1.75} />
                    The schedule
                  </div>
                  <p className="mt-2 max-w-xl text-[14px] leading-relaxed text-steel">
                    {traveling
                      ? `The day only exists in the present — engagements are operational state, not ledger history. Return to live to run the day; the ship's log still shows everything as it stood on ${timeTravel}.`
                      : 'Warming the board — the operating day loads with the ledger.'}
                  </p>
                </section>
              ) : (
                <>
                  {/* Controls */}
                  <div className="mb-4 flex flex-wrap items-center gap-2.5 rounded-2xl bg-mist px-4 py-3">
                    <div className="mr-auto">
                      <div className="flex items-center gap-2 font-display text-[19px] leading-tight text-ink">
                        {dayTitle}
                        {isTodayView && nowMs && (
                          <span className="rounded-full bg-paper px-2 py-0.5 font-sans text-[11px] font-medium tabular-nums text-sienna">{hm(nowMs)}</span>
                        )}
                      </div>
                      <div className="text-[12px] text-steel">
                        {daySessions.length} engagement{daySessions.length === 1 ? '' : 's'} · {foundersOnShift} founder{foundersOnShift === 1 ? '' : 's'} on shift
                        {dayAbsences.length > 0 ? ` · ${dayAbsences.length} out` : ''}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <button type="button" aria-label="Previous day" onClick={() => shiftDay(-1)} className="grid h-8 w-8 place-items-center rounded-full border border-hairline bg-paper text-steel transition-colors hover:text-ink">
                        <ChevronLeft className="h-3.5 w-3.5" strokeWidth={1.75} />
                      </button>
                      <button type="button" onClick={() => setSchedDay(todayKey())} disabled={isTodayView} className="h-8 rounded-full border border-hairline bg-paper px-3 text-[12px] font-medium text-ink transition-colors hover:text-ink disabled:opacity-40">
                        Today
                      </button>
                      <button type="button" aria-label="Next day" onClick={() => shiftDay(1)} className="grid h-8 w-8 place-items-center rounded-full border border-hairline bg-paper text-steel transition-colors hover:text-ink">
                        <ChevronRight className="h-3.5 w-3.5" strokeWidth={1.75} />
                      </button>
                    </div>
                    <div className="flex overflow-hidden rounded-full border border-hairline bg-paper">
                      {(['day', 'week'] as const).map((v) => (
                        <button key={v} type="button" onClick={() => setSchedView(v)} className={`px-3.5 py-1.5 text-[12px] font-medium capitalize transition-colors ${schedView === v ? 'bg-ink text-paper' : 'text-steel hover:text-ink'}`}>
                          {v}
                        </button>
                      ))}
                    </div>
                    <FilledPill
                      onClick={() => {
                        setDraft((d) => ({ ...d, date: schedDay, hostId: d.hostId || hosts[0]?.id || '' }));
                        setCreating(true);
                      }}
                      className="h-8 py-0"
                    >
                      <Plus className="h-3.5 w-3.5" strokeWidth={2} />
                      New engagement
                    </FilledPill>
                  </div>

                  {/* Status rail */}
                  <div className="mb-4 flex flex-wrap items-center gap-1.5">
                    <button type="button" onClick={() => setStatusFilter(null)} className={statusChipTone(statusFilter === null)}>All</button>
                    {(['SCHEDULED', 'CONFIRMED', 'LIVE', 'COMPLETED', 'NO_SHOW'] as ScheduleStatus[]).map((st) => (
                      <button key={st} type="button" onClick={() => setStatusFilter(statusFilter === st ? null : st)} className={statusChipTone(statusFilter === st)}>
                        {STATUS_LABEL[st]} <span className="tabular-nums opacity-60">{statusCounts[st] ?? 0}</span>
                      </button>
                    ))}
                    {atRiskCount > 0 && (
                      <button type="button" onClick={() => setStatusFilter(statusFilter === 'AT_RISK' ? null : 'AT_RISK')} className={statusChipTone(statusFilter === 'AT_RISK', true)}>
                        At risk <span className="tabular-nums opacity-60">{atRiskCount}</span>
                      </button>
                    )}
                  </div>

                  {/* Coverage banner */}
                  <div className={`mb-4 space-y-1.5 rounded-2xl px-4 py-3 text-[13px] ${unowned.length > 0 ? 'bg-blush text-sienna' : 'bg-mist text-ink'}`}>
                    <div className="flex flex-wrap items-center gap-2">
                      {unowned.length > 0 ? (
                        <AlertTriangle className="h-4 w-4" strokeWidth={1.75} />
                      ) : (
                        <CheckCircle2 className="h-4 w-4 text-sienna" strokeWidth={1.75} />
                      )}
                      <span className="font-medium">
                        {unowned.length > 0
                          ? `${unowned.length} engagement${unowned.length === 1 ? '' : 's'} need an owner — assign from the block dialog`
                          : `All covered — ${daySessions.length} of ${daySessions.length} engagements owned`}
                      </span>
                    </div>
                    {dayAbsences.map((a) => (
                      <div key={a.id} className="flex flex-wrap items-center gap-2 text-[12.5px]">
                        <UserX className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
                        <span>
                          {a.memberName} marked unavailable — {a.reason.toLowerCase()}, reported {hm(a.reportedAt)}. {a.reassignments}.
                        </span>
                        <button
                          type="button"
                          onClick={() => markAvailable(a.id)}
                          disabled={schedBusy}
                          className="rounded-full border border-ink/25 px-2.5 py-0.5 text-[11.5px] font-medium text-ink transition-colors hover:bg-paper/70 disabled:opacity-40"
                        >
                          Mark available again
                        </button>
                      </div>
                    ))}
                  </div>

                  {schedView === 'day' ? (
                    /* ── Day grid — hours flow down the ruler, founders hold the columns ── */
                    <section className={`overflow-hidden ${ARTIFACT}`}>
                      <div className="overflow-x-auto scroll-slim">
                        <div className="min-w-[720px]">
                          {/* Column headers — one per founder */}
                          <div className="flex border-b border-hairline">
                            <div className="w-16 shrink-0 px-2 py-3 text-[10.5px] font-medium uppercase leading-snug tracking-[0.06em] text-smoke">By founder</div>
                            {rows.map((r) => (
                              <div key={r.key} className="min-w-0 flex-1 border-l border-hairline px-3.5 py-3">
                                {r.memberId ? (
                                  <>
                                    <div className="flex items-center gap-2.5">
                                      <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-full text-[14px] font-medium ${r.tone === 'blush' ? 'bg-blush text-sienna' : 'bg-ink text-paper'}`}>
                                        {r.memberName[0]}
                                      </span>
                                      <span className="truncate text-[15px] font-medium text-ink">{r.memberName}</span>
                                    </div>
                                    <div className="mt-2 flex items-center gap-1.5">
                                      <QuietChip className="text-[11.5px] tabular-nums">{hoursLabel(minutesFor(r.memberId))}</QuietChip>
                                      {!r.absent && (
                                        <button
                                          type="button"
                                          onClick={() => {
                                            setAbsenceFor(r.memberId);
                                            setAbsenceReason('SICK');
                                            setAbsenceNote('');
                                          }}
                                          title="Mark unavailable for the day"
                                          className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11.5px] text-smoke transition-colors hover:bg-blush hover:text-sienna"
                                        >
                                          <UserX className="h-3.5 w-3.5" strokeWidth={1.75} />
                                          Out
                                        </button>
                                      )}
                                    </div>
                                  </>
                                ) : (
                                  <>
                                    <div className="text-[14.5px] font-medium text-sienna">Needs an owner</div>
                                    <div className="mt-1 text-[12px] text-steel">Assign from the block dialog</div>
                                  </>
                                )}
                              </div>
                            ))}
                          </div>
                          {/* Grid body — time ruler on the left, one tall column per founder */}
                          <div className="relative flex">
                            <div className="absolute inset-y-0 left-16 right-0" aria-hidden>
                              {HOURS.map((h) => (
                                <div key={h} className="absolute inset-x-0 h-px bg-hairline" style={{ top: `${yOf(h * 60)}px` }} />
                              ))}
                              {HOURS.slice(0, -1).map((h) => (
                                <div key={`half-${h}`} className="absolute inset-x-0 h-px bg-hairline/60" style={{ top: `${yOf(h * 60 + 30)}px` }} />
                              ))}
                            </div>
                            <div className="relative w-16 shrink-0 border-r border-hairline" style={{ height: `${GRID_H}px` }}>
                              {HOURS.slice(0, -1).map((h) => (
                                <span key={h} className="absolute right-2.5 -translate-y-1/2 text-[11px] tabular-nums text-smoke" style={{ top: `${yOf(h * 60)}px` }}>
                                  {hourLabel(h)}
                                </span>
                              ))}
                            </div>
                            {rows.map((r) => (
                              <div key={r.key} className="relative min-w-0 flex-1 border-l border-hairline" style={{ height: `${GRID_H}px` }}>
                                {r.blocks.map((s) => (
                                  <React.Fragment key={s.id}>
                                    {prepBufferShown(s, r.blocks) && (
                                      <div
                                        aria-hidden
                                        className="absolute left-2 right-2 rounded-md border border-dashed border-smoke/40"
                                        style={{
                                          top: `${yOf(minutesOf(s.scheduledAt) - 15) + 2}px`,
                                          height: `${Math.max(6, yOf(minutesOf(s.scheduledAt)) - yOf(minutesOf(s.scheduledAt) - 15) - 6)}px`,
                                        }}
                                      />
                                    )}
                                    <button
                                      type="button"
                                      onClick={() => openEngagement(s)}
                                      title={`${s.clientName} — ${s.type} · ${hm(s.scheduledAt)}–${hm(s.endsAt ?? s.scheduledAt)}${s.joinUrl ? ' · line attached' : ''}`}
                                      className={`absolute left-2 right-2 z-10 flex flex-col justify-center overflow-hidden rounded-xl border px-3 py-1.5 text-left transition-all hover:z-30 hover:shadow-md ${blockTone(s)}`}
                                      style={{
                                        top: `${yOf(minutesOf(s.scheduledAt)) + 2}px`,
                                        height: `${Math.max(46, yOf(endMinOf(s)) - yOf(minutesOf(s.scheduledAt)) - 5)}px`,
                                      }}
                                    >
                                      <div className="flex items-center gap-1.5 text-[14px] font-medium leading-tight">
                                        {s.atRiskReasons.length > 0 && <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-sienna" strokeWidth={2} />}
                                        {s.flagged && <Flag className="h-3.5 w-3.5 shrink-0 text-sienna" strokeWidth={2} fill="currentColor" />}
                                        <span className="truncate">{s.isInternal ? s.type : s.clientName}</span>
                                        {s.joinUrl && <Link2 className="ml-auto h-3.5 w-3.5 shrink-0 opacity-50" strokeWidth={1.75} />}
                                      </div>
                                      <div className="mt-0.5 truncate text-[11.5px] tabular-nums opacity-70">
                                        {hm(s.scheduledAt)}–{hm(s.endsAt ?? s.scheduledAt)} · {durLabel(durOf(s))}
                                      </div>
                                      {durOf(s) >= 45 && (
                                        <div className="mt-1 truncate text-[9.5px] font-medium uppercase tracking-[0.08em] opacity-55">
                                          {s.isInternal ? 'Internal block' : s.type}
                                        </div>
                                      )}
                                    </button>
                                  </React.Fragment>
                                ))}
                                {r.absent && (
                                  <div className="absolute inset-0 z-20 flex items-start bg-fog/80 px-4 pt-5">
                                    <div className="flex items-start gap-2.5">
                                      <UserX className="mt-0.5 h-4 w-4 shrink-0 text-sienna" strokeWidth={1.75} />
                                      <span className="text-[12.5px] leading-relaxed text-steel">
                                        Unavailable — {r.absent.reason.toLowerCase()}, reported {hm(r.absent.reportedAt)}. {r.absent.reassignments}
                                      </span>
                                    </div>
                                  </div>
                                )}
                              </div>
                            ))}
                            {nowY !== null && (
                              <div className="pointer-events-none absolute left-16 right-0 z-30" style={{ top: `${nowY}px` }} aria-hidden>
                                <div className="h-px w-full bg-sienna" />
                                <span className="absolute -left-16 top-0 -translate-y-1/2 rounded-full bg-sienna px-2 py-0.5 text-[10.5px] font-medium tabular-nums text-paper">
                                  {nowMs ? hm(nowMs) : ''}
                                </span>
                              </div>
                            )}
                          </div>
                          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-hairline px-4 py-3 text-[11px] uppercase tracking-[0.05em] text-smoke">
                            <span>Showing {shownSessions.length} of {daySessions.length} engagements</span>
                            <span>Dotted strips are prep buffers · internal blocks are shaded &amp; dashed</span>
                          </div>
                        </div>
                      </div>
                    </section>
                  ) : (
                    /* ── Week strip — seven days, click to travel ── */
                    <section className={`p-5 ${ARTIFACT}`}>
                      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
                        {weekDays.map((day) => {
                          const ds = (schedule?.sessions ?? []).filter((s) => dayKey(s.scheduledAt) === day && s.status !== 'CANCELLED');
                          const mins = ds.reduce((acc, s) => acc + Math.max(0, endMinOf(s) - minutesOf(s.scheduledAt)), 0);
                          const d = new Date(`${day}T12:00:00`);
                          const active = day === schedDay;
                          return (
                            <button
                              key={day}
                              type="button"
                              onClick={() => {
                                setSchedDay(day);
                                setSchedView('day');
                              }}
                              className={`rounded-2xl border p-4 text-left transition-colors ${active ? 'border-ink bg-mist' : 'border-hairline hover:bg-fog'}`}
                            >
                              <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-smoke">
                                {d.toLocaleDateString('en-US', { weekday: 'short' })} {d.getDate()}
                              </div>
                              <div className="mt-0.5 text-[14.5px] font-medium text-ink">{ds.length} engagement{ds.length === 1 ? '' : 's'}</div>
                              <div className="text-[12px] tabular-nums text-steel">{mins > 0 ? hoursLabel(mins) : '—'}</div>
                              <div className="mt-2.5 space-y-1.5">
                                {ds.slice(0, 4).map((s) => (
                                  <div key={s.id} className="truncate text-[12px] text-steel">
                                    {hm(s.scheduledAt)} · {s.isInternal ? s.type : s.clientName}
                                  </div>
                                ))}
                                {ds.length > 4 && <div className="text-[11px] text-smoke">+{ds.length - 4} more</div>}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </section>
                  )}
                </>
              )}

              {/* Enclave room — the internal line, below the grid */}
              <div className="mt-6 rounded-[24px] bg-mist p-5">
                <div className="flex items-center justify-between px-1 pb-4">
                  <div className="flex items-center gap-2 text-[14px] font-medium text-ink">
                    <Video className="h-4 w-4 text-sienna" strokeWidth={1.75} />
                    Syntropic enclave room
                  </div>
                  <span className="text-[12px] text-steel">
                    {callState === 'live'
                      ? rtcMode === 'turn'
                        ? `Relay room active · ${relayCount} TURN candidate${relayCount === 1 ? '' : 's'}`
                        : 'Local room active'
                      : rtcMode === 'turn'
                        ? 'TURN relay · configured'
                        : 'Encrypted P2P line'}
                  </span>
                </div>

                <div className="grid min-h-[300px] place-items-center rounded-2xl bg-paper p-6">
                  {callState === 'live' ? (
                    <div className="w-full">
                      <video
                        ref={videoRef}
                        autoPlay
                        muted
                        playsInline
                        className="aspect-video w-full rounded-2xl bg-ink object-cover"
                      />
                      <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                        <GhostPill onClick={toggleMic}>
                          {micOn ? <Mic className="h-3.5 w-3.5" strokeWidth={1.75} /> : <MicOff className="h-3.5 w-3.5" strokeWidth={1.75} />}
                          {micOn ? 'Mute' : 'Unmute'}
                        </GhostPill>
                        <GhostPill onClick={toggleCam}>
                          {camOn ? <Video className="h-3.5 w-3.5" strokeWidth={1.75} /> : <VideoOff className="h-3.5 w-3.5" strokeWidth={1.75} />}
                          {camOn ? 'Camera off' : 'Camera on'}
                        </GhostPill>
                        <FilledPill onClick={endCall}>
                          <PhoneOff className="h-3.5 w-3.5" strokeWidth={1.75} />
                          End call
                        </FilledPill>
                      </div>
                    </div>
                  ) : callState === 'connecting' ? (
                    <div className="text-center">
                      <Loader2 className="mx-auto h-10 w-10 animate-spin text-smoke" strokeWidth={1.25} />
                      <div className="mt-3 text-[15px] font-medium text-ink">Requesting camera &amp; microphone…</div>
                      <div className="mx-auto mt-1.5 max-w-xs text-[13px] leading-relaxed text-steel">
                        Grant browser permissions to initialize the encrypted room.
                      </div>
                    </div>
                  ) : callState === 'error' ? (
                    <div className="text-center">
                      <VideoOff className="mx-auto h-10 w-10 text-smoke" strokeWidth={1.25} />
                      <div className="mt-3 text-[15px] font-medium text-ink">Camera &amp; microphone unavailable</div>
                      <div className="mx-auto mt-1.5 max-w-xs text-[13px] leading-relaxed text-steel">
                        Connect a device or grant permissions in your browser, then retry the room launch.
                      </div>
                      <FilledPill className="mt-4" onClick={launchRoom}>
                        <Video className="h-4 w-4" strokeWidth={1.75} />
                        Retry room launch
                      </FilledPill>
                    </div>
                  ) : (
                    <div className="text-center">
                      <Video className="mx-auto h-10 w-10 animate-pulse text-smoke" strokeWidth={1.25} />
                      <div className="mt-3 text-[15px] font-medium text-ink">No active call in session</div>
                      <div className="mx-auto mt-1.5 max-w-xs text-[13px] leading-relaxed text-steel">
                        The internal line — engine reviews and founder syncs run here when the grid marks a block internal. Client calls ride the pasted Zoom links above.
                      </div>
                    </div>
                  )}
                </div>

                {callState !== 'live' && callState !== 'connecting' && (
                  <FilledPill className="mt-4 w-full py-3" onClick={launchRoom}>
                    <Video className="h-4 w-4" strokeWidth={1.75} />
                    Launch enclave room for {currentUser}
                  </FilledPill>
                )}
              </div>

              {/* ── Engagement detail dialog ── */}
              {openBlock && (
                <div
                  className="fixed inset-0 z-[70] grid place-items-center overflow-y-auto bg-ink/25 p-4 backdrop-blur-[2px]"
                  onClick={() => setOpenBlock(null)}
                  role="dialog"
                  aria-modal="true"
                  aria-label="Engagement details"
                >
                  <div className="my-8 w-full max-w-md rounded-[24px] bg-paper p-6 shadow-2xl animate-in fade-in zoom-in-95 duration-200" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-[12px] text-ash">{openBlock.isInternal ? 'Internal block' : openBlock.type}</div>
                        <h3 className="mt-1 font-display text-[24px] font-normal leading-tight text-ink">
                          {openBlock.isInternal ? openBlock.type : openBlock.clientName}
                        </h3>
                        {!openBlock.isInternal && tenants.find((t) => t.name === openBlock.clientName) && (
                          <div className="mt-1 text-[12.5px] text-steel">
                            Contact · {tenants.find((t) => t.name === openBlock.clientName)?.contactName || '—'}
                            {tenants.find((t) => t.name === openBlock.clientName)?.contactEmail
                              ? ` · ${tenants.find((t) => t.name === openBlock.clientName)?.contactEmail}`
                              : ''}
                          </div>
                        )}
                      </div>
                      <div className="flex shrink-0 items-start gap-1.5">
                        {openBlock.atRiskReasons.length > 0 && (
                          <BlushChip className="shrink-0">
                            <AlertTriangle className="h-3 w-3" strokeWidth={2} />
                            At risk
                          </BlushChip>
                        )}
                        <button type="button" onClick={() => setOpenBlock(null)} aria-label="Close" className="grid h-8 w-8 place-items-center rounded-full text-steel transition-colors hover:bg-mist hover:text-ink">
                          <X className="h-4 w-4" strokeWidth={1.75} />
                        </button>
                      </div>
                    </div>

                    {openBlock.atRiskReasons.length > 0 && (
                      <div className="mt-3 space-y-1 rounded-2xl bg-blush p-3 text-[12.5px] text-sienna">
                        {openBlock.atRiskReasons.map((r) => (
                          <div key={r} className="flex items-start gap-1.5">
                            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" strokeWidth={2} />
                            {r} — earned from live tenant state
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="mt-4 space-y-2.5 border-t border-black/5 pt-4 text-[13.5px]">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-steel">Time</span>
                        {resched ? (
                          <div className="flex flex-wrap items-center gap-1.5">
                            <input
                              type="time"
                              aria-label="Start time"
                              value={resched.start}
                              onChange={(e) => setResched({ ...resched, start: e.target.value })}
                              className="h-8 rounded-full border border-hairline bg-fog px-2 text-[12.5px] tabular-nums outline-none"
                            />
                            <span className="text-smoke">–</span>
                            <input
                              type="time"
                              aria-label="End time"
                              value={resched.end}
                              onChange={(e) => setResched({ ...resched, end: e.target.value })}
                              className="h-8 rounded-full border border-hairline bg-fog px-2 text-[12.5px] tabular-nums outline-none"
                            />
                            <FilledPill className="h-8 px-3 py-0 text-[12px]" onClick={applyResched} disabled={schedBusy}>
                              Apply
                            </FilledPill>
                          </div>
                        ) : (
                          <span className="flex items-center gap-1.5 font-medium tabular-nums text-ink">
                            <Clock className="h-3.5 w-3.5 text-steel" strokeWidth={1.75} />
                            {hm(openBlock.scheduledAt)} – {hm(openBlock.endsAt ?? openBlock.scheduledAt)}
                            <button
                              type="button"
                              onClick={() => setResched({ start: toTimeInput(openBlock.scheduledAt), end: toTimeInput(openBlock.endsAt ?? openBlock.scheduledAt) })}
                              className="ml-1 text-[11.5px] font-medium text-steel underline-offset-2 hover:underline"
                            >
                              Move
                            </button>
                          </span>
                        )}
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-steel">Host</span>
                        <select
                          value={openBlock.hostId ?? ''}
                          onChange={(e) => patchEngagement(openBlock.id, { hostId: e.target.value || null })}
                          disabled={schedBusy}
                          aria-label="Engagement host"
                          className="cursor-pointer appearance-none rounded-full bg-mist px-3 py-1 text-[12.5px] font-medium text-ink outline-none disabled:opacity-50"
                        >
                          <option value="">— needs an owner —</option>
                          {hosts.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.fullName || m.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-steel">Status</span>
                        <span className="font-medium text-ink">
                          {STATUS_LABEL[openBlock.status] ?? openBlock.status}
                          {openBlock.status === 'COMPLETED' && openBlock.attendanceVerified ? ' · attended ✓' : ''}
                        </span>
                      </div>
                    </div>

                    <div className="mt-4 border-t border-black/5 pt-4">
                      <div className="text-[12px] font-medium uppercase tracking-[0.06em] text-smoke">
                        Join line{openBlock.provider ? ` · ${openBlock.provider}` : ''}
                      </div>
                      {openBlock.joinUrl ? (
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <FilledPill className="h-9" onClick={() => openBlock.joinUrl && window.open(openBlock.joinUrl, '_blank', 'noopener')}>
                            <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.75} />
                            Join {openBlock.provider === 'ZOOM' ? 'Zoom' : openBlock.provider === 'MEET' ? 'Meet' : 'call'}
                          </FilledPill>
                          <GhostPill className="h-9" onClick={() => openBlock.joinUrl && copyJoin(openBlock.joinUrl)}>
                            <Copy className="h-3.5 w-3.5" strokeWidth={1.75} />
                            {copiedLink ? 'Copied' : 'Copy link'}
                          </GhostPill>
                          <span className="w-full truncate text-[11.5px] text-smoke sm:w-auto sm:max-w-[180px]">{openBlock.joinUrl}</span>
                        </div>
                      ) : (
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            if (linkDraft.trim()) {
                              patchEngagement(openBlock.id, { joinUrl: linkDraft.trim() });
                              setLinkDraft('');
                            }
                          }}
                          className="mt-2 flex gap-2"
                        >
                          <input
                            value={linkDraft}
                            onChange={(e) => setLinkDraft(e.target.value)}
                            placeholder="Paste a Zoom / Meet link…"
                            aria-label="Join link URL"
                            className="h-9 min-w-0 flex-1 rounded-full border border-hairline bg-fog px-3.5 text-[13px] outline-none focus:border-ink/30"
                          />
                          <FilledPill type="submit" className="h-9 shrink-0" disabled={!linkDraft.trim() || schedBusy}>
                            <Link2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                            Attach
                          </FilledPill>
                        </form>
                      )}
                      <p className="mt-1.5 text-[11.5px] text-smoke">
                        {openBlock.isInternal
                          ? 'Internal blocks run on the enclave room below — no client line needed.'
                          : 'Clients join the pasted line; the enclave room below is the internal backup.'}
                      </p>
                    </div>

                    <div className="mt-4 border-t border-black/5 pt-4">
                      <div className="text-[12px] font-medium uppercase tracking-[0.06em] text-smoke">Notes</div>
                      <textarea
                        value={notesDraft}
                        onChange={(e) => setNotesDraft(e.target.value)}
                        rows={2}
                        placeholder="Prep notes, outcomes, follow-ups…"
                        aria-label="Engagement notes"
                        className="mt-2 w-full rounded-2xl border border-hairline bg-fog p-3 text-[13px] leading-relaxed outline-none focus:border-ink/30"
                      />
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <GhostPill onClick={() => patchEngagement(openBlock.id, { notes: notesDraft })} disabled={schedBusy || notesDraft === openBlock.notes}>
                          Save notes
                        </GhostPill>
                        <GhostPill
                          onClick={() => patchEngagement(openBlock.id, { flagged: !openBlock.flagged })}
                          disabled={schedBusy}
                          className={openBlock.flagged ? 'border-sienna/50 bg-blush text-sienna hover:bg-blush/80' : ''}
                        >
                          <Flag className="h-3.5 w-3.5" strokeWidth={1.75} />
                          {openBlock.flagged ? 'Flagged for follow-up' : 'Flag for follow-up'}
                        </GhostPill>
                        {openBlock.status === 'COMPLETED' && !openBlock.isInternal && (
                          openBlock.attendanceVerified ? (
                            <QuietChip className="text-sienna">
                              <CheckCircle2 className="h-3 w-3" strokeWidth={2} />
                              Attended · verified {openBlock.verifiedAt ? hm(openBlock.verifiedAt) : ''}
                            </QuietChip>
                          ) : (
                            <FilledPill className="h-9" onClick={() => patchEngagement(openBlock.id, { attendanceVerified: true })} disabled={schedBusy}>
                              <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                              Verify attendance
                            </FilledPill>
                          )
                        )}
                      </div>
                    </div>

                    <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-black/5 pt-4">
                      {openBlock.status === 'SCHEDULED' && (
                        <GhostPill onClick={() => patchEngagement(openBlock.id, { status: 'CONFIRMED' })} disabled={schedBusy}>Confirm</GhostPill>
                      )}
                      {(openBlock.status === 'SCHEDULED' || openBlock.status === 'CONFIRMED') && (
                        <GhostPill onClick={() => patchEngagement(openBlock.id, { status: 'LIVE' })} disabled={schedBusy}>
                          <LiveDot />
                          Go live
                        </GhostPill>
                      )}
                      {(openBlock.status === 'CONFIRMED' || openBlock.status === 'LIVE') && (
                        <FilledPill onClick={() => patchEngagement(openBlock.id, { status: 'COMPLETED' })} disabled={schedBusy}>
                          <Check className="h-3.5 w-3.5" strokeWidth={2} />
                          Complete
                        </FilledPill>
                      )}
                      {(openBlock.status === 'SCHEDULED' || openBlock.status === 'CONFIRMED') && (
                        <GhostPill onClick={() => patchEngagement(openBlock.id, { status: 'NO_SHOW' })} disabled={schedBusy}>No-show</GhostPill>
                      )}
                      {openBlock.status !== 'CANCELLED' && openBlock.status !== 'COMPLETED' && (
                        <button
                          type="button"
                          onClick={() => patchEngagement(openBlock.id, { status: 'CANCELLED' })}
                          disabled={schedBusy}
                          className="text-[12px] text-smoke underline-offset-2 hover:underline"
                        >
                          Cancel engagement
                        </button>
                      )}
                    </div>

                    {!openBlock.isInternal && (
                      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-black/5 pt-3 text-[13px]">
                        <a
                          href={`/portal?tenant=${encodeURIComponent(openBlock.clientName)}`}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-ink underline-offset-4 hover:underline"
                        >
                          Open tenant <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={1.75} />
                        </a>
                        <button
                          type="button"
                          onClick={() => {
                            setActiveChatTenant(openBlock.clientName);
                            setActiveTab('communications');
                            setOpenBlock(null);
                          }}
                          className="text-ink underline-offset-4 hover:underline"
                        >
                          Message client
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* ── New engagement dialog ── */}
              {creating && (
                <div
                  className="fixed inset-0 z-[70] grid place-items-center overflow-y-auto bg-ink/25 p-4 backdrop-blur-[2px]"
                  onClick={() => setCreating(false)}
                  role="dialog"
                  aria-modal="true"
                  aria-label="Schedule an engagement"
                >
                  <div className="my-8 w-full max-w-md rounded-[24px] bg-paper p-6 shadow-2xl animate-in fade-in zoom-in-95 duration-200" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-start justify-between gap-3">
                      <h3 className="font-display text-[24px] font-normal leading-tight text-ink">Schedule an engagement</h3>
                      <button type="button" onClick={() => setCreating(false)} aria-label="Close" className="grid h-8 w-8 place-items-center rounded-full text-steel transition-colors hover:bg-mist hover:text-ink">
                        <X className="h-4 w-4" strokeWidth={1.75} />
                      </button>
                    </div>

                    <div className="mt-4 space-y-3 text-[13.5px]">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-steel">Type</span>
                        <select
                          value={draft.type}
                          onChange={(e) => setDraft({ ...draft, type: e.target.value })}
                          aria-label="Engagement type"
                          className="max-w-[220px] cursor-pointer appearance-none rounded-full bg-mist px-3 py-1.5 text-[12.5px] font-medium text-ink outline-none"
                        >
                          {ENGAGEMENT_TYPES.map((t) => (
                            <option key={t} value={t}>{t}</option>
                          ))}
                        </select>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-steel">Client</span>
                        <div className="flex items-center gap-2">
                          <label className="flex items-center gap-1.5 text-[12px] text-steel">
                            <input
                              type="checkbox"
                              checked={draft.internal}
                              onChange={(e) => setDraft({ ...draft, internal: e.target.checked })}
                              className="h-3.5 w-3.5 accent-[#17191c]"
                            />
                            Internal
                          </label>
                          <select
                            value={draft.internal ? '' : draft.clientName}
                            onChange={(e) => setDraft({ ...draft, clientName: e.target.value })}
                            disabled={draft.internal}
                            aria-label="Client"
                            className="max-w-[180px] cursor-pointer appearance-none rounded-full bg-mist px-3 py-1.5 text-[12.5px] font-medium text-ink outline-none disabled:opacity-40"
                          >
                            <option value="">— internal block —</option>
                            {tenants.map((t) => (
                              <option key={t.name} value={t.name}>{t.name}</option>
                            ))}
                          </select>
                        </div>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-steel">Host</span>
                        <select
                          value={draft.hostId}
                          onChange={(e) => setDraft({ ...draft, hostId: e.target.value })}
                          aria-label="Host"
                          className="cursor-pointer appearance-none rounded-full bg-mist px-3 py-1.5 text-[12.5px] font-medium text-ink outline-none"
                        >
                          <option value="">— needs an owner —</option>
                          {hosts.map((m) => (
                            <option key={m.id} value={m.id}>{m.fullName || m.name}</option>
                          ))}
                        </select>
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-steel">When</span>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <input
                            type="date"
                            value={draft.date}
                            onChange={(e) => setDraft({ ...draft, date: e.target.value })}
                            aria-label="Date"
                            className="h-8 rounded-full border border-hairline bg-fog px-2.5 text-[12.5px] tabular-nums outline-none"
                          />
                          <input
                            type="time"
                            value={draft.start}
                            onChange={(e) => setDraft({ ...draft, start: e.target.value })}
                            aria-label="Start time"
                            className="h-8 rounded-full border border-hairline bg-fog px-2.5 text-[12.5px] tabular-nums outline-none"
                          />
                          <select
                            value={draft.durMin}
                            onChange={(e) => setDraft({ ...draft, durMin: Number(e.target.value) })}
                            aria-label="Duration"
                            className="h-8 cursor-pointer appearance-none rounded-full border border-hairline bg-fog px-2.5 text-[12.5px] font-medium tabular-nums text-ink outline-none"
                          >
                            {[15, 30, 45, 60, 90, 120].map((n) => (
                              <option key={n} value={n}>{n < 60 ? `${n} min` : `${n / 60}h${n === 90 ? ' 30m' : ''}`}</option>
                            ))}
                          </select>
                        </div>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-steel">Join line</span>
                        <input
                          value={draft.joinUrl}
                          onChange={(e) => setDraft({ ...draft, joinUrl: e.target.value })}
                          placeholder="Paste Zoom / Meet link (optional)"
                          aria-label="Join link"
                          className="h-9 w-[220px] rounded-full border border-hairline bg-fog px-3.5 text-[12.5px] outline-none focus:border-ink/30"
                        />
                      </div>
                      <div>
                        <span className="text-steel">Notes</span>
                        <textarea
                          value={draft.notes}
                          onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                          rows={2}
                          placeholder="Prep notes, agenda, follow-ups…"
                          aria-label="Engagement notes"
                          className="mt-1.5 w-full rounded-2xl border border-hairline bg-fog p-3 text-[13px] leading-relaxed outline-none focus:border-ink/30"
                        />
                      </div>
                    </div>

                    <div className="mt-4 flex items-center justify-end gap-2 border-t border-black/5 pt-4">
                      <GhostPill onClick={() => setCreating(false)}>Discard</GhostPill>
                      <FilledPill onClick={submitCreate} disabled={schedBusy || (!draft.internal && !draft.clientName)}>
                        {schedBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} /> : <Plus className="h-3.5 w-3.5" strokeWidth={2} />}
                        Schedule
                      </FilledPill>
                    </div>
                    <p className="mt-2 text-[11.5px] text-smoke">
                      Landed on the ledger, signed into the ship's log with your name on it — nothing here is decorated.
                    </p>
                  </div>
                </div>
              )}

              {/* ── Founder absence dialog ── */}
              {absenceFor && hosts.some((m) => m.id === absenceFor) && (
                <div
                  className="fixed inset-0 z-[70] grid place-items-center overflow-y-auto bg-ink/25 p-4 backdrop-blur-[2px]"
                  onClick={() => setAbsenceFor(null)}
                  role="dialog"
                  aria-modal="true"
                  aria-label="Mark founder unavailable"
                >
                  <div className="my-8 w-full max-w-sm rounded-[24px] bg-paper p-6 shadow-2xl animate-in fade-in zoom-in-95 duration-200" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-[12px] text-ash">The day reshuffles — in the open</div>
                        <h3 className="mt-1 font-display text-[22px] font-normal leading-tight text-ink">
                          {hosts.find((m) => m.id === absenceFor)?.fullName || hosts.find((m) => m.id === absenceFor)?.name} going dark
                        </h3>
                      </div>
                      <button type="button" onClick={() => setAbsenceFor(null)} aria-label="Close" className="grid h-8 w-8 place-items-center rounded-full text-steel transition-colors hover:bg-mist hover:text-ink">
                        <X className="h-4 w-4" strokeWidth={1.75} />
                      </button>
                    </div>
                    <p className="mt-2 text-[13px] leading-relaxed text-steel">
                      Today's remaining engagements reassign to the least-loaded founder — with both timestamps printed on the banner and the ship's log.
                    </p>
                    <div className="mt-4 space-y-2.5 text-[13.5px]">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-steel">Reason</span>
                        <select
                          value={absenceReason}
                          onChange={(e) => setAbsenceReason(e.target.value)}
                          aria-label="Absence reason"
                          className="cursor-pointer appearance-none rounded-full bg-mist px-3 py-1.5 text-[12.5px] font-medium text-ink outline-none"
                        >
                          <option value="SICK">Sick</option>
                          <option value="TRAVEL">Travel</option>
                          <option value="FOCUS">Focus block</option>
                          <option value="OTHER">Other</option>
                        </select>
                      </div>
                      <input
                        value={absenceNote}
                        onChange={(e) => setAbsenceNote(e.target.value)}
                        placeholder="Note (optional)"
                        aria-label="Absence note"
                        className="h-9 w-full rounded-full border border-hairline bg-fog px-3.5 text-[13px] outline-none focus:border-ink/30"
                      />
                    </div>
                    <div className="mt-4 flex items-center justify-end gap-2 border-t border-black/5 pt-4">
                      <GhostPill onClick={() => setAbsenceFor(null)}>Never mind</GhostPill>
                      <FilledPill onClick={() => markUnavailable(absenceFor)} disabled={schedBusy}>
                        {schedBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} /> : <UserX className="h-3.5 w-3.5" strokeWidth={1.75} />}
                        Mark unavailable
                      </FilledPill>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
