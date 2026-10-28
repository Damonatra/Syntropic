'use client';

/**
 * Layer 3 — Executive Enclave portal (client-facing twin of the Command Tower).
 * Auth model: exactly one enclave per session. The tenant is fixed by the
 * server (session cookie scoped to /portal); there is no switcher. The
 * direct line streams over /portal/api/messages — session-scoped, so a
 * client can only ever read/write its own thread — while the Backbone's
 * unified inbox (R-06) sees client messages as unread within seconds.
 * All financials arrive server-computed from /portal/api/enclave (R-01).
 *
 * Task 19 — trust as the product: the enclave now carries the reconciliation
 * stamp (the same self-audit the tower runs), the client's money trail
 * (recentLedger rendered, no longer a dead payload), expandable per-intercept
 * receipts, genuinely-upcoming calls with one-click Join, a document shelf
 * with upload + download, and Seen receipts on the direct line. Live updates
 * ride the session-scoped SSE bus (/portal/api/bus) with an honest polling
 * fallback; the feed itself reconciles every 30s.
 *
 * Task 20 — the four stat tiles become clickable panels: tap a tile and a
 * full-width panel opens beneath the row (one at a time, deep-linkable via
 * #money / #defenses / #guarantee / #account). Margin recovered unfolds into
 * a 6-month bar strip + top recoveries; Defenses logged into the full
 * grouped log with filters; Guarantee status into the plain-language terms
 * card with the floor progress bar; Deposit / fee into the stage-driven
 * billing line, Syntropic's cut derived from REV_SHARE_RATE, the twin
 * paid/recovered lines, and the fee receipts. Every panel closes with the
 * same provenance sentence — the reconciliation stamp, verbatim.
 *
 * Task 21 — the money panel's graph upgrades to the dot-matrix language of
 * the reference card: columns are stacks of dots, not filled bars; the
 * current period renders in ink and every earlier one in quiet gray; empty
 * periods keep a single dim baseline dot so the floor runs unbroken; and a
 * real DAILY / WEEKLY / MONTHLY toggle re-buckets the same signed ledger
 * rows (marginEvents) client-side — no fabricated density, every column
 * traceable. The headline is the server-computed 30d-vs-prior-30d growth,
 * falling back to the absolute figure when the prior window is empty.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Clock,
  Copy,
  Download,
  ExternalLink,
  FileText,
  Loader2,
  LogOut,
  MessageSquare,
  Send,
  ShieldCheck,
  TrendingUp,
  Upload,
  X,
} from 'lucide-react';
import { ARTIFACT, LiveDot, ViewHeader, fmtUsd } from '@/components/backbone/primitives';
import type { InterceptView, MessageView } from '@/lib/types';
import type { MarginEventView, PortalEnclaveView, TenantDocumentView } from '@/app/portal/api/enclave/route';

const when = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

const dayLabel = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

const isToday = (iso: string) =>
  new Date(iso).toDateString() === new Date().toDateString();

const stampWhen = (iso: string) => (isToday(iso) ? when(iso) : `${dayLabel(iso)} · ${when(iso)}`);

const KIND_LABEL: Record<string, string> = {
  MARGIN_DEFENDED: 'Margin defended',
  SETUP_FEE: 'Setup fee',
  AUDIT_FEE: 'Audit fee',
};

const PROVIDER_LABEL: Record<string, string> = {
  ZOOM: 'Zoom',
  MEET: 'Google Meet',
  MANUAL: 'Direct link',
  ENCLAVE: 'Enclave room',
};

const STAGE_LABEL: Record<string, string> = {
  DISCOVERY: 'Discovery',
  SETUP: 'Setup in progress',
  AUDIT: 'Audit stage',
  LIVE: 'Live rev-share',
};

type PanelKey = 'money' | 'defenses' | 'guarantee' | 'account';

const PANEL_KEYS: PanelKey[] = ['money', 'defenses', 'guarantee', 'account'];

const PANEL_META: Record<PanelKey, { label: string; title: string }> = {
  money: { label: 'Margin recovered', title: 'The receipts behind the number' },
  defenses: { label: 'Defenses logged', title: 'The defense log' },
  guarantee: { label: 'Guarantee status', title: 'The guarantee, in plain terms' },
  account: { label: 'Deposit / fee', title: 'Where your money stands' },
};

const dateOnly = (ymd: string) =>
  new Date(`${ymd}T00:00:00`).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });

/** One intercept row, rendered as a tappable receipt — shared by the feed and the defense log. */
function InterceptRow({ e, open, onToggle }: { e: InterceptView; open: boolean; onToggle: () => void }) {
  return (
    <div>
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center justify-between gap-4 py-3.5 text-left"
      >
        <div className="min-w-0">
          <div className="truncate text-[14px] font-medium text-ink">{e.item}</div>
          <div className="mt-0.5 text-[12px] text-smoke tabular-nums">
            {when(e.createdAt)} · {e.channel} · quoted {fmtUsd(e.origCents, true)}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="text-right">
            <div className="text-[14px] font-medium text-ink tabular-nums">{fmtUsd(e.defendedCents, true)}</div>
            <div className="mt-0.5 inline-flex items-center rounded-full bg-blush px-2 py-0.5 text-[11.5px] font-medium text-sienna tabular-nums">
              +{fmtUsd(e.diffCents, true)} recovered
            </div>
          </div>
          <ChevronDown
            className={`h-4 w-4 shrink-0 text-smoke transition-transform ${open ? 'rotate-180' : ''}`}
            strokeWidth={1.75}
          />
        </div>
      </button>
      {open && (
        <div className="pb-4">
          <div className="space-y-1.5 rounded-2xl bg-fog p-4 text-[12.5px] leading-relaxed text-steel">
            <div className="flex justify-between gap-4">
              <span>Quoted position</span>
              <span className="font-medium text-ink tabular-nums">{fmtUsd(e.origCents, true)}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span>Defended position</span>
              <span className="font-medium text-ink tabular-nums">{fmtUsd(e.defendedCents, true)}</span>
            </div>
            <div className="flex justify-between gap-4 border-t border-hairline pt-1.5">
              <span>Recovered</span>
              <span className="font-medium text-sienna tabular-nums">+{fmtUsd(e.diffCents, true)}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span>Channel</span>
              <span className="font-medium text-ink">{e.channel}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span>Logged</span>
              <span className="font-medium text-ink tabular-nums">
                {dayLabel(e.createdAt)} · {when(e.createdAt)}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const sizeLabel = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;

/* ── Task 20 — panel bodies. Every figure arrives server-composed; these  ──
   components only format and arrange.                                        */

/* ── Task 21 — the margin dot-matrix. The graph buckets the signed ledger   ──
   rows (marginEvents) into the selected granularity; encoding rules are      ──
   fixed and stated on-screen: twelve dot rows max, quantized to the          ──
   strongest period on screen, ink for the current period, gray for the      ──
   past, one dim baseline dot when a period is empty.                         */

const RANGE_DAILY = 14;
const RANGE_WEEKLY = 8;
const RANGE_MONTHLY = 6;
const MAX_DOTS = 12;

type MarginRange = 'daily' | 'weekly' | 'monthly';

/** Chart-footer values: full dollars monthly, compact when columns get dense. */
const fmtCompactUsd = (cents: number) => {
  if (cents === 0) return '—';
  const usd = cents / 100;
  if (Math.abs(usd) >= 1000) {
    const k = usd / 1000;
    return `$${(k >= 100 ? Math.round(k) : Number(k.toFixed(1))).toLocaleString('en-US')}k`;
  }
  return `$${Math.round(usd).toLocaleString('en-US')}`;
};

interface MarginBucket {
  label: string;
  cents: number;
  display: string;
  current: boolean;
}

/**
 * Bucket the signed margin rows into the selected granularity — UTC
 * throughout, the same clock the server composes its windows on. Buckets
 * walk backward from today; the last one is always the current period.
 */
function buildMarginBuckets(events: MarginEventView[], range: MarginRange): MarginBucket[] {
  const count = range === 'daily' ? RANGE_DAILY : range === 'weekly' ? RANGE_WEEKLY : RANGE_MONTHLY;
  const buckets: { start: number; end: number; label: string }[] = [];

  if (range === 'monthly') {
    const first = new Date();
    first.setUTCDate(1);
    first.setUTCMonth(first.getUTCMonth() - (count - 1));
    first.setUTCHours(0, 0, 0, 0);
    for (let i = 0; i < count; i++) {
      const s = new Date(first);
      s.setUTCMonth(first.getUTCMonth() + i);
      const e = new Date(s);
      e.setUTCMonth(s.getUTCMonth() + 1);
      buckets.push({
        start: s.getTime(),
        end: e.getTime(),
        label: s.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }),
      });
    }
  } else if (range === 'weekly') {
    // Monday-start UTC weeks; the current (still-open) week is the last bucket.
    const now = new Date();
    const monday = new Date(now);
    monday.setUTCDate(now.getUTCDate() - ((now.getUTCDay() + 6) % 7));
    monday.setUTCHours(0, 0, 0, 0);
    for (let i = count - 1; i >= 0; i--) {
      const s = new Date(monday);
      s.setUTCDate(monday.getUTCDate() - 7 * i);
      const e = new Date(s);
      e.setUTCDate(s.getUTCDate() + 7);
      buckets.push({
        start: s.getTime(),
        end: e.getTime(),
        label: s.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }),
      });
    }
  } else {
    for (let i = count - 1; i >= 0; i--) {
      const s = new Date();
      s.setUTCHours(0, 0, 0, 0);
      s.setUTCDate(s.getUTCDate() - i);
      const e = new Date(s);
      e.setUTCDate(s.getUTCDate() + 1);
      // Anchor the month on day 1 and on the oldest bucket; bare day numbers elsewhere.
      const anchor = s.getUTCDate() === 1 || i === count - 1;
      buckets.push({
        start: s.getTime(),
        end: e.getTime(),
        label: anchor
          ? s.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
          : String(s.getUTCDate()),
      });
    }
  }

  return buckets.map((b, i) => {
    const cents = events
      .filter((ev) => {
        const t = new Date(ev.at).getTime();
        return t >= b.start && t < b.end;
      })
      .reduce((s, ev) => s + ev.cents, 0);
    return {
      label: b.label,
      cents,
      display: cents === 0 ? '—' : range === 'monthly' ? fmtUsd(cents) : fmtCompactUsd(cents),
      current: i === buckets.length - 1,
    };
  });
}

/** One period of the dot-matrix: a bottom-stacked dot column + its footer. */
function DotBucket({ b, dots }: { b: MarginBucket; dots: number }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col items-center">
      <div className="flex h-24 w-full flex-col items-center justify-end gap-y-[3px]">
        {dots === 0 ? (
          <span aria-hidden="true" className="h-[5px] w-[5px] rounded-full bg-smoke/30" />
        ) : (
          Array.from({ length: dots }).map((_, i) => (
            <span
              key={i}
              aria-hidden="true"
              className={`h-[5px] w-[5px] rounded-full ${b.current ? 'bg-ink' : 'bg-ash/60'}`}
            />
          ))
        )}
      </div>
      <div className="mt-2 text-center">
        <div
          className={`text-[10px] uppercase tracking-[0.08em] ${b.current ? 'font-medium text-ink' : 'text-smoke'}`}
        >
          {b.label}
        </div>
        <div
          className={`mt-0.5 text-[10.5px] tabular-nums ${
            b.current ? 'font-medium text-ink' : b.cents > 0 ? 'text-steel' : 'text-smoke/70'
          }`}
        >
          {b.display}
        </div>
      </div>
    </div>
  );
}

function MoneyBody({ enclave }: { enclave: PortalEnclaveView }) {
  const [range, setRange] = useState<MarginRange>('monthly');
  const buckets = buildMarginBuckets(enclave.marginEvents, range);
  const maxCents = Math.max(...buckets.map((b) => b.cents), 1);
  const dotsFor = (b: MarginBucket) => (b.cents > 0 ? Math.max(1, Math.round((b.cents / maxCents) * MAX_DOTS)) : 0);
  const delta = enclave.recoveryDelta;
  const top = [...enclave.defenseLog.rows].sort((a, b) => b.diffCents - a.diffCents).slice(0, 3);
  const latest = enclave.intercepts[0] ?? null;

  // The headline: the real growth figure, with honest fallbacks — a percent
  // over an empty prior window is a fabrication, so the absolute takes over.
  const headline =
    delta.pct !== null
      ? `${delta.pct < 0 ? '' : '+'}${delta.pct}%`
      : delta.last30dCents > 0
        ? fmtUsd(delta.last30dCents)
        : '$0';
  const subline =
    delta.pct !== null
      ? `${fmtUsd(delta.last30dCents)} in the last 30 days vs ${fmtUsd(delta.prev30dCents)} the 30 before.`
      : delta.last30dCents > 0
        ? `${fmtUsd(delta.last30dCents)} in the last 30 days — the first defenses landed inside this window.`
        : 'No margin defended yet — your first defenses will chart here.';
  const ariaSummary = `Margin recovered by ${range}: ${buckets
    .map((b) => `${b.label} ${b.cents > 0 ? fmtUsd(b.cents) : 'none'}`)
    .join(', ')}.`;

  return (
    <div className="mt-4 space-y-5">
      <section className="rounded-2xl bg-fog p-4 sm:p-5">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div>
            <div className="text-[12.5px] font-medium uppercase tracking-wide text-smoke">Margin recovered</div>
            <div className="mt-1.5 font-display text-[38px] leading-none text-ink tabular-nums">{headline}</div>
            <div className="mt-2 max-w-md text-[12.5px] leading-relaxed text-steel">{subline}</div>
          </div>
          <div className="flex gap-3.5 pb-1" role="group" aria-label="Chart granularity">
            {(['daily', 'weekly', 'monthly'] as const).map((r) => (
              <button
                key={r}
                type="button"
                aria-pressed={range === r}
                onClick={() => setRange(r)}
                className={`cursor-pointer text-[11px] uppercase tracking-[0.14em] transition-colors ${
                  range === r ? 'font-medium text-ink' : 'text-smoke hover:text-steel'
                }`}
              >
                {r}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4 border-t border-hairline pt-5" role="img" aria-label={ariaSummary}>
          <div className="flex items-end gap-1.5 sm:gap-2.5">
            {buckets.map((b, i) => (
              <DotBucket key={`${range}-${i}`} b={b} dots={dotsFor(b)} />
            ))}
          </div>
        </div>
        <p className="mt-3 text-[11.5px] leading-relaxed text-smoke">
          Each column stacks in twelfths of the strongest period shown — computed from the same signed ledger rows
          your money trail prints. Empty periods keep their baseline dot.
        </p>
      </section>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="rounded-2xl bg-fog p-4">
          <div className="text-[12.5px] font-medium uppercase tracking-wide text-smoke">The big ones</div>
          {top.length > 0 ? (
            <div className="mt-2 divide-y divide-hairline">
              {top.map((e) => (
                <div key={e.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <div className="truncate text-[13.5px] font-medium text-ink">{e.item}</div>
                    <div className="text-[11.5px] text-smoke tabular-nums">{dayLabel(e.createdAt)}</div>
                  </div>
                  <div className="shrink-0 text-[13.5px] font-medium text-sienna tabular-nums">+{fmtUsd(e.diffCents, true)}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-2 text-[13px] text-steel">No defenses yet — the big ones will surface here.</div>
          )}
        </div>
        <div className="rounded-2xl bg-fog p-4">
          <div className="text-[12.5px] font-medium uppercase tracking-wide text-smoke">Latest defense</div>
          {latest ? (
            <div className="mt-2 space-y-1.5 text-[12.5px] leading-relaxed text-steel">
              <div className="text-[14px] font-medium text-ink">{latest.item}</div>
              <div className="flex justify-between gap-4">
                <span>Quoted</span>
                <span className="font-medium text-ink tabular-nums">{fmtUsd(latest.origCents, true)}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span>Defended</span>
                <span className="font-medium text-ink tabular-nums">{fmtUsd(latest.defendedCents, true)}</span>
              </div>
              <div className="flex justify-between gap-4 border-t border-hairline pt-1.5">
                <span>Recovered</span>
                <span className="font-medium text-sienna tabular-nums">+{fmtUsd(latest.diffCents, true)}</span>
              </div>
              <div className="tabular-nums">
                {dayLabel(latest.createdAt)} · {when(latest.createdAt)} · {latest.channel}
              </div>
            </div>
          ) : (
            <div className="mt-2 text-[13px] text-steel">Nothing defended yet — your first RFQ will land here.</div>
          )}
        </div>
      </div>

      <p className="text-[12.5px] leading-relaxed text-steel">
        Every dollar here traces to a signed ledger row. Nothing on this page is typed by hand.
      </p>
    </div>
  );
}

const DEFENSE_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'money', label: 'Money moved' },
  { key: 'signoff', label: 'Needed your sign-off' },
] as const;

type DefenseFilter = (typeof DEFENSE_FILTERS)[number]['key'];

function DefensesBody({
  enclave,
  expandedId,
  onToggle,
}: {
  enclave: PortalEnclaveView;
  expandedId: string | null;
  onToggle: (id: string) => void;
}) {
  const [filter, setFilter] = useState<DefenseFilter>('all');
  const rows = enclave.defenseLog.rows.filter((e) =>
    filter === 'money' ? e.diffCents > 0 : filter === 'signoff' ? e.source === 'HITL_APPROVAL' : true,
  );
  const moneyCount = enclave.defenseLog.rows.filter((e) => e.diffCents > 0).length;
  const signoffCount = enclave.defenseLog.rows.filter((e) => e.source === 'HITL_APPROVAL').length;
  const counts: Record<DefenseFilter, number> = {
    all: enclave.defenseLog.rows.length,
    money: moneyCount,
    signoff: signoffCount,
  };

  // Calendar-month grouping — headers appear as the log walks back in time.
  const groups: { label: string; rows: typeof rows }[] = [];
  for (const r of rows) {
    const label = new Date(r.createdAt).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.rows.push(r);
    else groups.push({ label, rows: [r] });
  }

  return (
    <div className="mt-4 space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="inline-flex flex-wrap gap-1.5 rounded-full border border-hairline bg-fog p-1">
          {DEFENSE_FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              aria-pressed={filter === f.key}
              className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full px-3 py-1.5 text-[12.5px] font-medium transition-colors ${
                filter === f.key ? 'bg-ink text-paper' : 'text-steel hover:text-ink'
              }`}
            >
              {f.label}
              <span className={`tabular-nums ${filter === f.key ? 'text-paper/70' : 'text-smoke'}`}>{counts[f.key]}</span>
            </button>
          ))}
        </div>
        {enclave.defenseLog.byChannel.length > 0 && (
          <div className="text-[12px] text-steel tabular-nums">
            Where the fights happen: {enclave.defenseLog.byChannel.map((c) => `${c.channel} ${c.count}`).join(' · ')}
          </div>
        )}
        {enclave.defenseLog.avgDiffCents > 0 && (
          <div className="text-[12px] text-sienna tabular-nums">
            Average +{fmtUsd(enclave.defenseLog.avgDiffCents, true)} recovered per defense
          </div>
        )}
      </div>

      {enclave.defenseLog.total === 0 ? (
        <div className="py-6 text-center text-[13.5px] text-steel">
          Nothing to defend yet — your first week of RFQs will fill this log.
        </div>
      ) : rows.length === 0 ? (
        <div className="py-6 text-center text-[13.5px] text-steel">No defenses match this filter.</div>
      ) : (
        <div className="divide-y divide-hairline">
          {groups.map((g) => (
            <div key={g.label}>
              <div className="pt-3 pb-1 text-[11.5px] font-medium uppercase tracking-wide text-smoke">{g.label}</div>
              {g.rows.map((e) => (
                <InterceptRow key={e.id} e={e} open={expandedId === e.id} onToggle={() => onToggle(e.id)} />
              ))}
            </div>
          ))}
        </div>
      )}

      {enclave.defenseLog.total > enclave.defenseLog.rows.length && (
        <p className="text-[12px] text-smoke">
          Showing the most recent {enclave.defenseLog.rows.length} of {enclave.defenseLog.total} defenses.
        </p>
      )}
    </div>
  );
}

function GuaranteeBody({ enclave }: { enclave: PortalEnclaveView }) {
  const g = enclave.guarantee;
  const nextCall = enclave.calls[0] ?? null;
  const floorPct = g.floorCents > 0 ? Math.min(100, Math.round((g.identifiedLeakageCents / g.floorCents) * 100)) : 0;
  const floorMult = g.floorCents > 0 ? (g.identifiedLeakageCents / g.floorCents).toFixed(1) : null;
  return (
    <div className="mt-4 space-y-5">
      <div className="divide-y divide-hairline rounded-2xl bg-fog px-4">
        {g.terms.map((t, i) => (
          <div key={i} className="flex items-start gap-3 py-3 text-[13.5px] leading-relaxed text-ink">
            <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-sienna" />
            <span>{t}</span>
          </div>
        ))}
      </div>

      <div>
        <div className="flex items-center justify-between text-[12.5px]">
          <span className="font-medium uppercase tracking-wide text-smoke">Against your guaranteed floor</span>
          <span className="font-medium text-ink tabular-nums">
            {fmtUsd(g.identifiedLeakageCents, true)} / {fmtUsd(g.floorCents, true)}
          </span>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-mist">
          <div className="h-full rounded-full bg-blush" style={{ width: `${floorPct}%` }} />
        </div>
        <div className="mt-2 text-[12.5px] leading-relaxed text-steel">
          {g.identifiedLeakageCents > 0
            ? `${fmtUsd(g.identifiedLeakageCents, true)} of margin leakage identified${floorMult ? ` — ${floorMult}× your guaranteed floor` : ''}.`
            : 'No audit on file yet — the floor applies from contract execution.'}
        </div>
      </div>

      <div className="space-y-1.5 text-[12.5px] leading-relaxed text-steel">
        {g.passed ? (
          <div className="inline-flex items-center gap-1.5 font-medium text-sienna">
            <ShieldCheck className="h-3.5 w-3.5" strokeWidth={1.75} />
            Baseline locked — {g.label.toLowerCase()}
          </div>
        ) : nextCall ? (
          <span>
            Your 48-hour diagnostic is scheduled <span className="font-medium text-ink">{dayLabel(nextCall.scheduledAt)} · {when(nextCall.scheduledAt)}</span> — the floor applies from contract execution.
          </span>
        ) : (
          <span>{g.label} — your owner books the diagnostic here when it's scheduled.</span>
        )}
        {g.latestAudit && (
          <div className="tabular-nums">
            Baseline source — diagnostic audit sold {dateOnly(g.latestAudit.dateSold)} · {fmtUsd(g.latestAudit.auditFeeCents, true)}
          </div>
        )}
      </div>
    </div>
  );
}

function AccountBody({ enclave }: { enclave: PortalEnclaveView }) {
  const b = enclave.billing;
  const cut = enclave.cut;
  const ratePct = Math.round(cut.rate * 100);
  return (
    <div className="mt-4 space-y-5">
      <div className="rounded-2xl bg-fog p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-hairline px-2.5 py-0.5 text-[11.5px] font-medium text-steel">
            {STAGE_LABEL[b.stage] ?? b.stage}
          </span>
          {b.overdue && (
            <span className="inline-flex items-center gap-1 rounded-full bg-blush px-2.5 py-0.5 text-[11.5px] font-medium text-sienna">
              <AlertTriangle className="h-3 w-3" strokeWidth={1.75} />
              Installment overdue
            </span>
          )}
        </div>
        <div className="mt-2 text-[15.5px] font-medium leading-snug text-ink">{b.line}</div>
        {b.note && <div className="mt-1.5 text-[13px] leading-relaxed text-steel">{b.note}</div>}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-2xl border border-hairline p-4">
          <div className="text-[12px] uppercase tracking-wide text-smoke">You've paid to date</div>
          <div className="mt-1 font-display text-[24px] leading-none text-ink tabular-nums">{fmtUsd(enclave.paidToDateCents)}</div>
          <div className="mt-1.5 text-[12px] text-steel">Every payment is a receipt below.</div>
        </div>
        <div className="rounded-2xl border border-hairline bg-blush/60 p-4">
          <div className="text-[12px] uppercase tracking-wide text-sienna/80">We've recovered for you</div>
          <div className="mt-1 font-display text-[24px] leading-none text-sienna tabular-nums">{fmtUsd(enclave.marginDefendedCents)}</div>
          <div className="mt-1.5 text-[12px] text-sienna/70">Lifetime, from the same ledger your team reconciles.</div>
        </div>
      </div>

      <div className="rounded-2xl bg-fog p-4">
        <div className="text-[12.5px] font-medium uppercase tracking-wide text-smoke">Syntropic's cut — {ratePct}% of everything we defend</div>
        <div className="mt-2.5 space-y-2 text-[13.5px]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-steel">In the last 30 days</span>
            <span className="text-ink tabular-nums">
              {fmtUsd(cut.last30dDefendedCents, true)} defended → <span className="font-medium">{fmtUsd(cut.last30dCutCents, true)} our cut</span>
            </span>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-hairline pt-2">
            <span className="text-steel">To date</span>
            <span className="text-ink tabular-nums">
              {fmtUsd(enclave.marginDefendedCents, true)} defended → <span className="font-medium">{fmtUsd(cut.lifetimeCutCents, true)} our cut</span>
            </span>
          </div>
        </div>
        <div className="mt-2.5 text-[12px] leading-relaxed text-steel">
          Derived from the same MARGIN_DEFENDED rows printed in your money trail — computed server-side, never typed.
        </div>
      </div>

      <div>
        <div className="text-[12.5px] font-medium uppercase tracking-wide text-smoke">Your payment receipts</div>
        {enclave.feeLedger.length > 0 ? (
          <div className="mt-2 divide-y divide-hairline">
            {enclave.feeLedger.map((l) => (
              <div key={l.id} className="flex items-center justify-between gap-4 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="shrink-0 rounded-full border border-hairline px-2 py-0.5 text-[11px] font-medium text-steel">
                      {KIND_LABEL[l.kind] ?? l.kind}
                    </span>
                    <span className="truncate text-[13.5px] text-ink">{l.note ?? '—'}</span>
                  </div>
                  <div className="mt-0.5 text-[12px] text-smoke tabular-nums">
                    {dayLabel(l.createdAt)} · {when(l.createdAt)}
                  </div>
                </div>
                <div className="shrink-0 text-[14px] font-medium text-ink tabular-nums">{fmtUsd(l.amountCents, true)}</div>
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-2 text-[13px] text-steel">
            No payments on the ledger yet — nothing is owed until your audit begins.
          </div>
        )}
      </div>
    </div>
  );
}

export default function EnclavePortal({
  tenantName,
  contactName,
}: {
  tenantName: string;
  contactName: string;
}) {
  const router = useRouter();
  const [enclave, setEnclave] = useState<PortalEnclaveView | null>(null);
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [streamLive, setStreamLive] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [openPanel, setOpenPanel] = useState<PanelKey | null>(null);
  const [copiedCallId, setCopiedCallId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [shelfNote, setShelfNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const fetchJson = useCallback(async <T,>(url: string, init?: RequestInit): Promise<T> => {
    const res = await fetch(url, { cache: 'no-store', ...init });
    if (res.status === 401) {
      // Session expired — hard redirect to sign-in.
      window.location.href = '/portal/login';
      throw new Error('unauthenticated');
    }
    if (!res.ok) throw new Error(`${url} → ${res.status}`);
    return res.json() as Promise<T>;
  }, []);

  const refreshEnclave = useCallback(async () => {
    try {
      setEnclave(await fetchJson<PortalEnclaveView>('/portal/api/enclave'));
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, [fetchJson]);

  const refreshMessages = useCallback(async () => {
    try {
      setMessages(await fetchJson<MessageView[]>('/portal/api/messages'));
    } catch {
      /* transient — next tick retries (401 already redirects) */
    }
  }, [fetchJson]);

  // Enclave data: on mount + 30s reconciliation poll (SSE covers the pushes).
  useEffect(() => {
    refreshEnclave().catch(() => undefined);
    const slow = setInterval(() => refreshEnclave().catch(() => undefined), 30_000);
    return () => clearInterval(slow);
  }, [refreshEnclave]);

  // Direct line: initial load, then the session-scoped SSE bus pushes.
  useEffect(() => {
    refreshMessages().catch(() => undefined);
  }, [refreshMessages]);

  useEffect(() => {
    const es = new EventSource('/portal/api/bus');
    es.onopen = () => setStreamLive(true);
    es.onerror = () => setStreamLive(false); // EventSource retries; polling takes over below
    es.addEventListener('message', () => void refreshMessages());
    es.addEventListener('thread-read', () => void refreshMessages());
    es.addEventListener('defense', () => void refreshEnclave());
    es.addEventListener('hitl', () => void refreshEnclave());
    return () => es.close();
  }, [refreshMessages, refreshEnclave]);

  // Honest fallback — while the stream is down, the thread polls every 5s.
  useEffect(() => {
    if (streamLive) return;
    const t = setInterval(() => refreshMessages().catch(() => undefined), 5_000);
    return () => clearInterval(t);
  }, [streamLive, refreshMessages]);

  // Keep the thread pinned to the latest message.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.length]);

  // Task 20 — deep links: #money / #defenses / #guarantee / #account open the matching panel.
  useEffect(() => {
    const h = window.location.hash.replace('#', '');
    if ((PANEL_KEYS as string[]).includes(h)) setOpenPanel(h as PanelKey);
  }, []);

  // Keep the URL honest with the open panel, and bring it into view.
  useEffect(() => {
    const url = openPanel ? `#${openPanel}` : `${window.location.pathname}${window.location.search}`;
    window.history.replaceState(null, '', url);
    if (openPanel) {
      const t = setTimeout(() => panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 60);
      return () => clearTimeout(t);
    }
  }, [openPanel]);

  const togglePanel = (key: PanelKey) => setOpenPanel((prev) => (prev === key ? null : key));

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setDraft('');
    try {
      // Identity comes from the session server-side — only text travels.
      await fetchJson('/portal/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      await refreshMessages();
    } catch {
      /* next poll reconciles */
    } finally {
      setSending(false);
    }
  };

  const onUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    setShelfNote(null);
    try {
      const form = new FormData();
      Array.from(files).forEach((f) => form.append('files', f));
      const res = await fetch('/portal/api/ingest', { method: 'POST', body: form });
      const data = (await res.json().catch(() => null)) as
        | { filesQueued?: number; hitlCount?: number; perFileSummary?: { lines: number }[]; detail?: string; error?: string }
        | null;
      if (res.status === 402) {
        setShelfNote({ ok: false, text: data?.detail ?? 'File ingest requires an active deposit — ask your operator.' });
      } else if (res.status === 429) {
        setShelfNote({ ok: false, text: 'Too many uploads this hour — try again a little later.' });
      } else if (!res.ok) {
        setShelfNote({ ok: false, text: data?.detail ?? data?.error ?? 'Upload did not land — try again.' });
      } else {
        const lines = (data?.perFileSummary ?? []).reduce((a, x) => a + x.lines, 0);
        const hitl = data?.hitlCount ?? 0;
        setShelfNote({
          ok: true,
          text: `${data?.filesQueued ?? 0} file${data?.filesQueued === 1 ? '' : 's'} on the shelf — ${lines} lines parsed${hitl ? `, ${hitl} flagged for your team to review` : ''}.`,
        });
        await refreshEnclave();
      }
    } catch {
      setShelfNote({ ok: false, text: 'Network error — the upload did not land.' });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const download = async (d: TenantDocumentView) => {
    setDownloadingId(d.id);
    setShelfNote(null);
    try {
      const res = await fetch(`/portal/api/documents/${d.id}`, { cache: 'no-store' });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { detail?: string } | null;
        setShelfNote({ ok: false, text: data?.detail ?? `Could not retrieve ${d.fileName}.` });
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = d.fileName;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setShelfNote({ ok: false, text: `Network error — ${d.fileName} did not download.` });
    } finally {
      setDownloadingId(null);
    }
  };

  const copyJoin = async (callId: string, url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedCallId(callId);
      setTimeout(() => setCopiedCallId((c) => (c === callId ? null : c)), 2200);
    } catch {
      /* clipboard unavailable — the Join link remains visible */
    }
  };

  const signOut = async () => {
    await fetch('/portal/api/logout', { method: 'POST' }).catch(() => undefined);
    router.push('/portal/login');
    router.refresh();
  };

  const tenant = enclave?.tenant;
  const thread = messages;
  const documents = enclave?.documents ?? [];
  const recon = enclave?.reconciliation ?? null;

  // Task 20 — the one provenance sentence every panel closes with.
  const provenance = recon
    ? `Computed from the same ledger your team reconciles — ${recon.checks ?? '—'} checks · ${recon.drift ?? '—'} drift · stamped ${stampWhen(recon.stampedAt)}`
    : 'Computed straight off the ledger — the self-audit has not stamped yet.';

  return (
    <div className="flex min-h-screen flex-col bg-paper text-ink selection:bg-blush selection:text-sienna">
      {/* ── Masthead ───────────────────────────────────────────────── */}
      <header className="sticky top-0 z-50 border-b border-hairline bg-paper/85 backdrop-blur-md">
        <div className="mx-auto flex h-16 w-full max-w-[1120px] items-center justify-between px-5 sm:px-8 lg:px-10">
          <div className="flex min-w-0 items-center gap-4">
            <Link href="/portal" className="shrink-0 font-display text-[21px] leading-none tracking-[-0.01em] text-ink">
              enclave
            </Link>
            <span className="hidden text-[13px] text-smoke sm:inline">Layer 03 · client boundary</span>
            <span className="hidden items-center gap-2 rounded-full border border-hairline px-3 py-1.5 text-[12px] text-steel md:inline-flex">
              <LiveDot />
              {streamLive ? 'Enclave live · streamed' : 'Enclave live · polling'}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <span className="hidden text-[13px] text-steel sm:inline">
              Signed in as <span className="font-medium text-ink">{contactName}</span>
              {tenant ? ` · ${tenant.name}` : ''}
            </span>
            <button
              onClick={signOut}
              className="inline-flex items-center gap-1.5 rounded-full border border-hairline px-3 py-1.5 text-[12.5px] font-medium text-steel transition-colors hover:bg-mist hover:text-ink"
            >
              <LogOut className="h-3.5 w-3.5" strokeWidth={1.75} />
              Sign out
            </button>
          </div>
        </div>
      </header>

      {/* ── Body ───────────────────────────────────────────────────── */}
      <main className="mx-auto w-full max-w-[1120px] flex-1 px-5 py-10 sm:px-8 lg:px-10">
        <ViewHeader
          tag={`Executive enclave · ${tenant?.erp ?? '—'}`}
          title="Your margin,"
          accent="defended."
          rest=""
          sub={
            tenant
              ? `${tenant.name} — ${tenant.status.toLowerCase()}. Every intercepted dollar below is computed from the same ledger your Syntropic team reports against.`
              : 'Loading your enclave…'
          }
        />

        {loadError && (
          <div className="mb-6 rounded-2xl border border-hairline bg-mist p-4 text-[14px] text-steel">
            Enclave feed unreachable — retrying automatically. If this persists, contact your Syntropic owner ({tenant?.owner ?? 'team'}).
          </div>
        )}

        {/* ── Reconciliation strip ───────────────────────────────────── */}
        <section className={`${ARTIFACT} mt-6 flex flex-wrap items-center gap-x-6 gap-y-3 px-6 py-4`} aria-label="Reconciliation stamp">
          <div className="flex items-center gap-2.5">
            {recon && !recon.ok ? (
              <AlertTriangle className="h-4 w-4 shrink-0 text-sienna" strokeWidth={1.75} />
            ) : (
              <ShieldCheck className={`h-4 w-4 shrink-0 ${recon?.ok ? 'text-sienna' : 'text-smoke'}`} strokeWidth={1.75} />
            )}
            <div>
              <div className="text-[14px] font-medium text-ink">Reconciled ledger</div>
              <div className="text-[12px] text-steel">The same self-audit your team runs — printed on your numbers.</div>
            </div>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {recon ? (
              <>
                {recon.checks != null && (
                  <span className="inline-flex items-center rounded-full border border-hairline px-3 py-1 text-[12px] font-medium text-ink tabular-nums">
                    {recon.checks} independent checks
                  </span>
                )}
                {recon.drift != null && (
                  <span
                    className={`inline-flex items-center rounded-full px-3 py-1 text-[12px] font-medium tabular-nums ${
                      recon.ok ? 'bg-blush text-sienna' : 'border border-hairline text-steel'
                    }`}
                  >
                    {recon.drift} drift
                  </span>
                )}
                <span className="inline-flex items-center gap-1.5 text-[12px] text-steel">
                  <LiveDot />
                  stamped {stampWhen(recon.stampedAt)}
                </span>
                {!recon.ok && <span className="w-full text-[12px] leading-relaxed text-sienna">{recon.detail}</span>}
              </>
            ) : (
              <span className="text-[12.5px] text-smoke">
                Self-audit has not stamped yet — every figure on this page still comes straight off the ledger.
              </span>
            )}
          </div>
        </section>

        {/* ── Enclave stats ──────────────────────────────────────────── */}
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <button
            onClick={() => togglePanel('money')}
            aria-expanded={openPanel === 'money'}
            aria-controls="enclave-panel"
            className={`${ARTIFACT} cursor-pointer bg-blush p-5 text-left transition-shadow ${
              openPanel === 'money' ? 'ring-1 ring-sienna/40' : 'hover:shadow-[0_2px_12px_rgba(93,42,26,0.08)]'
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="text-[13px] text-sienna/80">Margin recovered</div>
              <ChevronDown
                className={`h-3.5 w-3.5 shrink-0 text-sienna/60 transition-transform ${openPanel === 'money' ? 'rotate-180' : ''}`}
                strokeWidth={1.75}
              />
            </div>
            <div className="mt-2 font-display text-[30px] leading-none tracking-[-0.01em] text-sienna tabular-nums">
              {enclave ? fmtUsd(enclave.marginDefendedCents) : '—'}
            </div>
            <div className="mt-2 text-[12px] text-sienna/70">
              {enclave && enclave.last24hDeltaCents > 0 ? (
                <span className="inline-flex items-center gap-1 font-medium tabular-nums">
                  <TrendingUp className="h-3 w-3" strokeWidth={2} />+{fmtUsd(enclave.last24hDeltaCents, true)} in the last 24h
                </span>
              ) : (
                'Lifetime, this enclave'
              )}
            </div>
          </button>
          <button
            onClick={() => togglePanel('defenses')}
            aria-expanded={openPanel === 'defenses'}
            aria-controls="enclave-panel"
            className={`${ARTIFACT} cursor-pointer p-5 text-left transition-shadow ${
              openPanel === 'defenses' ? 'ring-1 ring-sienna/40' : 'hover:shadow-[0_2px_12px_rgba(93,42,26,0.08)]'
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="text-[13px] text-steel">Defenses logged</div>
              <ChevronDown
                className={`h-3.5 w-3.5 shrink-0 text-smoke transition-transform ${openPanel === 'defenses' ? 'rotate-180' : ''}`}
                strokeWidth={1.75}
              />
            </div>
            <div className="mt-2 font-display text-[30px] leading-none tracking-[-0.01em] text-ink tabular-nums">
              {enclave ? enclave.defensesLogged : '—'}
            </div>
            <div className="mt-2 text-[12px] text-smoke">Approved line-item defenses</div>
          </button>
          <button
            onClick={() => togglePanel('guarantee')}
            aria-expanded={openPanel === 'guarantee'}
            aria-controls="enclave-panel"
            className={`${ARTIFACT} cursor-pointer p-5 text-left transition-shadow ${
              openPanel === 'guarantee' ? 'ring-1 ring-sienna/40' : 'hover:shadow-[0_2px_12px_rgba(93,42,26,0.08)]'
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="text-[13px] text-steel">Guarantee status</div>
              <ChevronDown
                className={`h-3.5 w-3.5 shrink-0 text-smoke transition-transform ${openPanel === 'guarantee' ? 'rotate-180' : ''}`}
                strokeWidth={1.75}
              />
            </div>
            <div className="mt-2 text-[15px] font-medium leading-snug text-ink">{tenant?.guaranteeLabel ?? '—'}</div>
            <div className="mt-2 inline-flex items-center gap-1.5 text-[12px] text-steel">
              <ShieldCheck className={`h-3.5 w-3.5 ${tenant?.guaranteePassed ? 'text-sienna' : 'text-smoke'}`} strokeWidth={1.75} />
              {tenant?.guaranteePassed ? 'Baseline passed' : 'Diagnostic pending'}
            </div>
          </button>
          <button
            onClick={() => togglePanel('account')}
            aria-expanded={openPanel === 'account'}
            aria-controls="enclave-panel"
            className={`${ARTIFACT} cursor-pointer p-5 text-left transition-shadow ${
              openPanel === 'account' ? 'ring-1 ring-sienna/40' : 'hover:shadow-[0_2px_12px_rgba(93,42,26,0.08)]'
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="text-[13px] text-steel">Deposit / fee</div>
              <ChevronDown
                className={`h-3.5 w-3.5 shrink-0 text-smoke transition-transform ${openPanel === 'account' ? 'rotate-180' : ''}`}
                strokeWidth={1.75}
              />
            </div>
            <div className="mt-2 text-[15px] font-medium leading-snug text-ink">{tenant?.depositLabel ?? '—'}</div>
            <div className="mt-2 text-[12px] text-smoke">{tenant ? (STAGE_LABEL[tenant.billingStage] ?? tenant.stage) : ''}</div>
          </button>
        </div>

        {/* ── The tile panel — one at a time, deep-linkable, provenance-stamped ── */}
        <div ref={panelRef} className="scroll-mt-24">
          {openPanel && enclave && (
            <section
              id="enclave-panel"
              key={openPanel}
              className={`${ARTIFACT} panel-in mt-4 p-6`}
              aria-label={`${PANEL_META[openPanel].label} panel`}
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-[12.5px] font-medium uppercase tracking-wide text-smoke">{PANEL_META[openPanel].label}</div>
                  <h2 className="mt-0.5 font-display text-[22px] leading-tight text-ink">{PANEL_META[openPanel].title}</h2>
                </div>
                <button
                  onClick={() => setOpenPanel(null)}
                  aria-label="Close panel"
                  className="grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-full border border-hairline text-steel transition-colors hover:bg-mist hover:text-ink"
                >
                  <X className="h-4 w-4" strokeWidth={1.75} />
                </button>
              </div>

              {openPanel === 'money' && <MoneyBody enclave={enclave} />}
              {openPanel === 'defenses' && (
                <DefensesBody
                  enclave={enclave}
                  expandedId={expandedId}
                  onToggle={(id) => setExpandedId((prev) => (prev === id ? null : id))}
                />
              )}
              {openPanel === 'guarantee' && <GuaranteeBody enclave={enclave} />}
              {openPanel === 'account' && <AccountBody enclave={enclave} />}

              <footer className="mt-5 flex items-center gap-2 border-t border-hairline pt-3 text-[12px] leading-relaxed text-steel">
                <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-sienna" strokeWidth={1.75} />
                <span>{provenance}</span>
              </footer>
            </section>
          )}
        </div>

        {/* ── Feed + direct line ─────────────────────────────────────── */}
        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-12">
          {/* Live intercept feed + money trail */}
          <div className="space-y-6 lg:col-span-7">
            <section className={`${ARTIFACT} p-6`} aria-label="Live enclave feed">
              <div className="flex items-center justify-between">
                <h2 className="font-display text-[22px] leading-tight text-ink">Live intercept feed</h2>
                <span className="inline-flex items-center gap-2 text-[12px] text-steel">
                  <LiveDot />
                  {streamLive ? 'Pushed as they land' : 'Auto-sync · fallback poll'}
                </span>
              </div>
              <p className="mt-1 text-[13px] text-steel">
                RFQs defended on your behalf — tap a row for its receipt.
              </p>

              <div className="mt-4 divide-y divide-hairline">
                {enclave && enclave.intercepts.length > 0 ? (
                  enclave.intercepts.map((e) => (
                    <InterceptRow
                      key={e.id}
                      e={e}
                      open={expandedId === e.id}
                      onToggle={() => setExpandedId(expandedId === e.id ? null : e.id)}
                    />
                  ))
                ) : (
                  <div className="py-8 text-center text-[14px] text-steel">
                    No defenses logged yet — your first intercepted RFQs will land here.
                  </div>
                )}
              </div>
            </section>

            {/* Money trail — recentLedger finally rendered (was a dead payload) */}
            <section className={`${ARTIFACT} p-6`} aria-label="Your money trail">
              <div className="flex items-center justify-between">
                <h2 className="font-display text-[22px] leading-tight text-ink">Your money trail</h2>
                <span className="text-[12px] text-steel">Newest first</span>
              </div>
              <p className="mt-1 text-[13px] text-steel">
                The exact ledger rows behind every figure on this page — receipts, not claims.
              </p>
              <div className="mt-4 divide-y divide-hairline">
                {enclave && enclave.recentLedger.length > 0 ? (
                  enclave.recentLedger.map((l) => (
                    <div key={l.id} className="flex items-center justify-between gap-4 py-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span
                            className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                              l.kind === 'MARGIN_DEFENDED' ? 'bg-blush text-sienna' : 'border border-hairline text-steel'
                            }`}
                          >
                            {KIND_LABEL[l.kind] ?? l.kind}
                          </span>
                          <span className="truncate text-[13.5px] text-ink">{l.note ?? '—'}</span>
                        </div>
                        <div className="mt-0.5 text-[12px] text-smoke tabular-nums">
                          {dayLabel(l.createdAt)} · {when(l.createdAt)}
                        </div>
                      </div>
                      <div
                        className={`shrink-0 text-[14px] font-medium tabular-nums ${
                          l.kind === 'MARGIN_DEFENDED' ? 'text-sienna' : 'text-ink'
                        }`}
                      >
                        {l.kind === 'MARGIN_DEFENDED' ? '+' : ''}
                        {fmtUsd(l.amountCents, true)}
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="py-6 text-center text-[13.5px] text-steel">
                    No ledger rows yet — your first settled entries will print here.
                  </div>
                )}
              </div>
            </section>
          </div>

          {/* Direct line + calls + documents */}
          <div className="space-y-6 lg:col-span-5">
            {/* Direct line */}
            <section className={`${ARTIFACT} flex flex-col p-6`} aria-label="Direct line">
              <div className="flex items-center justify-between">
                <h2 className="inline-flex items-center gap-2 font-display text-[22px] leading-tight text-ink">
                  <MessageSquare className="h-4 w-4 text-sienna" strokeWidth={1.75} />
                  Direct line
                </h2>
                <span className="inline-flex items-center gap-2 text-[12px] text-steel">
                  <LiveDot />
                  {streamLive ? 'Streams to your team' : 'Reconnecting…'}
                </span>
              </div>
              <p className="mt-1 text-[13px] text-steel">
                Owner: {tenant?.owner ?? '—'} · replies within the 90-second response SLA.
              </p>

              <div
                ref={scrollRef}
                className="scroll-slim mt-4 h-64 space-y-2.5 overflow-y-auto rounded-2xl bg-fog p-4"
              >
                {thread.length === 0 && (
                  <div className="grid h-full place-items-center text-center text-[13px] text-smoke">
                    Say hello — your team sees this instantly.
                  </div>
                )}
                {thread.map((m) => {
                  // Task 23 — the server stamps direction at write time; the
                  // bubble side is fact, not a sender-string guess.
                  const own = m.direction === 'client';
                  return (
                    <div key={m.id} className={own ? 'flex justify-end' : 'flex justify-start'}>
                      <div
                        className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-[13.5px] leading-relaxed ${
                          own ? 'bg-ink text-paper' : 'border border-hairline bg-paper text-ink'
                        }`}
                      >
                        {!own && <div className="mb-0.5 text-[11.5px] font-medium text-steel">{m.sender}</div>}
                        {m.text}
                        <div className={`mt-1 text-[10.5px] tabular-nums ${own ? 'text-paper/60' : 'text-smoke'}`}>
                          {own ? (m.readAt ? `Seen ${when(m.readAt)}` : `Sent ${when(m.createdAt)}`) : when(m.createdAt)}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              <form
                className="mt-3 flex items-center gap-2"
                onSubmit={(ev) => {
                  ev.preventDefault();
                  send();
                }}
              >
                <input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder={`Message ${tenant?.name ?? 'your team'}…`}
                  aria-label="Message your Syntropic team"
                  className="h-10 flex-1 rounded-full border border-hairline bg-paper px-4 text-[14px] text-ink outline-none transition-shadow placeholder:text-smoke focus-visible:shadow-[0_0_0_2px_rgba(93,42,26,0.25)]"
                />
                <button
                  type="submit"
                  disabled={sending || !draft.trim()}
                  aria-label="Send message"
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-ink text-paper transition-colors hover:bg-[#33363b] disabled:opacity-50"
                >
                  {sending ? (
                    <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} />
                  ) : (
                    <Send className="h-4 w-4" strokeWidth={1.75} />
                  )}
                </button>
              </form>
            </section>

            {/* Upcoming calls — genuinely upcoming, with the join line */}
            <section className="space-y-3 rounded-[24px] bg-mist p-5" aria-label="Upcoming calls">
              <div className="px-1 pb-1 text-[13px] font-medium text-steel">Upcoming executive calls</div>
              {enclave && enclave.calls.length > 0 ? (
                enclave.calls.map((c) => (
                  <div key={c.id} className="space-y-2.5 rounded-2xl bg-paper p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="text-[14px] font-medium text-ink">{c.type}</div>
                      <span className="shrink-0 rounded-full bg-blush px-2.5 py-1 text-[11.5px] font-medium text-sienna">
                        {c.status === 'LIVE' ? 'Live now' : c.status.toLowerCase()}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 text-[13px] font-medium text-ink">
                      <Clock className="h-3.5 w-3.5 text-steel" strokeWidth={1.75} />
                      <span className="tabular-nums">
                        {dayLabel(c.scheduledAt)} ·{' '}
                        {when(c.scheduledAt)}
                        {c.endsAt ? `–${when(c.endsAt)}` : ''}
                      </span>
                    </div>
                    {c.hostName && <div className="text-[12px] text-steel">Hosted by {c.hostName}</div>}
                    {c.joinUrl ? (
                      <div className="flex flex-wrap items-center gap-2 pt-0.5">
                        <a
                          href={c.joinUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1.5 rounded-full bg-ink px-3.5 py-2 text-[12.5px] font-medium text-paper transition-colors hover:bg-[#33363b]"
                        >
                          Join {PROVIDER_LABEL[c.provider ?? ''] ?? 'call'}
                          <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.75} />
                        </a>
                        <button
                          onClick={() => copyJoin(c.id, c.joinUrl!)}
                          className="inline-flex items-center gap-1.5 rounded-full border border-hairline px-3 py-2 text-[12.5px] font-medium text-steel transition-colors hover:bg-mist hover:text-ink"
                        >
                          {copiedCallId === c.id ? (
                            <Check className="h-3.5 w-3.5" strokeWidth={1.75} />
                          ) : (
                            <Copy className="h-3.5 w-3.5" strokeWidth={1.75} />
                          )}
                          {copiedCallId === c.id ? 'Copied' : 'Copy link'}
                        </button>
                      </div>
                    ) : (
                      <div className="text-[12px] text-smoke">Your owner attaches the line before the call.</div>
                    )}
                  </div>
                ))
              ) : (
                <div className="rounded-2xl bg-paper p-4 text-[13px] text-steel">
                  No calls scheduled — your owner will book the next briefing here.
                </div>
              )}
            </section>

            {/* Document shelf — what landed, what parsed, download the original */}
            <section className="space-y-3 rounded-[24px] bg-mist p-5" aria-label="Your documents">
              <div className="flex items-center justify-between px-1 pb-1">
                <div className="text-[13px] font-medium text-steel">Your documents</div>
                <span className="text-[12px] text-steel tabular-nums">{documents.length} on file</span>
              </div>

              {documents.length > 0 ? (
                <div className="space-y-2.5">
                  {documents.map((d) => (
                    <div key={d.id} className="space-y-1.5 rounded-2xl bg-paper p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-2">
                          <FileText className="h-4 w-4 shrink-0 text-steel" strokeWidth={1.75} />
                          <span className="truncate text-[13.5px] font-medium text-ink">{d.fileName}</span>
                        </div>
                        <button
                          onClick={() => download(d)}
                          disabled={downloadingId === d.id}
                          className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-hairline px-3 py-1.5 text-[12px] font-medium text-steel transition-colors hover:bg-mist hover:text-ink disabled:opacity-50"
                        >
                          {downloadingId === d.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
                          ) : (
                            <Download className="h-3.5 w-3.5" strokeWidth={1.75} />
                          )}
                          Download
                        </button>
                      </div>
                      <div className="text-[12px] text-steel tabular-nums">
                        {dayLabel(d.createdAt)} · {sizeLabel(d.sizeBytes)}
                        {d.linesParsed != null ? ` · ${d.linesParsed} lines parsed` : ''}
                        {d.hitlCount > 0 ? ` · ${d.hitlCount} flagged` : ''}
                      </div>
                      {d.hitlCount > 0 && (
                        <div className="text-[11.5px] leading-relaxed text-sienna">
                          {d.hitlRefs.join(' · ')} — low-confidence lines under verification by your team
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-2xl bg-paper p-4 text-[13px] text-steel">
                  Nothing on file yet — upload a quote and it lands here with its parse summary.
                </div>
              )}

              <label
                className={`flex cursor-pointer items-center justify-center gap-2 rounded-2xl border border-dashed px-4 py-4 text-[13px] font-medium transition-colors ${
                  uploading ? 'border-hairline text-smoke' : 'border-steel/40 text-steel hover:border-sienna/50 hover:text-ink'
                }`}
              >
                <input
                  ref={fileRef}
                  type="file"
                  multiple
                  accept=".pdf,.xlsx,.csv"
                  className="hidden"
                  disabled={uploading}
                  onChange={(e) => void onUpload(e.target.files)}
                />
                {uploading ? (
                  <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} />
                ) : (
                  <Upload className="h-4 w-4" strokeWidth={1.75} />
                )}
                {uploading ? 'Parsing…' : 'Upload a quote file'}
                <span className="text-[11.5px] font-normal text-smoke">PDF · XLSX · CSV, under 50 MB</span>
              </label>

              {shelfNote && (
                <p className={`px-1 text-[12.5px] leading-relaxed ${shelfNote.ok ? 'text-sienna' : 'text-steel'}`}>
                  {shelfNote.text}
                </p>
              )}
            </section>
          </div>
        </div>

        {/* ── Footer meta ────────────────────────────────────────────── */}
        <footer className="mt-10 flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-6 text-[12px] text-smoke">
          <span>
            Enclave boundary isolated · session bound to {tenantName} · ledger synced {enclave ? when(enclave.computedAt) : '—'}
          </span>
          <span>Syntropic Backbone · Layer 03 portal</span>
        </footer>
      </main>
    </div>
  );
}
