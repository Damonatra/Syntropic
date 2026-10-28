'use client';

/**
 * Steep design-system primitives + intel panels for the Command Tower.
 * All panels are data-driven: figures arrive via LedgerView (R-01) —
 * nothing financial is hardcoded in the presentation layer.
 */

import React, { useState } from 'react';
import { ArrowRight, ArrowUpRight, ChevronDown, Flame, Globe2, History, ReceiptText, ShieldCheck, Trophy, X } from 'lucide-react';
import type { AuditRecordView, AuditRollupView, CommandLogView, GeoIntelView, LedgerView, ReceiptsView, SeasonsView } from '@/lib/types';

export const ARTIFACT =
  'bg-paper rounded-[20px] shadow-[0_0_0_1px_rgba(4,23,43,0.05),0_16px_24px_-8px_rgba(0,0,0,0.10),0_6px_10px_-6px_rgba(0,0,0,0.08)]';

export function fmtUsd(cents: number, showCents = false): string {
  const opts = showCents
    ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
    : { maximumFractionDigits: 0 };
  return `$${(cents / 100).toLocaleString('en-US', opts)}`;
}

export function LiveDot({ className = 'bg-sienna' }: { className?: string }) {
  return (
    <span className="relative flex h-1.5 w-1.5 shrink-0">
      <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-50 ${className}`} />
      <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${className}`} />
    </span>
  );
}

export function Sparkline({ id, path, className = 'h-7 w-24' }: { id: string; path: string; className?: string }) {
  return (
    <svg viewBox="0 0 100 30" className={className} fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#fbe1d1" stopOpacity="0.85" />
          <stop offset="100%" stopColor="#fbe1d1" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${path} L100 30 L0 30 Z`} fill={`url(#${id})`} stroke="none" />
      <path d={path} stroke="#5d2a1a" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}

export function ViewHeader({
  tag, title, accent, rest, sub,
}: { tag: string; title: string; accent: string; rest: string; sub: string }) {
  return (
    <div className="mb-8 md:mb-10">
      <div className="text-[14px] text-ash">{tag}</div>
      <h1 className="mt-2 font-display text-[34px] font-normal leading-[1.18] tracking-[-0.015em] text-ink md:text-[44px] md:tracking-[-0.02em]">
        {title} <em className="italic">{accent}</em> {rest}
      </h1>
      <p className="mt-3 max-w-xl text-[16px] leading-relaxed text-steel">{sub}</p>
    </div>
  );
}

export function FilledPill({
  children, onClick, type = 'button', className = '', disabled = false,
}: { children: React.ReactNode; onClick?: () => void; type?: 'button' | 'submit'; className?: string; disabled?: boolean }) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center justify-center gap-2 rounded-full bg-ink px-4 py-2 text-[13px] font-medium text-paper transition-colors hover:bg-[#33363b] disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
    >
      {children}
    </button>
  );
}

export function GhostPill({
  children, onClick, className = '', disabled = false,
}: { children: React.ReactNode; onClick?: () => void; className?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center justify-center gap-2 rounded-full border border-ink px-4 py-2 text-[13px] font-medium text-ink transition-colors hover:bg-mist disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
    >
      {children}
    </button>
  );
}

export function BlushChip({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full bg-blush px-3 py-1 text-[12px] font-medium text-sienna ${className}`}>
      {children}
    </span>
  );
}

export function QuietChip({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={`inline-flex w-fit items-center gap-1.5 rounded-full bg-mist px-2.5 py-0.5 text-[12px] font-medium text-ink ${className}`}>
      {children}
    </span>
  );
}

/* ────────────── Clickable intel cards & drill-down panels ────────────── */

export function IntelCard({
  id, active, onToggle, icon: Icon, label, value, hint, spark, peach = false,
}: {
  id: string; active: boolean; onToggle: (id: string) => void; icon: React.ElementType;
  label: string; value: React.ReactNode; hint: string; spark?: { id: string; path: string }; peach?: boolean;
}) {
  const surface = peach ? 'rounded-[24px] bg-blush text-sienna' : ARTIFACT;
  return (
    <button
      type="button"
      onClick={() => onToggle(id)}
      aria-expanded={active}
      className={`group p-5 text-left transition-all duration-200 ${surface} ${
        active
          ? peach ? 'ring-1 ring-sienna/50' : 'ring-1 ring-ink'
          : 'hover:shadow-[0_0_0_1px_rgba(4,23,43,0.06),0_22px_32px_-10px_rgba(0,0,0,0.14),0_8px_12px_-8px_rgba(0,0,0,0.08)]'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className={`text-[13px] ${peach ? 'text-sienna/70' : 'text-steel'}`}>{label}</span>
        <Icon className={`h-4 w-4 transition-colors ${peach ? 'text-sienna/70' : 'text-smoke group-hover:text-steel'}`} strokeWidth={1.75} />
      </div>
      <div className={`mt-1.5 text-[26px] font-medium tracking-[-0.01em] ${peach ? 'text-sienna' : 'text-ink'}`}>
        {value}
      </div>
      {spark && <Sparkline id={spark.id} path={spark.path} />}
      <div className={`mt-1 inline-flex items-center gap-1 text-[12px] transition-colors ${peach ? 'text-sienna/70' : 'text-smoke group-hover:text-steel'}`}>
        {hint}
        <ChevronDown className={`h-3 w-3 transition-transform duration-200 ${active ? 'rotate-180' : ''}`} strokeWidth={2} />
      </div>
    </button>
  );
}

export function PanelShell({
  tag, title, onClose, children,
}: { tag: React.ReactNode; title: React.ReactNode; onClose: () => void; children: React.ReactNode }) {
  return (
    <section className={`mt-4 animate-in fade-in slide-in-from-bottom-2 duration-300 p-6 sm:p-8 ${ARTIFACT}`}>
      <div className="flex items-start justify-between gap-4 border-b border-hairline pb-5">
        <div>
          {tag}
          <h3 className="mt-1.5 font-display text-[26px] font-normal leading-[1.18] tracking-[-0.01em] text-ink">{title}</h3>
        </div>
        <button
          onClick={onClose}
          className="mt-1 inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] text-steel transition-colors hover:bg-mist hover:text-ink"
        >
          Close <X className="h-3.5 w-3.5" strokeWidth={1.75} />
        </button>
      </div>
      <div className="pt-6">{children}</div>
    </section>
  );
}

export function TeamCard({
  initial, tone, name, role, isOnline, target, completed, discovery, auditsClosed, contracts,
  auditPriceLabel = '$3,500', contractLabel = '$50k',
  isCurrentUser, onTargetChange,
}: {
  initial: string; tone: 'ink' | 'blush' | 'steel'; name: string; role: string; isOnline: boolean;
  target: number; completed: number; discovery: number; auditsClosed: number; contracts: number;
  /** Product prices arrive from the server rollup (R-01) — never hardcoded. */
  auditPriceLabel?: string; contractLabel?: string;
  isCurrentUser: boolean; onTargetChange?: (next: number) => void;
}) {
  const avatar = tone === 'ink' ? 'bg-ink text-paper' : tone === 'blush' ? 'bg-blush text-sienna' : 'bg-ink/85 text-paper';
  const pct = target > 0 ? Math.min(100, Math.round((completed / target) * 100)) : 0;
  return (
    <div className="rounded-2xl bg-fog p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className={`relative grid h-10 w-10 place-items-center rounded-full text-[15px] font-medium ${avatar}`}>
            {initial}
            <span
              title={isOnline ? 'Online now' : 'Offline'}
              className={`absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-fog ${isOnline ? 'bg-sienna' : 'bg-smoke/50'}`}
            />
          </div>
          <div>
            <div className="text-[15px] font-medium text-ink">{name}</div>
            <div className="text-[12px] text-smoke">{role}</div>
          </div>
        </div>
        {isOnline ? <LiveDot /> : <span className="text-[11px] text-smoke">offline</span>}
      </div>

      {/* Quarterly outbound target */}
      <div className="mt-4 rounded-xl bg-paper px-3.5 py-3">
        <div className="flex items-center justify-between text-[12.5px]">
          <span className="text-steel">Quarterly outbound</span>
          <span className="font-medium tabular-nums text-ink">
            {completed.toLocaleString()} / {target.toLocaleString()}
          </span>
        </div>
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-mist">
          <div className="h-full rounded-full bg-sienna transition-all duration-500" style={{ width: `${pct}%` }} />
        </div>
        <div className="mt-1.5 flex items-center justify-between text-[11px] text-smoke">
          <span>Q4 progress</span>
          <span className="tabular-nums">{pct}% completed</span>
        </div>
        {isCurrentUser && onTargetChange && (
          <div className="mt-2.5 flex items-center gap-2 border-t border-hairline pt-2.5">
            <label htmlFor={`target-${name}`} className="text-[11.5px] text-steel">Adjust my target:</label>
            <input
              id={`target-${name}`}
              type="number"
              min={1}
              defaultValue={target}
              onBlur={(e) => {
                const next = Number(e.target.value);
                if (Number.isFinite(next) && next >= 1 && next !== target) onTargetChange(next);
                else e.target.value = String(target);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
              className="h-7 w-20 rounded-lg border border-hairline bg-paper px-2 text-[12px] tabular-nums text-ink outline-none transition-shadow focus-visible:shadow-[0_0_0_2px_rgba(93,42,26,0.25)]"
            />
          </div>
        )}
      </div>

      <div className="mt-3 space-y-2">
        {([
          ['Discovery calls booked', discovery.toLocaleString()],
          [`${auditPriceLabel} audits sold`, auditsClosed.toLocaleString()],
          [`${contractLabel} contracts converted`, contracts.toLocaleString()],
        ] as [string, string][]).map(([k, v]) => (
          <div key={k} className="flex items-center justify-between gap-3 rounded-xl bg-paper px-3.5 py-2.5 text-[13px]">
            <span className="text-steel">{k}</span>
            <span className="font-medium tabular-nums text-ink">{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function StatTrio({ rows }: { rows: [string, string][] }) {
  return (
    <div className="mt-4 grid max-w-2xl grid-cols-1 gap-2 sm:grid-cols-3">
      {rows.map(([k, v]) => (
        <div key={k} className="rounded-2xl bg-fog px-4 py-3">
          <div className="text-[12px] text-smoke">{k}</div>
          <div className="mt-0.5 text-[18px] font-medium tabular-nums text-ink">{v}</div>
        </div>
      ))}
    </div>
  );
}

/** Today's funnel — LiveTelemetrySummary rendered as five stat tiles. */
export function TrafficPanel({
  traffic, onClose,
}: {
  traffic: { date: string; totalVisitors: number; uniqueSessions: number; auditsInitiated: number; portalLogins: number; quotesIngested: number };
  onClose: () => void;
}) {
  return (
    <PanelShell
      onClose={onClose}
      tag={<div className="text-[14px] text-ash">Today's funnel · {traffic.date} · UTC day</div>}
      title={<>Live landing & enclave <em className="italic">telemetry</em></>}
    >
      <p className="max-w-xl text-[15px] leading-relaxed text-steel">
        Captured server-side across the LANDING → PORTAL → ENGINE layers. Visitor IPs are hashed with a
        rotating day-salt before they ever touch the ledger — the funnel is measurable without being trackable.
      </p>
      <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-5">
        {([
          ['Total events', traffic.totalVisitors],
          ['Unique sessions', traffic.uniqueSessions],
          ['Audits initiated', traffic.auditsInitiated],
          ['Portal logins', traffic.portalLogins],
          ['Quotes ingested', traffic.quotesIngested],
        ] as [string, number][]).map(([k, v]) => (
          <div key={k} className="rounded-2xl bg-fog px-4 py-3.5">
            <div className="text-[11.5px] uppercase tracking-wide text-smoke">{k}</div>
            <div className="mt-1 text-[24px] font-medium tabular-nums text-ink">{v.toLocaleString('en-US')}</div>
          </div>
        ))}
      </div>
    </PanelShell>
  );
}

const humanEvent = (s: string) => s.toLowerCase().replace(/_/g, ' ');

/** Phase 11.9 — Inbound Industrial Hubs: the GEO-IP intelligence slice,
 *  always-on in the telemetry deck and refreshed by the SSE traffic stream. */
export function GeoHubPanel({ geo }: { geo: GeoIntelView }) {
  const tiles: { label: string; strong: boolean; body: React.ReactNode }[] = [
    {
      label: 'Primary hub',
      strong: true,
      body: geo.primary ? (
        <>
          <div className="mt-1 font-display text-[22px] leading-tight text-ink">
            {geo.primary.city}, {geo.primary.country}
          </div>
          <div className="mt-1 text-[12.5px] text-steel">
            {geo.primary.share}% of today's landing traffic · {geo.primary.events} event{geo.primary.events === 1 ? '' : 's'}
          </div>
        </>
      ) : (
        <>
          <div className="mt-1 font-display text-[22px] text-smoke">—</div>
          <div className="mt-1 text-[12.5px] text-smoke">No geo-resolved landing traffic today</div>
        </>
      ),
    },
    {
      label: 'Active enclave hub',
      strong: false,
      body: geo.enclaveHub ? (
        <>
          <div className="mt-1 font-display text-[22px] leading-tight text-ink">
            {geo.enclaveHub.city}, {geo.enclaveHub.country}
          </div>
          <div className="mt-1 text-[12.5px] text-steel">
            {geo.enclaveHub.tenants} active enclave{geo.enclaveHub.tenants === 1 ? '' : 's'} · {geo.enclaveHub.reviews} HITL pending
          </div>
        </>
      ) : (
        <>
          <div className="mt-1 font-display text-[22px] text-smoke">—</div>
          <div className="mt-1 text-[12.5px] text-smoke">No active enclaves with geo on record</div>
        </>
      ),
    },
    {
      label: 'Emerging corridor',
      strong: false,
      body: geo.emerging ? (
        <>
          <div className="mt-1 font-display text-[22px] leading-tight text-ink">
            {geo.emerging.city}, {geo.emerging.country}
          </div>
          <div className="mt-1 text-[12.5px] text-steel">Latest high-intent signal · {humanEvent(geo.emerging.lastEventType)}</div>
        </>
      ) : (
        <>
          <div className="mt-1 font-display text-[22px] text-smoke">—</div>
          <div className="mt-1 text-[12.5px] text-smoke">No high-intent signals outside the primary hub</div>
        </>
      ),
    },
  ];

  return (
    <section className={`mt-4 animate-in fade-in slide-in-from-bottom-2 duration-300 p-6 sm:p-8 ${ARTIFACT}`}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline pb-5">
        <div>
          <div className="text-[14px] text-ash">Geo-IP intelligence · derived from the traffic ledger</div>
          <h3 className="mt-1.5 flex items-center gap-2.5 font-display text-[26px] font-normal leading-[1.18] tracking-[-0.01em] text-ink">
            <Globe2 className="h-5 w-5 text-sienna" strokeWidth={1.75} />
            Inbound industrial <em className="italic">hubs</em>
          </h3>
        </div>
        <span className="inline-flex items-center gap-2 rounded-full bg-blush px-3 py-1 text-[12px] font-medium text-sienna">
          <LiveDot />
          Live geo stream
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 pt-6 sm:grid-cols-3">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-2xl bg-fog p-5">
            <div className={`text-[11.5px] uppercase tracking-wide ${t.strong ? 'text-sienna/80' : 'text-smoke'}`}>{t.label}</div>
            {t.body}
          </div>
        ))}
      </div>

      {geo.topLocations.length > 1 && (
        <div className="mt-4 grid grid-cols-2 gap-2 border-t border-hairline pt-4 sm:grid-cols-5">
          {geo.topLocations.map((l) => (
            <div key={`${l.city}${l.country}`} className="flex items-center justify-between gap-2 rounded-xl bg-fog px-3 py-2 text-[12.5px]">
              <span className="truncate text-ink">
                {l.city}, {l.country}
              </span>
              <span className="shrink-0 font-medium tabular-nums text-sienna">{l.events}</span>
            </div>
          ))}
        </div>
      )}

      <p className="mt-4 text-[12px] text-smoke">
        Recomputed server-side for the current UTC day · last generated{' '}
        {new Date(geo.generatedAt).toLocaleTimeString('en-US', { hour12: false })} — the panel re-pulls the moment the SSE stream
        carries a landing or enclave event.
      </p>
    </section>
  );
}

/* ── Show-the-work receipts (Feature: every number shows its work) ──
 * Unfolds the exact ledger rows behind a figure, fetched from
 * /api/ledger/receipts. Collapsed by default; fetched on first open. */
const receiptKindLabel = (kind: string) =>
  kind === 'MARGIN_DEFENDED' ? 'Margin defended' : kind === 'SETUP_FEE' ? 'Setup fee' : kind === 'AUDIT_FEE' ? 'Audit fee' : kind;

export function ReceiptsDisclosure({
  tenant, metric = 'defended', label = 'Show the work',
}: {
  tenant: string | null; metric?: 'defended' | 'revshare'; label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<ReceiptsView | null>(null);
  const [error, setError] = useState(false);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && !data && !error) {
      try {
        const params = new URLSearchParams();
        if (tenant) params.set('tenant', tenant);
        params.set('metric', metric);
        const res = await fetch(`/api/ledger/receipts?${params.toString()}`, { cache: 'no-store' });
        if (!res.ok) throw new Error(String(res.status));
        setData((await res.json()) as ReceiptsView);
      } catch {
        setError(true);
      }
    }
  };

  return (
    <div className="border-t border-hairline pt-2.5">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 text-[12px] text-smoke transition-colors hover:text-sienna"
      >
        <ReceiptText className="h-3.5 w-3.5" strokeWidth={1.75} />
        {label}
        <ChevronDown className={`h-3 w-3 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} strokeWidth={2} />
      </button>

      {open && (
        <div className="mt-2.5 animate-in fade-in slide-in-from-bottom-1 duration-200">
          {error && <div className="rounded-xl bg-fog px-3.5 py-3 text-[12.5px] text-steel">Receipts unavailable — the ledger did not answer. Retry in a moment.</div>}
          {!error && !data && <div className="rounded-xl bg-fog px-3.5 py-3 text-[12.5px] text-smoke">Pulling the ledger rows…</div>}
          {!error && data && (
            <div className="rounded-2xl bg-paper shadow-[0_0_0_1px_rgba(4,23,43,0.04)]">
              <div className="divide-y divide-hairline">
                {data.entries.map((e) => (
                  <div key={e.id} className="flex flex-col gap-1 px-3.5 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[12.5px]">
                      <span className="tabular-nums text-smoke">{new Date(e.createdAt).toLocaleDateString('en-US', { day: 'numeric', month: 'short' })}</span>
                      <span className="font-medium text-ink">{receiptKindLabel(e.kind)}</span>
                      {data.scope === 'book' && <span className="text-steel">· {e.tenantName}</span>}
                      {e.note && <span className="truncate text-smoke">— {e.note}</span>}
                    </div>
                    <span className={`shrink-0 text-[13px] font-medium tabular-nums ${e.kind === 'MARGIN_DEFENDED' ? 'text-sienna' : 'text-steel'}`}>{fmtUsd(e.amountCents, true)}</span>
                  </div>
                ))}
                {data.entries.length === 0 && (
                  <div className="px-3.5 py-3 text-[12.5px] text-smoke">No ledger rows in scope yet — the figure is a zero by honest arithmetic.</div>
                )}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-b-2xl border-t border-hairline bg-fog px-3.5 py-2.5 text-[12px]">
                <span className="text-steel">
                  {data.entries.length} entr{data.entries.length === 1 ? 'y' : 'ies'} · Σ defended{' '}<span className="font-medium tabular-nums text-ink">{fmtUsd(data.defendedCents, true)}</span>
                </span>
                {data.metric === 'revshare' ? (
                  <span className="rounded-full bg-blush px-2.5 py-0.5 font-medium text-sienna">
                    × {Math.round(data.rate * 100)}% = <span className="tabular-nums">{fmtUsd(data.derivedCents, true)}</span> rev-share
                  </span>
                ) : (
                  data.feeCents > 0 && <span className="text-smoke">+ fees <span className="tabular-nums">{fmtUsd(data.feeCents, true)}</span> outside the margin figure</span>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ────────────────────────── Intel panels (data-driven) ────────────────────────── */

/* ── The Ship's Log (Feature: append-only command journal) ──
 * Every command issued through the station, attributed and irreversible.
 * Two founders, one memory. */

const SHIP_ACTION_LABEL: Record<string, string> = {
  TARGET_ADJUSTED: 'Target adjusted',
  HITL_ACTION: 'HITL resolution',
  INVITE_ISSUED: 'Invite issued',
  ACCESS_REVOKED: 'Access revoked',
  MESSAGE_SENT: 'Message sent',
  RFQ_SIMULATED: 'RFQ ingested',
  RECONCILED: 'Books reconciled',
};

const actorChipClass = (actor: string) => {
  if (actor.startsWith('Damon')) return 'bg-ink text-paper';
  if (actor.startsWith('Josias')) return 'bg-blush text-sienna';
  if (actor === 'Engine') return 'bg-mist text-steel';
  return 'bg-mist text-ink';
};

export function ShipsLogPanel({ log }: { log: CommandLogView[] }) {
  const dayLabel = (iso: string) => new Date(iso).toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long' });

  // Group consecutive rows under day headings — an editorial chronology.
  const groups: { day: string; rows: CommandLogView[] }[] = [];
  for (const row of log) {
    const day = dayLabel(row.createdAt);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.rows.push(row);
    else groups.push({ day, rows: [row] });
  }

  return (
    <section className={`mt-4 animate-in fade-in slide-in-from-bottom-2 duration-300 p-6 sm:p-8 ${ARTIFACT}`}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline pb-5">
        <div>
          <div className="text-[14px] text-ash">Append-only command journal · attributed & irreversible</div>
          <h3 className="mt-1.5 flex items-center gap-2.5 font-display text-[26px] font-normal leading-[1.18] tracking-[-0.01em] text-ink">
            <History className="h-5 w-5 text-sienna" strokeWidth={1.75} />
            The ship's <em className="italic">log</em>
          </h3>
        </div>
        <span className="inline-flex items-center gap-2 rounded-full bg-mist px-3 py-1 text-[12px] font-medium text-steel">
          {log.length} entr{log.length === 1 ? 'y' : 'ies'} · nothing edited, nothing deleted
        </span>
      </div>

      {log.length === 0 ? (
        <p className="pt-6 text-[14px] text-smoke">
          The log fills as commands are issued — adjust a target, resolve a HITL item, or simulate an RFQ and it will be recorded here, signed by its operator.
        </p>
      ) : (
        <div className="pt-5">
          {groups.map((g) => (
            <div key={g.day} className="mb-2 last:mb-0">
              <div className="mb-2 mt-3 text-[12px] font-medium uppercase tracking-[0.08em] text-smoke first:mt-0">{g.day}</div>
              <div className="space-y-1.5">
                {g.rows.map((row) => (
                  <div key={row.id} className="flex flex-col gap-1.5 rounded-2xl bg-fog px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
                    <span className="w-14 shrink-0 text-[12px] tabular-nums text-smoke">
                      {new Date(row.createdAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}
                    </span>
                    <span className={`w-fit shrink-0 rounded-full px-2.5 py-0.5 text-[11.5px] font-medium ${actorChipClass(row.actor)}`}>
                      {row.actor}
                    </span>
                    <div className="min-w-0 flex-1 text-[13px] leading-relaxed">
                      <span className="font-medium text-ink">{SHIP_ACTION_LABEL[row.action] ?? row.action}</span>
                      {row.target && <span className="text-steel"> · {row.target}</span>}
                      {row.detail && <span className="text-steel"> — {row.detail}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="mt-5 border-t border-hairline pt-4 text-[12px] text-smoke">
        Written by the server at the moment of action — Tower commands sign with the active profile, Telegram approvals sign with the operator key, the engine signs as Engine. The journal is the station's memory: after a month this panel is the company's decision history, not just its dashboard.
      </p>
    </section>
  );
}

/* ── Arena seasons (Feature: the leaderboard becomes a running match) ──
 * Weekly head-to-head + the belt, all computed from ledger ownership. */
export function SeasonStrip({ seasons }: { seasons: SeasonsView }) {
  const beltName = seasons.belt.holder
    ? seasons.scores.find((s) => s.founder === seasons.belt.holder)?.fullName ?? seasons.belt.holder
    : null;

  return (
    <div className="mt-6 rounded-2xl bg-fog p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h4 className="text-[14px] font-medium text-steel">This week's season · {seasons.weekLabel}</h4>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-medium ${
            seasons.belt.holder ? 'bg-blush text-sienna' : 'bg-mist text-steel'
          }`}
        >
          <Trophy className="h-3.5 w-3.5" strokeWidth={1.75} />
          {beltName ? `Belt · ${beltName} — ${seasons.belt.weeksHeld} week${seasons.belt.weeksHeld === 1 ? '' : 's'} held` : 'Belt · unclaimed'}
        </span>
      </div>

      <div className="mt-3 space-y-2.5">
        {seasons.scores.map((s, i) => (
          <div key={s.founder}>
            <div className="flex items-center justify-between text-[12.5px]">
              <span className="font-medium text-ink">
                {s.fullName}
                {i === 0 && seasons.leader === s.founder && <span className="ml-2 text-[11px] font-medium text-sienna">leading</span>}
              </span>
              <span className="tabular-nums text-steel">
                {fmtUsd(s.defendedCents)} · {s.entries} def{s.entries === 1 ? '' : 's'} · {s.sharePct}%
              </span>
            </div>
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-mist">
              <div
                className={`h-full rounded-full transition-all duration-500 ${i === 0 && seasons.leader ? 'bg-sienna' : 'bg-ink/70'}`}
                style={{ width: `${s.sharePct}%` }}
              />
            </div>
          </div>
        ))}
      </div>

      <div className="mt-3 text-[12.5px] text-steel">
        {seasons.leader
          ? `${seasons.scores.find((s) => s.founder === seasons.leader)?.fullName ?? seasons.leader} leads the week by ${fmtUsd(seasons.headToHeadCents)} of defended margin — credited through tenant ownership, recomputed from the ledger every poll.`
          : 'No margin defended yet this week — the season starts with the first defense.'}
      </div>

      {seasons.history.length > 0 && (
        <div className="mt-4 border-t border-hairline pt-3.5">
          <div className="mb-2 text-[11.5px] uppercase tracking-wide text-smoke">Recent weeks</div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            {seasons.history.slice().reverse().map((w) => (
              <div key={w.weekStart} className="rounded-xl bg-paper px-3 py-2">
                <div className="text-[11px] tabular-nums text-smoke">wk of {w.weekStart.slice(5)}</div>
                <div className={`mt-0.5 text-[12.5px] font-medium ${w.winner ? 'text-ink' : 'text-smoke'}`}>
                  {w.winner ? `${w.winner} · ${fmtUsd(w.winnerCents)}` : 'no defenses'}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function ArenaPanel({
  ledger, currentUser, seasons, onUpdateTarget, onClose,
}: {
  ledger: LedgerView; currentUser: string; seasons: SeasonsView | null; onUpdateTarget: (id: string, next: number) => void; onClose: () => void;
}) {
  return (
    <PanelShell
      onClose={onClose}
      tag={
        <BlushChip className="mb-2">
          <Flame className="h-3.5 w-3.5" strokeWidth={1.75} />
          The arena · Damon vs. Josias founder leaderboard
        </BlushChip>
      }
      title={<>Outbound & conversion <em className="italic">targets</em></>}
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {ledger.team.map((m) => (
          <TeamCard
            key={m.id}
            initial={m.fullName.charAt(0)}
            tone={m.tone}
            name={m.fullName}
            role={m.role}
            isOnline={m.isOnline}
            target={m.qOutboundTarget}
            completed={m.qOutboundCompleted}
            discovery={m.discoveryCalls}
            auditsClosed={m.auditsClosed}
            contracts={m.contractsConverted}
            auditPriceLabel={fmtUsd(ledger.auditRollup.diagnosticAuditFeeCents)}
            contractLabel={fmtUsd(ledger.auditRollup.contractValueCents)}
            isCurrentUser={m.name === currentUser}
            onTargetChange={(next) => onUpdateTarget(m.id, next)}
          />
        ))}
      </div>

      {seasons && <SeasonStrip seasons={seasons} />}

      <div className="mt-6 border-t border-hairline pt-5">
        <h4 className="text-[14px] font-medium text-steel">Live client progression pipeline</h4>
        <div className="mt-3 space-y-2">
          {ledger.pipeline.map((row) => (
            <div
              key={row.client}
              className="flex flex-col gap-1.5 rounded-2xl bg-fog px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
            >
              <span className="text-[14px] font-medium text-ink">{row.client}</span>
              <span className="text-[13px] text-steel">{row.stage}</span>
              <span className="text-[13px] text-smoke">Owner · {row.owner}</span>
              <QuietChip>{row.value}</QuietChip>
            </div>
          ))}
        </div>
      </div>
    </PanelShell>
  );
}

export function MarginPanel({ ledger, onClose }: { ledger: LedgerView; onClose: () => void }) {
  return (
    <PanelShell
      onClose={onClose}
      tag={<div className="text-[14px] text-ash">Live client stream</div>}
      title={<>Real-time margins defended <em className="italic">directory</em></>}
    >
      <div className="space-y-3">
        {ledger.clients.map((c) => (
          <React.Fragment key={c.name}>
            <div
              className="flex flex-col gap-3 rounded-2xl bg-fog p-4 md:flex-row md:items-center md:justify-between"
            >
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[14.5px] font-medium text-ink">{c.name}</span>
                <QuietChip>{c.erp}</QuietChip>
                <span
                  className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11.5px] font-medium ${
                    c.paymentStatus === 'PAID'
                      ? 'bg-blush text-sienna'
                      : c.paymentStatus === 'PENDING'
                        ? 'bg-mist text-steel'
                        : 'bg-ink text-paper'
                  }`}
                >
                  {c.paymentStatus}
                </span>
              </div>
              <div className="mt-1 text-[12.5px] text-steel">
                Primary vector: <span className="text-ink">{c.leakageVector || 'Baseline mapped'}</span>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-5">
              <div>
                <div className="text-[11px] text-smoke">24-hour delta</div>
                <div className="text-[13.5px] font-medium tabular-nums text-sienna">
                  +{fmtUsd(c.last24hDeltaCents)}
                </div>
              </div>
              <div>
                <div className="text-[11px] text-smoke">Total defended</div>
                <div className="text-[17px] font-medium tabular-nums text-ink">{fmtUsd(c.totalDefendedCents)}</div>
              </div>
              <a
                href={`/portal?tenant=${encodeURIComponent(c.name)}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-full bg-ink px-4 py-2 text-[12.5px] font-medium text-paper transition-colors hover:bg-[#33363b]"
              >
                Open enclave
                <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={1.75} />
              </a>
            </div>
          </div>

            <ReceiptsDisclosure tenant={c.name} metric="defended" label="Show the work — ledger rows behind these figures" />
          </React.Fragment>
        ))}
      </div>
    </PanelShell>
  );
}

const HORIZONS = ['monthly', 'annual', 'lifetime'] as const;

export function RevsharePanel({ ledger, onClose }: { ledger: LedgerView; onClose: () => void }) {
  const [horizon, setHorizon] = useState<(typeof HORIZONS)[number]>('monthly');
  return (
    <PanelShell
      onClose={onClose}
      tag={<div className="text-[14px] text-ash">Financial horizons & 20% rev-share</div>}
      title={<>Syntropic revenue <em className="italic">velocity</em></>}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-[15px] leading-relaxed text-steel">
          20% of every defended margin, computed server-side from the ledger. Horizons are derived from entry
          timestamps — the monthly window counts the trailing 30 days, so it diverges from lifetime as the ledger ages.
        </p>
        <div className="inline-flex rounded-full border border-hairline bg-fog p-1">
          {HORIZONS.map((h) => (
            <button
              key={h}
              onClick={() => setHorizon(h)}
              aria-pressed={horizon === h}
              className={`rounded-full px-3.5 py-1.5 text-[12.5px] font-medium capitalize transition-colors ${
                horizon === h ? 'bg-ink text-paper' : 'text-steel hover:text-ink'
              }`}
            >
              {h}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 space-y-2">
        {ledger.clients.map((c) => {
          const value =
            horizon === 'monthly' ? c.monthlyRevShareCents : horizon === 'annual' ? c.annualRevShareCents : c.lifetimeRevShareCents;
          return (
            <div
              key={c.name}
              className="flex flex-col gap-2 rounded-2xl bg-fog px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between"
            >
              <div>
                <div className="text-[14px] font-medium text-ink">{c.name}</div>
                <div className="mt-0.5 text-[12.5px] text-steel">
                  Payment status:{' '}
                  <span className={`font-medium ${c.paymentStatus === 'PAID' ? 'text-sienna' : 'text-steel'}`}>
                    {c.paymentStatus}
                  </span>
                </div>
              </div>
              <div className="text-left sm:text-right">
                <div className="text-[11px] uppercase tracking-wide text-smoke">{horizon} 20% cut</div>
                <div className="text-[18px] font-medium tabular-nums text-ink">{fmtUsd(value)}</div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-4 space-y-1">
        {ledger.clients.map((c) => (
          <div key={c.name} className="rounded-2xl bg-fog px-4 py-3">
            <ReceiptsDisclosure tenant={c.name} metric="revshare" label={`Show the work — ${c.name}'s cut, row by row`} />
          </div>
        ))}
      </div>

      <div className="mt-3 rounded-2xl bg-fog px-4 py-3">
        <ReceiptsDisclosure tenant={null} metric="revshare" label="Show the work — the whole book behind the 20% headline" />
      </div>

      <StatTrio
        rows={[
          ['Setup fee', fmtUsd(ledger.setupFeeCents)],
          ['Rev-share', `${Math.round(ledger.revShareRate * 100)}% net margin`],
          ['Projected MRR pipeline', fmtUsd(ledger.projectedMrrCents)],
        ]}
      />
    </PanelShell>
  );
}

export function GuaranteePanel({
  ledger, onClose, onOpenAuditBook,
}: {
  ledger: LedgerView; onClose: () => void; onOpenAuditBook?: () => void;
}) {
  const rollup = ledger.auditRollup;
  return (
    <PanelShell
      onClose={onClose}
      tag={<div className="text-[14px] text-ash">Audit guarantee vault</div>}
      title={<>Audit sales & conversion <em className="italic">history</em></>}
    >
      <div className="space-y-3">
        {ledger.audits.map((a) => (
          <AuditRecordRow key={a.id} a={a} contractValueCents={rollup.contractValueCents} />
        ))}
      </div>

      <div className="mt-5 border-t border-hairline pt-4">
        <StatTrio
          rows={[
            ['Diagnostic audit', fmtUsd(rollup.diagnosticAuditFeeCents)],
            ['Guaranteed recovery floor', fmtUsd(rollup.guaranteedFloorCents)],
            ['Guarantee pass rate', `${Math.round(ledger.guaranteePassRate * 100)}%`],
          ]}
        />
        {onOpenAuditBook && (
          <button
            onClick={onOpenAuditBook}
            className="mt-4 inline-flex items-center gap-1.5 text-[14px] text-ink underline-offset-4 hover:underline"
          >
            The full audit book lives on Tenants & audits <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
        )}
      </div>
    </PanelShell>
  );
}

/**
 * One audit sales record — shared visual truth for the telemetry vault modal
 * and the tab-03 audit book (Task 18). Contract value arrives from the server
 * rollup; nothing is hardcoded.
 */
export function AuditRecordRow({ a, contractValueCents }: { a: AuditRecordView; contractValueCents: number }) {
  return (
    <div className="space-y-3 rounded-2xl bg-fog p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-[14.5px] font-medium text-ink">{a.companyName}</div>
          <div className="mt-0.5 text-[12.5px] text-steel">
            Date sold: {a.dateSold} · Fee: {fmtUsd(a.auditFeeCents)}
            {a.tenantName ? ` · Enclave: ${a.tenantName}` : ' · Not yet a tenant'}
          </div>
        </div>
        <span
          className={`inline-flex items-center rounded-full px-3 py-1 text-[11.5px] font-medium ${
            a.convertedToClient ? 'bg-blush text-sienna' : 'bg-mist text-steel'
          }`}
        >
          {a.convertedToClient ? `Converted · ${fmtUsd(contractValueCents)} executed` : 'Pending conversion'}
        </span>
      </div>

      <div className="space-y-1.5 rounded-xl bg-paper p-3.5 text-[12.5px]">
        <div className="flex justify-between">
          <span className="text-smoke">Briefing call host</span>
          <span className="font-medium text-ink">{a.callHost}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-smoke">Attended call</span>
          <span className={`font-medium ${a.attendedCall ? 'text-sienna' : 'text-steel'}`}>
            {a.attendedCall ? 'Yes (attended)' : 'No (missed session)'}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-smoke">Identified profit leakage</span>
          <span className="font-medium tabular-nums text-ink">{fmtUsd(a.identifiedLeakageCents)}</span>
        </div>
      </div>

      <p className="border-t border-hairline pt-2.5 text-[13px] italic leading-relaxed text-steel">
        “{a.callNotes}”
      </p>
    </div>
  );
}

/**
 * The audit book (Task 18) — funnel + money rollup, every figure server-computed
 * from AuditRecord rows in the same asOf scope as the ledger. Rendered on tab 03
 * so "Tenants & audits" carries both halves of its name.
 */
export function AuditFunnelStrip({ rollup, asOf }: { rollup: AuditRollupView; asOf?: string | null }) {
  const stages: [string, string, string | null][] = [
    ['Audits sold', rollup.auditsSold.toLocaleString(), null],
    ['Attended briefing', rollup.attended.toLocaleString(), `${Math.round(rollup.attendedRate * 100)}% attended`],
    ['Converted to tenant', rollup.converted.toLocaleString(), `${Math.round(rollup.conversionRate * 100)}% conversion`],
    ['Active accounts', rollup.activeAccounts.toLocaleString(), 'book-wide'],
  ];
  return (
    <section className={`mt-4 p-6 sm:p-8 ${ARTIFACT}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[14px] text-ash">
          <ShieldCheck className="h-4 w-4" strokeWidth={1.75} />
          The audit book · recomputed from the sales log on every poll
          {asOf ? ` · as of ${asOf.slice(0, 10)}` : ''}
        </div>
      </div>
      <h3 className="mt-1.5 font-display text-[26px] font-normal leading-[1.18] tracking-[-0.01em] text-ink">
        Every audit, from first call to <em className="italic">executed contract</em>
      </h3>

      {rollup.auditsSold === 0 ? (
        <p className="mt-4 text-[14px] leading-relaxed text-steel">
          No audits on the book yet — the funnel fills as briefing calls are sold and logged.
        </p>
      ) : (
        <>
          <div className="mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-2xl bg-hairline md:grid-cols-4">
            {stages.map(([label, value, sub], i) => (
              <div key={label} className="bg-paper p-4">
                <div className="flex items-center gap-1.5 text-[11.5px] font-medium uppercase tracking-[0.06em] text-smoke">
                  <span>{`0${i + 1}`}</span>
                  {i < stages.length - 1 && <ArrowRight className="h-3 w-3 text-smoke/60" strokeWidth={1.75} />}
                </div>
                <div className="mt-1 font-display text-[30px] font-normal leading-none tracking-[-0.01em] text-ink">{value}</div>
                <div className="mt-1.5 text-[13px] font-medium text-ink">{label}</div>
                <div className="text-[11.5px] text-smoke">{sub ?? 'from the audit rows'}</div>
              </div>
            ))}
          </div>

          <div className="mt-4">
            <StatTrio
              rows={[
                ['Audit revenue collected', fmtUsd(rollup.auditRevenueCents)],
                ['Leakage identified in briefings', fmtUsd(rollup.identifiedLeakageCents)],
                [
                  'Defended per leakage $ identified',
                  rollup.leakageRecoveryRatio === null
                    ? '—'
                    : `$${rollup.leakageRecoveryRatio.toFixed(2)} · ${fmtUsd(rollup.marginDefendedCents)} defended`,
                ],
              ]}
            />
          </div>

          <p className="mt-4 text-[12.5px] leading-relaxed text-smoke">
            Accounts also arrive through direct intake — the conversion rate counts audit-sourced work only. The
            diagnostic fee, recovery floor, and contract value are server-owned product constants, not UI text.
          </p>
        </>
      )}
    </section>
  );
}

/** The audit sales log as a full tab-03 section (Task 18). */
export function AuditLogList({ audits, rollup }: { audits: AuditRecordView[]; rollup: AuditRollupView }) {
  return (
    <section className={`mt-4 p-2 sm:p-3 ${ARTIFACT}`}>
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 pb-2 pt-2.5 sm:px-4">
        <h2 className="flex items-center gap-2 text-[15px] font-medium text-ink">
          <ReceiptText className="h-4 w-4 text-sienna" strokeWidth={1.75} />
          Audit sales log
        </h2>
        <span className="text-[12.5px] text-smoke">
          {audits.length} record{audits.length === 1 ? '' : 's'} · every row linked to its enclave when one exists
        </span>
      </div>
      <div className="space-y-3 p-2 sm:p-3">
        {audits.length === 0 ? (
          <p className="px-1 pb-1 text-[14px] leading-relaxed text-steel">
            Nothing on the sales log yet as of this date.
          </p>
        ) : (
          audits.map((a) => <AuditRecordRow key={a.id} a={a} contractValueCents={rollup.contractValueCents} />)
        )}
      </div>
    </section>
  );
}
