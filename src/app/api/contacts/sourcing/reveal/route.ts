/**
 * POST /api/contacts/sourcing/reveal — spend money on ONE candidate.
 *
 * The fit bar is checked here and again in the lib; the resolver then runs
 * its own registry gate, adapter, and ContactResolution ledger. Refusals
 * (below bar, not staged, gate closed, provider error) come back named
 * with 422 — the candidate row keeps the reason either way.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { operatorFromRequest } from "@/lib/vertebra/session";
import { revealSourcingCandidate } from "@/lib/vertebra/sourcing";
import { invalidateSnapshot } from "@/lib/vertebra/snapshot-cache";

const PostBody = z.object({ candidateId: z.string().min(1) });

export async function POST(request: Request) {
  const json = await request.json().catch(() => null);
  const parsed = PostBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", issues: parsed.error.issues }, { status: 400 });
  }
  const actor = (await operatorFromRequest(request)) ?? "operator";

  const outcome = await revealSourcingCandidate(parsed.data.candidateId, { actor });
  invalidateSnapshot();
  return NextResponse.json(outcome, { status: outcome.ok ? 200 : 422 });
}
