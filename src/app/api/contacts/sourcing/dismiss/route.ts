/**
 * POST /api/contacts/sourcing/dismiss — an operator veto on one candidate.
 *
 * Dismissal is an operator act and survives re-staging: a later batch may
 * refresh the fit math on a dismissed prospect, but the verdict stands
 * until a human says otherwise. Only staged candidates can be dismissed.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { operatorFromRequest } from "@/lib/vertebra/session";
import { dismissSourcingCandidate } from "@/lib/vertebra/sourcing";
import { invalidateSnapshot } from "@/lib/vertebra/snapshot-cache";

const PostBody = z.object({
  candidateId: z.string().min(1),
  reason: z.string().max(400).default("operator dismissal"),
});

export async function POST(request: Request) {
  const json = await request.json().catch(() => null);
  const parsed = PostBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", issues: parsed.error.issues }, { status: 400 });
  }
  const actor = (await operatorFromRequest(request)) ?? "operator";

  const outcome = await dismissSourcingCandidate(parsed.data.candidateId, parsed.data.reason, actor);
  invalidateSnapshot();
  return NextResponse.json(outcome, { status: outcome.ok ? 200 : 422 });
}
