/**
 * POST /api/contacts/resolve — the enrich spoke's console door.
 *
 * One named contact + one domain in, a verified work email out — through
 * the registry gate, the priority-ordered adapters, and the
 * ContactResolution ledger. Refusals are named and ledgered like every
 * other door in the enclave: staged provider, missing key, open circuit,
 * invalid query. When a prospectId is supplied the resolved email lands on
 * the prospect (bestEmail + the provider's email pattern).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { operatorFromRequest } from "@/lib/vertebra/session";
import { resolveContact } from "@/lib/vertebra/contacts";
import { invalidateSnapshot } from "@/lib/vertebra/snapshot-cache";

const PostBody = z.object({
  prospectId: z.string().min(1).nullish(),
  domain: z.string().max(253).nullish(),
  company: z.string().max(200).nullish(),
  name: z.string().max(200).nullish(),
  role: z.string().max(200).nullish(),
});

export async function POST(request: Request) {
  const json = await request.json().catch(() => null);
  const parsed = PostBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", issues: parsed.error.issues }, { status: 400 });
  }
  const actor = (await operatorFromRequest(request)) ?? "operator";

  const outcome = await resolveContact({
    query: {
      domain: parsed.data.domain ?? null,
      company: parsed.data.company ?? null,
      name: parsed.data.name ?? null,
      role: parsed.data.role ?? null,
    },
    prospectId: parsed.data.prospectId ?? null,
    actor,
  });

  invalidateSnapshot();
  // ResolveOutcome already carries ok — returning it verbatim keeps the
  // door's JSON exactly as honest as the lib's verdict.
  return NextResponse.json(outcome, { status: outcome.status === "refused" ? 422 : 200 });
}
