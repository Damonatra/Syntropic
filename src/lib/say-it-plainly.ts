/**
 * Say-it-plainly — the command line parser (Feature: the station listens).
 *
 * A deliberately conservative parser: it recognizes a small set of commands
 * unambiguously and refuses everything else rather than guessing. Every
 * parse produces a *draft* the operator confirms before anything executes —
 * the station listens, but never acts on its own.
 */

export type ParsedCommand =
  | { kind: 'target'; memberName: string; memberLabel: string; target: number; summary: string }
  | { kind: 'hitl'; ref: string; action: 'APPROVE' | 'OVERRIDE' | 'RETRY' | 'RESOLVE'; summary: string }
  | { kind: 'invite'; tenantName: string; summary: string }
  | { kind: 'message'; tenantName: string; text: string; summary: string }
  | { kind: 'unknown'; summary: string; hint: string };

export interface ParseContext {
  currentUser: string;
  /** TeamMember.name values: ["Damon", "Josias"] */
  teamNames: string[];
  /** Tenant.name values for fuzzy tenant matching. */
  tenantNames: string[];
  /** Pending HITL refs the station may act on. */
  hitlRefs: string[];
}

/** Longest tenant name whose prefix (word-boundary safe) matches the text. */
function matchTenant(text: string, tenantNames: string[]): string | null {
  const lower = text.toLowerCase();
  let best: string | null = null;
  for (const name of tenantNames) {
    const n = name.toLowerCase();
    if (lower.includes(n) && (!best || n.length > best.length)) best = name;
  }
  // Try a distinctive first-word match: "gulf" → "Gulf Coast Valve & Fitting".
  if (!best) {
    for (const name of tenantNames) {
      const first = name.split(/[ &]/)[0]?.toLowerCase();
      if (first && first.length >= 4 && lower.includes(first)) best = name;
    }
  }
  return best;
}

export function parseCommand(input: string, ctx: ParseContext): ParsedCommand {
  const text = input.trim().toLowerCase();
  if (!text) return unknown('');

  // ── Targets ──────────────────────────────────────────────────
  // "raise my target to 180" · "set josias target 165" · "adjust damon's outbound target to 200"
  const targetMatch = text.match(
    /(?:raise|set|adjust|change|move|bump)\s+(?:my|the)?\s*(damon'?s?|josias'?s?|my)?\s*(?:quarterly\s+)?(?:outbound\s+)?(?:target|goal)\s*(?:to|=|:)?\s*(\d{1,6})/,
  );
  if (targetMatch) {
    const whoRaw = targetMatch[1];
    const target = Number(targetMatch[2]);
    if (Number.isFinite(target) && target >= 1) {
      let memberName: string;
      let memberLabel: string;
      if (!whoRaw || whoRaw.startsWith('my')) {
        memberName = ctx.currentUser;
        memberLabel = 'my own';
      } else {
        const cleaned = whoRaw.replace(/['’]s?$/, '');
        // Team handles are capitalized ("Damon") — match case-insensitively.
        const member = ctx.teamNames.find((n) => n.toLowerCase() === cleaned.toLowerCase());
        if (!member) return unknown(text);
        memberName = member;
        memberLabel = `${member}'s`;
      }
      return {
        kind: 'target',
        memberName,
        memberLabel,
        target,
        summary: `Set ${memberLabel} quarterly outbound target to ${target.toLocaleString()}`,
      };
    }
  }

  // ── HITL actions ─────────────────────────────────────────────
  // "approve hitl-8092" · "override item 8093" · "retry hitl 8092" · "resolve 8093"
  // The hitl- prefix is optional — queue refs are 4-digit and unambiguous.
  const hitlMatch = text.match(/^(approve|override|retry|resolve)\s+(?:item\s+)?(?:hitl[\s-]?)?(\d{3,})$/);
  if (hitlMatch) {
    const action = hitlMatch[1].toUpperCase() as 'APPROVE' | 'OVERRIDE' | 'RETRY' | 'RESOLVE';
    const ref = `HITL-${hitlMatch[2]}`;
    if (!ctx.hitlRefs.includes(ref)) {
      return {
        kind: 'unknown',
        summary: text,
        hint: `${ref} isn't waiting in the queue right now — check the Ingestion & HITL tab for live refs.`,
      };
    }
    const verbs: Record<string, string> = { APPROVE: 'Approve & dispatch', OVERRIDE: 'Manually override', RETRY: 'Retry dispatch for', RESOLVE: 'Mark resolved' };
    return { kind: 'hitl', ref, action, summary: `${verbs[action]} ${ref}` };
  }

  // ── Invites ──────────────────────────────────────────────────
  // "invite apex to the portal" · "issue an invite for gulf coast valve & fitting"
  const inviteMatch = text.match(/^(?:invite|issue\s+(?:an?\s+)?(?:new\s+)?invite(?:\s+for|\s+to)?)\s+(.+?)(?:\s+to\s+the\s+portal)?$/);
  if (inviteMatch) {
    const tenant = matchTenant(inviteMatch[1], ctx.tenantNames);
    if (tenant) {
      return { kind: 'invite', tenantName: tenant, summary: `Issue a fresh portal invite for ${tenant}` };
    }
    return {
      kind: 'unknown',
      summary: text,
      hint: `No tenant on the ledger matches “${inviteMatch[1]}”. Known enclaves: ${ctx.tenantNames.join(', ')}.`,
    };
  }

  // ── Messages ─────────────────────────────────────────────────
  // "message apex saying we're on it" · "message midwest: contract is out"
  // Matched against the ORIGINAL input (case-insensitive) so the message
  // text keeps the operator's capitalization.
  const messageMatch = input.trim().match(/^message\s+(.+?)\s*(?:\bsaying\b|\bthat\b|:)\s*(.+)$/i);
  if (messageMatch) {
    const tenant = matchTenant(messageMatch[1].toLowerCase(), ctx.tenantNames);
    if (tenant && messageMatch[2].trim()) {
      return {
        kind: 'message',
        tenantName: tenant,
        text: messageMatch[2].trim(),
        summary: `Send a message to ${tenant}: “${messageMatch[2].trim()}”`,
      };
    }
    return {
      kind: 'unknown',
      summary: text,
      hint: tenant
        ? `What should the message to ${tenant} say? Try: “message ${tenant.split(' ')[0].toLowerCase()} saying we're on it”.`
        : `No tenant on the ledger matches “${messageMatch[1]}”. Known enclaves: ${ctx.tenantNames.join(', ')}.`,
    };
  }

  return unknown(text);
}

function unknown(text: string): ParsedCommand {
  return {
    kind: 'unknown',
    summary: text,
    hint: 'Try: “raise my target to 180” · “approve HITL-8092” · “invite gulf to the portal” · “message apex saying we\'re on it”.',
  };
}
