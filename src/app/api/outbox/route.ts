import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET(request: NextRequest) {
  try {
    const limitParam = Number(request.nextUrl.searchParams.get("limit") ?? "30");
    const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 200) : 30;
    const events = await db.outboxEvent.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return NextResponse.json({
      events: events.map((event) => ({
        id: event.id,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        eventType: event.eventType,
        payload: JSON.parse(event.payload) as Record<string, unknown>,
        attempts: event.attempts,
        publishedAt: event.publishedAt?.toISOString() ?? null,
        createdAt: event.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    console.error("[api/outbox]", error);
    return NextResponse.json({ error: "outbox query failed" }, { status: 500 });
  }
}
