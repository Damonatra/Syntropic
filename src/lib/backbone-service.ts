import { db } from '@/lib/db';
import { ensureDb } from '@/lib/ensure-db';
import { sendTelegramAlert, type InlineButton } from '@/lib/telegram';
import { emit } from '@/lib/bus';
import { logCommand } from '@/lib/command-log';
import { randomToken, hashToken } from '@/lib/operator-auth';
import type { HitlItem, InterceptEvent } from '@prisma/client';
import type { DispatchResult, HitlAction, HitlView, InterceptView } from '@/lib/types';

/**
 * Backbone domain service (R-03 / R-04 / R-05).
 * Deterministic rules:
 *  - OCR confidence < 95 → HITL queue + Telegram push with inline approvals.
 *  - extractedMarginLoss > $2,500 → high-value intercept alert.
 *  - Draft injection to LOCKED/MISSING mailbox → DispatchFailure HITL item,
 *    owner-routed for manual resolution by Damon or Josias.
 */

export const CONFIDENCE_THRESHOLD = 95;
export const HIGH_VALUE_THRESHOLD_CENTS = 250_000; // $2,500.00

const usd = (cents: number) =>
  `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function toHitlView(i: HitlItem): HitlView {
  return {
    id: i.id,
    ref: i.ref,
    kind: i.kind as HitlView['kind'],
    tenantName: i.tenantName,
    pdfName: i.pdfName,
    skuParsed: i.skuParsed,
    confidenceScore: i.confidenceScore,
    extractedMarginLossCents: i.extractedMarginLossCents,
    failureReason: i.failureReason as HitlView['failureReason'],
    owner: i.owner,
    status: i.status as HitlView['status'],
    createdAt: i.createdAt.toISOString(),
    updatedAt: i.updatedAt.toISOString(),
  };
}

export function toInterceptView(e: InterceptEvent): InterceptView {
  return {
    id: e.id,
    tenantName: e.tenantName,
    item: e.item,
    origCents: e.origCents,
    defendedCents: e.defendedCents,
    diffCents: e.diffCents,
    channel: e.channel,
    source: e.source,
    createdAt: e.createdAt.toISOString(),
  };
}

async function nextHitlRef(): Promise<string> {
  const items = await db.hitlItem.findMany({ select: { ref: true } });
  const max = items.reduce((m, i) => Math.max(m, Number(i.ref.split('-')[1]) || 0), 8092);
  return `HITL-${max + 1}`;
}

/* ── One-time Telegram action tokens ─────────────────────────── */

const TELEGRAM_ACTION_CODES: Record<HitlAction, string> = { APPROVE: 'A', OVERRIDE: 'O', RETRY: 'R', RESOLVE: 'X', NOTIFY: 'N' };
export const TELEGRAM_CODE_TO_ACTION: Record<string, HitlAction> = { A: 'APPROVE', O: 'OVERRIDE', R: 'RETRY', X: 'RESOLVE', N: 'NOTIFY' };
const TELEGRAM_ACTION_TTL_MS = 15 * 60e3;

/** Mints single-use 15-minute tokens for each action and returns the inline
 *  keyboard. The callback carries `h:<code>:<raw-token>` — never the item
 *  id or ref — so the button dies with the token and nothing actionable is
 *  enumerable in the chat history. */
async function oneShotKeyboard(itemId: string, actions: { label: string; action: HitlAction }[]): Promise<InlineButton[][]> {
  const buttons = await Promise.all(
    actions.map(async ({ label, action }) => {
      const raw = randomToken(16);
      await db.magicLinkToken.create({
        data: {
          email: `telegram:${itemId}`,
          tokenHash: await hashToken(raw),
          scope: 'telegram',
          targetId: itemId,
          action,
          expiresAt: new Date(Date.now() + TELEGRAM_ACTION_TTL_MS),
        },
      });
      return { text: label, callback_data: `h:${TELEGRAM_ACTION_CODES[action]}:${raw}` };
    }),
  );
  return [buttons];
}

/** Owner chat resolution: prefer the tenant's owning founder's Telegram
 *  chat id (env-seeded), falling back to the ops room. */
async function ownerChatId(tenantName: string): Promise<string | null> {
  const tenant = await db.tenant.findUnique({ where: { name: tenantName } });
  if (!tenant) return null;
  const first = tenant.owner.split('/')[0]?.trim();
  const member = await db.teamMember.findFirst({
    where: { OR: [{ name: first }, { name: tenant.owner }] },
    orderBy: { sortOrder: 'asc' },
  });
  return member?.telegramChatId ?? null;
}

/* ── OCR ingestion → HITL + Telegram (R-05) ──────────────────── */

export async function createOcrHitl(input: {
  tenantName: string;
  pdfName?: string;
  skuParsed: string;
  confidenceScore: number;
  extractedMarginLossCents: number;
  scenario?: number;
}): Promise<{ item: HitlView; alertDelivery: string }> {
  await ensureDb();
  const ref = await nextHitlRef();
  const created = await db.hitlItem.create({
    data: {
      ref,
      kind: 'OCR_LOW_CONFIDENCE',
      tenantName: input.tenantName,
      pdfName: input.pdfName ?? 'Automated RFQ parse',
      skuParsed: input.skuParsed,
      confidenceScore: input.confidenceScore,
      extractedMarginLossCents: input.extractedMarginLossCents,
      status: 'PENDING',
      scenario: input.scenario,
    },
  });

  const text =
    `OCR low-confidence · ${ref}\n` +
    `Tenant: ${input.tenantName}\n` +
    `SKU: ${input.skuParsed}\n` +
    `Confidence: ${input.confidenceScore}% (<${CONFIDENCE_THRESHOLD})\n` +
    `Margin loss: ${usd(input.extractedMarginLossCents)}\n` +
    `→ Awaiting HITL approval`;
  const alertDelivery = await sendTelegramAlert(
    text,
    await oneShotKeyboard(created.id, [
      { label: '✅ Approve', action: 'APPROVE' },
      { label: '✏️ Override', action: 'OVERRIDE' },
    ]),
    await ownerChatId(input.tenantName),
  );

  emit({ type: 'hitl', tenantName: input.tenantName, fileName: input.pdfName ?? 'Automated RFQ parse', ref, count: 1 });

  return { item: toHitlView(created), alertDelivery };
}

/* ── Dispatch failure rerouting (R-03) ───────────────────────── */

export async function createDispatchFailure(
  tenantName: string,
  reason: 'MAILBOX_LOCKED' | 'MAILBOX_NOT_FOUND',
  note?: string,
): Promise<{ item: HitlView; alertDelivery: string }> {
  await ensureDb();
  const tenant = await db.tenant.findUnique({ where: { name: tenantName } });
  const ref = await nextHitlRef();
  const created = await db.hitlItem.create({
    data: {
      ref,
      kind: 'DISPATCH_FAILURE',
      tenantName,
      pdfName: 'Automated draft injection',
      skuParsed: note ?? `Draft → ${tenantName} mailbox`,
      extractedMarginLossCents: 0,
      failureReason: reason,
      owner: tenant?.owner ?? 'Damon / Josias',
      status: 'PENDING',
    },
  });

  const text =
    `Dispatch failure · ${ref}\n` +
    `Tenant: ${tenantName}\n` +
    `Reason: ${reason}\n` +
    `Draft injection blocked — rerouted to Backbone HITL for manual resolution\n` +
    `Owner: ${tenant?.owner ?? 'Damon / Josias'}`;
  const alertDelivery = await sendTelegramAlert(
    text,
    await oneShotKeyboard(created.id, [
      { label: '🔁 Retry dispatch', action: 'RETRY' },
      { label: '🛠 Resolve', action: 'RESOLVE' },
    ]),
    await ownerChatId(tenantName),
  );

  emit({ type: 'notification', kind: 'dispatch_failure', text: `${ref} · ${tenantName} — ${reason === 'MAILBOX_LOCKED' ? 'mailbox locked' : 'mailbox not found'} — owner ${tenant?.owner ?? 'Damon / Josias'}` });

  return { item: toHitlView(created), alertDelivery };
}

/* ── HITL actions ────────────────────────────────────────────── */

export async function applyHitlAction(
  ref: string,
  action: HitlAction,
  actor = 'Telegram operator',
  correction?: { sku?: string },
): Promise<{ ok: boolean; item?: HitlView; dispatch?: DispatchResult; alertDelivery?: string; error?: string }> {
  await ensureDb();
  const item = await db.hitlItem.findUnique({ where: { ref } });
  if (!item) return { ok: false, error: `Unknown HITL ref ${ref}` };

  if (action === 'APPROVE') {
    if (item.status !== 'PENDING') return { ok: false, error: `${ref} is ${item.status}` };
    await db.hitlItem.update({ where: { ref }, data: { status: 'APPROVED' } });

    // Draft dispatch step — mailbox gate (R-03).
    const tenant = await db.tenant.findUnique({ where: { name: item.tenantName } });
    if (tenant && tenant.mailboxStatus !== 'ACTIVE') {
      const reason = tenant.mailboxStatus === 'LOCKED' ? 'MAILBOX_LOCKED' : 'MAILBOX_NOT_FOUND';
      const failure = await createDispatchFailure(
        tenant.name,
        reason,
        tenant.mailboxNote ?? `Draft → ${tenant.name} mailbox`,
      );
      await logCommand({ actor, action: 'HITL_ACTION', target: ref, detail: `approved ${item.tenantName} — dispatch blocked (${reason.toLowerCase().replace(/_/g, ' ')}) → rerouted as ${failure.item.ref}` });
      return {
        ok: true,
        item: toHitlView(await db.hitlItem.findUniqueOrThrow({ where: { ref } })),
        dispatch: { status: 'FAILED', reason, failureRef: failure.item.ref, alertDelivery: failure.alertDelivery },
      };
    }

    // Successful dispatch → margin defended lands on the ledger (R-01/R-02).
    if (item.extractedMarginLossCents > 0) {
      await db.ledgerEntry.create({
        data: {
          tenantName: item.tenantName,
          kind: 'MARGIN_DEFENDED',
          amountCents: item.extractedMarginLossCents,
          note: `${ref} approved — ${item.skuParsed ?? 'SKU'} attached to portal`,
        },
      });
      await db.interceptEvent.create({
        data: {
          tenantName: item.tenantName,
          item: `${ref} verified · ${item.skuParsed ?? 'SKU'}`,
          origCents: 0,
          defendedCents: item.extractedMarginLossCents,
          diffCents: item.extractedMarginLossCents,
          source: 'HITL_APPROVAL',
        },
      });
      emit({ type: 'defense', tenantName: item.tenantName, amountCents: item.extractedMarginLossCents, totalDefendedCents: 0 });
      emit({ type: 'notification', kind: 'hitl', text: `${ref} approved & dispatched — ${usd(item.extractedMarginLossCents)} attached to ${item.tenantName} portal` });
    } else {
      emit({ type: 'notification', kind: 'hitl', text: `${ref} approved & dispatched — ${item.tenantName}` });
    }
    await logCommand({
      actor,
      action: 'HITL_ACTION',
      target: ref,
      detail: item.extractedMarginLossCents > 0
        ? `approved ${item.tenantName} — ${usd(item.extractedMarginLossCents)} margin defended & attached to the portal ledger`
        : `approved ${item.tenantName} — draft dispatched to the portal`,
    });
    return { ok: true, item: toHitlView(await db.hitlItem.findUniqueOrThrow({ where: { ref } })), dispatch: { status: 'DISPATCHED' } };
  }

  if (action === 'OVERRIDE') {
    if (item.status !== 'PENDING') return { ok: false, error: `${ref} is ${item.status}` };
    // Task 22 — the override captures the operator's reading, not just a
    // verdict: a non-empty correction replaces the stored SKU so the queue,
    // the client feed, and every downstream receipt carry the corrected part
    // description. The Ship's Log keeps the before → after verbatim.
    const correctedSku = correction?.sku?.trim() ?? '';
    const changed = correctedSku.length > 0 && correctedSku !== item.skuParsed;
    const updated = await db.hitlItem.update({
      where: { ref },
      data: changed ? { status: 'OVERRIDDEN', skuParsed: correctedSku } : { status: 'OVERRIDDEN' },
    });
    emit({ type: 'notification', kind: 'hitl', text: `${ref} overridden — ${item.tenantName} · manual SKU review retained` });
    await logCommand({
      actor,
      action: 'HITL_ACTION',
      target: ref,
      detail: changed
        ? `overrode ${item.tenantName} — SKU corrected "${item.skuParsed ?? '—'}" → "${correctedSku}"; operator reading replaces the low-confidence parse`
        : `overrode ${item.tenantName} — manual SKU review retained, low-confidence parse set aside`,
    });
    return { ok: true, item: toHitlView(updated) };
  }

  if (action === 'NOTIFY') {
    // Task 22 — the nudge: re-send the owner the same one-shot action card.
    // Idempotent by nature (nothing mutates but the log) and honest about
    // delivery — the toast and the log both carry the real DeliveryStatus.
    if (item.status !== 'PENDING') return { ok: false, error: `${ref} is ${item.status} — nothing left to re-notify` };
    const isFailure = item.kind === 'DISPATCH_FAILURE';
    const text = isFailure
      ? `Dispatch failure · ${ref}\n` +
        `Tenant: ${item.tenantName}\n` +
        `Reason: ${item.failureReason ?? 'MAILBOX_LOCKED'}\n` +
        `Draft injection blocked — rerouted to Backbone HITL for manual resolution\n` +
        `Owner: ${item.owner ?? 'Damon / Josias'}\n` +
        `→ Re-notification — item waiting since ${item.createdAt.toISOString().slice(0, 10)}`
      : `OCR low-confidence · ${ref}\n` +
        `Tenant: ${item.tenantName}\n` +
        `SKU: ${item.skuParsed ?? '—'}\n` +
        `Confidence: ${item.confidenceScore ?? 0}% (<${CONFIDENCE_THRESHOLD})\n` +
        `Margin loss: ${usd(item.extractedMarginLossCents)}\n` +
        `→ Re-notification — item waiting since ${item.createdAt.toISOString().slice(0, 10)}`;
    const alertDelivery = await sendTelegramAlert(
      text,
      await oneShotKeyboard(
        item.id,
        isFailure
          ? [
              { label: '🔁 Retry dispatch', action: 'RETRY' },
              { label: '🛠 Resolve', action: 'RESOLVE' },
            ]
          : [
              { label: '✅ Approve', action: 'APPROVE' },
              { label: '✏️ Override', action: 'OVERRIDE' },
            ],
      ),
      await ownerChatId(item.tenantName),
    );
    await logCommand({
      actor,
      action: 'HITL_ACTION',
      target: ref,
      detail: `re-notified ${item.tenantName} — ${isFailure ? 'dispatch-failure' : 'OCR review'} card re-sent to the owner (Telegram: ${alertDelivery.toLowerCase()})`,
    });
    return { ok: true, item: toHitlView(item), alertDelivery };
  }

  if (action === 'RETRY') {
    const tenant = await db.tenant.findUnique({ where: { name: item.tenantName } });
    if (tenant && tenant.mailboxStatus === 'ACTIVE') {
      const updated = await db.hitlItem.update({ where: { ref }, data: { status: 'RESOLVED' } });
      await logCommand({ actor, action: 'HITL_ACTION', target: ref, detail: `retried dispatch for ${item.tenantName} — mailbox reachable again, failure resolved` });
      return { ok: true, item: toHitlView(updated), dispatch: { status: 'DISPATCHED' } };
    }
    await logCommand({ actor, action: 'HITL_ACTION', target: ref, detail: `retried dispatch for ${item.tenantName} — mailbox still unreachable, item stays in the queue` });
    return {
      ok: true,
      item: toHitlView(await db.hitlItem.findUniqueOrThrow({ where: { ref } })),
      dispatch: { status: 'FAILED', reason: (item.failureReason as DispatchResult['reason']) ?? 'MAILBOX_LOCKED' },
    };
  }

  // RESOLVE — manual resolution by Damon/Josias.
  const resolved = await db.hitlItem.update({ where: { ref }, data: { status: 'RESOLVED' } });
  await logCommand({ actor, action: 'HITL_ACTION', target: ref, detail: `manually resolved ${item.tenantName} — item closed outside the dispatch path` });
  return { ok: true, item: toHitlView(resolved) };
}

/* ── Inbound RFQ simulator (R-04 demo engine) ────────────────── */

interface Scenario {
  type: 'INTERCEPT' | 'HITL';
  tenant: string;
  item: string;
  orig: number;
  defended: number;
  pdf?: string;
  confidence?: number;
  loss?: number;
}

const SCENARIOS: Scenario[] = [
  { type: 'INTERCEPT', tenant: 'Apex Piping', item: '2" Steel Flange', orig: 14_200, defended: 15_850 },
  { type: 'INTERCEPT', tenant: 'Midwest Trade', item: 'Copper Elbow 3/4"', orig: 1_210, defended: 1_400 },
  { type: 'INTERCEPT', tenant: 'Summit Industrial Fasteners', item: 'CNC Fitting Assembly (Ti)', orig: 482_000, defended: 794_000 },
  { type: 'HITL', tenant: 'Gulf Coast Valve & Fitting', item: 'NS-VALVE-4IN-FLG [Qty: 80]', orig: 0, defended: 0, pdf: 'RFQ_Valve_Spec_Q4.pdf', confidence: 87.5, loss: 218_000 },
  { type: 'INTERCEPT', tenant: 'Apex Piping', item: 'PVC SCH40 Pipe 10ft', orig: 4_500, defended: 5_200 },
];

export async function simulateRfq(actor = 'Engine'): Promise<{
  type: 'INTERCEPT' | 'HITL';
  event?: InterceptView;
  item?: HitlView;
  alertDelivery?: string;
  highValue?: boolean;
}> {
  await ensureDb();
  const [lastEvent, lastHitl] = await Promise.all([
    db.interceptEvent.findFirst({ where: { source: 'SIMULATED' }, orderBy: { createdAt: 'desc' } }),
    db.hitlItem.findFirst({ where: { scenario: { not: null } }, orderBy: { createdAt: 'desc' } }),
  ]);
  const lastIdx = Math.max(lastEvent?.scenario ?? -1, lastHitl?.scenario ?? -1);
  const idx = (lastIdx + 1) % SCENARIOS.length;
  const s = SCENARIOS[idx];

  if (s.type === 'HITL') {
    const res = await createOcrHitl({
      tenantName: s.tenant,
      pdfName: s.pdf,
      skuParsed: s.item,
      confidenceScore: s.confidence ?? 90,
      extractedMarginLossCents: s.loss ?? 0,
      scenario: idx,
    });
    await logCommand({
      actor,
      action: 'RFQ_SIMULATED',
      target: res.item?.ref ?? s.tenant,
      detail: `inbound RFQ for ${s.tenant} — ${s.item} parsed at ${s.confidence ?? 90}% (<95) → queued for HITL review`,
    });
    return { type: 'HITL', item: res.item, alertDelivery: res.alertDelivery };
  }

  const diff = s.defended - s.orig;
  const created = await db.interceptEvent.create({
    data: {
      tenantName: s.tenant,
      item: s.item,
      origCents: s.orig,
      defendedCents: s.defended,
      diffCents: diff,
      source: 'SIMULATED',
      scenario: idx,
    },
  });

  // High-value margin defense watcher (R-04) — > $2,500 fires instantly.
  let alertDelivery: string | undefined;
  const highValue = diff > HIGH_VALUE_THRESHOLD_CENTS;
  if (highValue) {
    alertDelivery = await sendTelegramAlert(
      `High-value intercept · +${usd(diff)}\nTenant: ${s.tenant}\nItem: ${s.item}\nTelegram alert dispatched to Backbone stream`,
    );
  }
  emit({
    type: 'notification',
    kind: highValue ? 'intercept_high' : 'intercept',
    text: `Intercept · +${usd(diff)} defended on ${s.tenant} — ${s.item}${highValue ? ' (high-value alert dispatched)' : ''}`,
  });

  await logCommand({
    actor,
    action: 'RFQ_SIMULATED',
    target: s.tenant,
    detail: `inbound RFQ for ${s.tenant} — ${s.item} intercepted at +${usd(diff)} defended${highValue ? ' · high-value alert dispatched' : ''}`,
  });

  return { type: 'INTERCEPT', event: toInterceptView(created), alertDelivery, highValue };
}
