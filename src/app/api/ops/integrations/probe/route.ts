/**
 * POST /api/ops/integrations/probe — fire a real check through one
 * integration and record the evidence.
 *
 * Internal machine doors get the real thing: a synthetic signed request
 * built from the live env secrets, self-fetched through the actual door —
 * a 401 here is a failing door, not a probe artifact. Key-carrying
 * providers get the honest cheap check: key presence, key shape, network
 * reachability — never presented as "enrichment works".
 *
 * Probe evidence lands on the row but probes never increment the failure
 * counter — they are diagnostics, not calls. A fully-passing probe closes
 * the circuit: the operator's "it's fixed" gesture, with a paper trail.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { operatorFromRequest } from "@/lib/vertebra/session";
import { probeIntegration, type DoorProbeResponse } from "@/lib/vertebra/integrations";
import { invalidateSnapshot } from "@/lib/vertebra/snapshot-cache";

const PostBody = z.object({ provider: z.string().min(2).max(64) });

export async function POST(request: Request) {
  const json = await request.json().catch(() => null);
  const parsed = PostBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", issues: parsed.error.issues }, { status: 400 });
  }
  const actor = (await operatorFromRequest(request)) ?? "operator";
  const { provider } = parsed.data;
  const origin = new URL(request.url).origin;

  const fireDoor = async (req: { path: string; body: string; headers: Record<string, string> }): Promise<DoorProbeResponse> => {
    const res = await fetch(`${origin}${req.path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...req.headers },
      body: req.body,
      signal: AbortSignal.timeout(20_000), // cold-compile of a door route on first hit
    });
    const body = await res.text().catch(() => "");
    return { status: res.status, body: body.slice(0, 400) };
  };

  const result = await probeIntegration(provider, { fireDoor });
  if (!result) {
    return NextResponse.json({ error: "unknown_provider", provider }, { status: 404 });
  }
  invalidateSnapshot();
  console.log(`[api/ops/integrations/probe] ${provider} ok=${result.ok} by ${actor}`);
  // ProbeResult already carries ok — returned verbatim, no parallel truth.
  return NextResponse.json({ actor, ...result });
}
