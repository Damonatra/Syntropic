/**
 * POST /api/contacts/sourcing/search — the sourcing spoke's console door.
 *
 * One ICP in, a staged reveal queue out. mode "live" walks the registry
 * gate and fires the real Apollo people search (0 email credits — search
 * is free; the ledger never claims otherwise). mode "staging" runs the
 * fixtures and is refused when apollo is armed — fixtures never outrun
 * the truth. Refusals are named and returned with 422 like every door.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { operatorFromRequest } from "@/lib/vertebra/session";
import { DEFAULT_ICP, stageSourcingBatch } from "@/lib/vertebra/sourcing";
import { invalidateSnapshot } from "@/lib/vertebra/snapshot-cache";

// zod v4 law: .partial() cannot follow .refine() — the shape is validated
// plain here, and the min ≤ max invariant is checked on the MERGED icp
// (unset keys fall back to the house ICP, and the merged pair is what the
// rubric actually runs on).
const IcpSchema = z.object({
  titles: z.array(z.string().min(1).max(120)).max(12),
  industries: z.array(z.string().min(1).max(120)).max(12),
  regions: z.array(z.string().min(1).max(120)).max(12),
  employeeMin: z.number().int().min(1).max(100_000),
  employeeMax: z.number().int().min(1).max(100_000),
  erpKeywords: z.array(z.string().min(1).max(60)).max(12),
});

const PostBody = z.object({
  icp: IcpSchema.partial().optional(),
  mode: z.enum(["live", "staging"]).default("live"),
});

export async function POST(request: Request) {
  const json = await request.json().catch(() => null);
  const parsed = PostBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", issues: parsed.error.issues }, { status: 400 });
  }
  const actor = (await operatorFromRequest(request)) ?? "operator";
  const icp = { ...DEFAULT_ICP, ...parsed.data.icp } as typeof DEFAULT_ICP;
  if (icp.employeeMin > icp.employeeMax) {
    return NextResponse.json({ error: "invalid_body", issues: [{ message: "employeeMin must be ≤ employeeMax" }] }, { status: 400 });
  }

  const outcome = await stageSourcingBatch({ icp, actor, mode: parsed.data.mode });
  invalidateSnapshot();
  return NextResponse.json(outcome, { status: outcome.ok ? 200 : 422 });
}
