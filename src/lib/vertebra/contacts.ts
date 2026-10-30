/**
 * Contact resolver — the enrich spoke.
 *
 * One job: given a named contact and a company domain, find the verified
 * work email — through the registry gate, through priority-ordered provider
 * adapters, with every attempt (resolved, no_match, refused) landing in the
 * ContactResolution ledger. A resolver that quietly pretends to work is a
 * resolver the pipeline trusts and suffers for; refusals are rows too.
 *
 * What this is NOT: bulk prospect sourcing (finding WHO to email at a
 * company is a search problem — a later spoke). This resolves the email of
 * a contact the enclave already believes in: name + domain in, email out.
 *
 * Adapters are functions of an injected transport. Production runs on real
 * fetch; tests and proofs run on fixtures — the wire format is pinned by
 * the fixtures, so a provider changing their response shape breaks a test
 * before it breaks a dispatch.
 */
import { db } from "@/lib/db";
import { pickEnrichIntegration, recordIntegrationFailure, recordIntegrationSuccess } from "@/lib/vertebra/integrations";

export type Transport = (url: string, init?: RequestInit) => Promise<Response>;

export interface ContactQuery {
  domain?: string | null;
  company?: string | null;
  name?: string | null;
  role?: string | null;
}

export interface AdapterResult {
  outcome: "resolved" | "no_match";
  email?: string | null;
  pattern?: string | null;
  confidence?: "high" | "medium" | "low" | null;
  credits: number;
  detail: string;
}

export interface ContactAdapter {
  provider: string;
  resolve(query: ContactQuery, env: { apiKey: string; transport: Transport }): Promise<AdapterResult>;
}

const APOLLO_BASE = "https://api.apollo.io";
const HUNTER_BASE = "https://api.hunter.io";
const CALL_TIMEOUT_MS = 12_000;

/** "Damon Atara" → { first: "Damon", last: "Atara" } — first token vs the rest. */
export function splitName(name: string | null | undefined): { first: string | null; last: string | null } {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: null, last: null };
  if (parts.length === 1) return { first: parts[0], last: null };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

/* ------------------------------------------------------------------ apollo -- */

export const apolloAdapter: ContactAdapter = {
  provider: "apollo",
  async resolve(query, { apiKey, transport }) {
    const { first, last } = splitName(query.name);
    const res = await transport(`${APOLLO_BASE}/api/v1/people/match`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": apiKey },
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      body: JSON.stringify({
        ...(query.domain ? { domain: query.domain } : {}),
        ...(query.company ? { organization_name: query.company } : {}),
        ...(first ? { first_name: first } : {}),
        ...(last ? { last_name: last } : {}),
        ...(query.role ? { title: query.role } : {}),
        reveal_personal_emails: false,
      }),
    });
    if (!res.ok) {
      throw new Error(`apollo_http_${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      person?: { email?: string | null; email_status?: string | null; organization?: { email_pattern?: string | null } | null } | null;
    };
    const email = data.person?.email ?? null;
    if (!email) {
      return { outcome: "no_match", credits: 0, detail: "apollo matched no billable contact for this query" };
    }
    const confidence = data.person?.email_status === "verified" ? "high" : "medium";
    return {
      outcome: "resolved",
      email,
      pattern: data.person?.organization?.email_pattern ?? null,
      confidence,
      credits: 1,
      detail: `apollo email_status=${data.person?.email_status ?? "unknown"}`,
    };
  },
};

/* ------------------------------------------------------------------ hunter -- */

export const hunterAdapter: ContactAdapter = {
  provider: "hunter",
  async resolve(query, { apiKey, transport }) {
    const { first, last } = splitName(query.name);
    const url = new URL(`${HUNTER_BASE}/v2/email-finder`);
    if (query.domain) url.searchParams.set("domain", query.domain);
    if (first) url.searchParams.set("first_name", first);
    if (last) url.searchParams.set("last_name", last);
    url.searchParams.set("api_key", apiKey);
    const res = await transport(url.toString(), { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
    if (!res.ok) {
      throw new Error(`hunter_http_${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    }
    const data = (await res.json()) as { data?: { email?: string | null; score?: number | null } | null };
    const email = data.data?.email ?? null;
    if (!email) {
      return { outcome: "no_match", credits: 0, detail: "hunter found no email for this query" };
    }
    const score = data.data?.score ?? 0;
    const confidence = score >= 90 ? "high" : score >= 75 ? "medium" : "low";
    return { outcome: "resolved", email, pattern: null, confidence, credits: 1, detail: `hunter score=${score}` };
  },
};

export const ADAPTERS: Record<string, ContactAdapter> = {
  apollo: apolloAdapter,
  hunter: hunterAdapter,
};

/* ---------------------------------------------------------------- resolver -- */

export interface ResolveInput {
  query: ContactQuery;
  prospectId?: string | null;
  actor?: string | null;
  transport?: Transport;
}

export interface ResolveOutcome {
  ok: boolean;
  status: "resolved" | "no_match" | "refused";
  provider: string;
  reason?: string;
  email?: string | null;
  pattern?: string | null;
  confidence?: "high" | "medium" | "low" | null;
  creditsUsed: number;
  durationMs: number;
  resolutionId?: string;
  prospectUpdated: boolean;
}

/**
 * Resolve one contact email. Gate → adapter → ledger, in that order, and
 * every branch writes its row. `no_match` counts as an integration success
 * (the provider answered; the answer was "nobody by that name") — the
 * circuit stays closed, the credits land in the ledger.
 */
export async function resolveContact(input: ResolveInput): Promise<ResolveOutcome> {
  const started = Date.now();
  const actor = input.actor ?? "operator";
  const queryJson = JSON.stringify({
    domain: input.query.domain ?? null,
    company: input.query.company ?? null,
    name: input.query.name ?? null,
    role: input.query.role ?? null,
  });

  const writeRow = async (data: {
    provider: string;
    outcome: "resolved" | "no_match" | "refused";
    refuseReason?: string;
    email?: string | null;
    confidence?: string | null;
    creditsUsed?: number;
  }): Promise<string> => {
    const row = await db.contactResolution.create({
      data: {
        prospectId: input.prospectId ?? null,
        provider: data.provider,
        queryJson,
        outcome: data.outcome,
        refuseReason: data.refuseReason ?? null,
        email: data.email ?? null,
        confidence: data.confidence ?? null,
        creditsUsed: data.creditsUsed ?? 0,
        durationMs: Date.now() - started,
        actor,
      },
      select: { id: true },
    });
    return row.id;
  };

  // 1 — the query must name a person and a place to look. A nameless
  // company-wide "who should I email" search is the sourcing spoke, not this.
  const hasName = Boolean(input.query.name?.trim());
  const hasPlace = Boolean(input.query.domain?.trim() || input.query.company?.trim());
  if (!hasName || !hasPlace) {
    const reason = "invalid_query: the resolver needs a contact name AND a domain or company — nameless sourcing is a different spoke";
    const resolutionId = await writeRow({ provider: "none", outcome: "refused", refuseReason: reason });
    return { ok: false, status: "refused", provider: "none", reason, creditsUsed: 0, durationMs: Date.now() - started, resolutionId, prospectUpdated: false };
  }

  // 2 — the registry gate: first armed + healthy enrich provider wins.
  const picked = await pickEnrichIntegration();
  if (!picked.ok) {
    const resolutionId = await writeRow({ provider: "none", outcome: "refused", refuseReason: picked.reason });
    return { ok: false, status: "refused", provider: "none", reason: picked.reason, creditsUsed: 0, durationMs: Date.now() - started, resolutionId, prospectUpdated: false };
  }

  // 3 — call the adapter through the injected transport.
  const adapter = ADAPTERS[picked.provider];
  const apiKey = (process.env[picked.row.keyEnvVar ?? ""] ?? "").trim();
  try {
    const result = await adapter.resolve(input.query, { apiKey, transport: input.transport ?? fetch });
    if (result.outcome === "resolved" && result.email) {
      await recordIntegrationSuccess(picked.provider);
      let prospectUpdated = false;
      if (input.prospectId) {
        const updated = await db.prospect
          .update({ where: { id: input.prospectId }, data: { bestEmail: result.email, emailPattern: result.pattern ?? undefined }, select: { id: true } })
          .catch(() => null);
        prospectUpdated = updated != null;
      }
      const resolutionId = await writeRow({
        provider: picked.provider,
        outcome: "resolved",
        email: result.email,
        confidence: result.confidence ?? null,
        creditsUsed: result.credits,
      });
      return {
        ok: true,
        status: "resolved",
        provider: picked.provider,
        email: result.email,
        pattern: result.pattern,
        confidence: result.confidence,
        creditsUsed: result.credits,
        durationMs: Date.now() - started,
        resolutionId,
        prospectUpdated,
      };
    }
    // Provider answered: nobody home. A successful call, zero credits.
    await recordIntegrationSuccess(picked.provider);
    const resolutionId = await writeRow({ provider: picked.provider, outcome: "no_match", creditsUsed: result.credits });
    return {
      ok: true,
      status: "no_match",
      provider: picked.provider,
      reason: result.detail,
      creditsUsed: result.credits,
      durationMs: Date.now() - started,
      resolutionId,
      prospectUpdated: false,
    };
  } catch (error) {
    // 4 — transport/provider failure: the circuit counts it. Named, ledgered, refused.
    const reason = `provider_error: ${String(error).slice(0, 300)}`;
    await recordIntegrationFailure(picked.provider, reason);
    const resolutionId = await writeRow({ provider: picked.provider, outcome: "refused", refuseReason: reason });
    return { ok: false, status: "refused", provider: picked.provider, reason, creditsUsed: 0, durationMs: Date.now() - started, resolutionId, prospectUpdated: false };
  }
}
