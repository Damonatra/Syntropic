import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { detectRegion } from "@/lib/vertebra/classify";

const COLUMNS = [
  "prospect_id",
  "company_name",
  "contact_first",
  "contact_last",
  "role",
  "email",
  "city",
  "state_province",
  "region",
  "vertical",
  "qlv_score",
  "qlv_band",
  "top_hook",
  "rationale",
  "detected_erp",
  "casl_scope",
  "calendar_event_id",
  "created_at",
] as const;

function csvEscape(value: unknown): string {
  if (value == null) return "";
  const text = String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export async function GET() {
  try {
    const pending = await db.highTouchQueueItem.findMany({
      where: { exportedAt: null },
      orderBy: [{ qlvScore: "desc" }, { createdAt: "asc" }],
      include: {
        prospect: { include: { contacts: { take: 1 } } },
      },
    });

    if (pending.length === 0) {
      return NextResponse.json({ status: "empty", message: "no pending high-touch rows" });
    }

    const rows = pending.map((item) => {
      const p = item.prospect;
      const contact = p.contacts[0];
      return {
        prospect_id: p.id,
        company_name: p.name,
        contact_first: contact?.firstName ?? "",
        contact_last: contact?.lastName ?? "",
        role: contact?.role ?? "unknown",
        email: p.bestEmail ?? "",
        city: p.city ?? "",
        state_province: p.stateProvince ?? "",
        region: p.region ?? detectRegion({ domain: p.domain, stateProvince: p.stateProvince }) ?? "us",
        vertical: p.vertical ?? "",
        qlv_score: item.qlvScore,
        qlv_band: item.qlvBand,
        top_hook: item.topHook,
        rationale: item.rationale,
        detected_erp: p.detectedErp ?? "",
        casl_scope: p.caslScope ? "yes" : "no",
        calendar_event_id: item.calendarEventId ?? "",
        created_at: item.createdAt.toISOString(),
      };
    });

    const csv = [
      COLUMNS.join(","),
      ...rows.map((row) => COLUMNS.map((column) => csvEscape(row[column])).join(",")),
    ].join("\r\n");

    await db.$transaction([
      db.highTouchQueueItem.updateMany({
        where: { id: { in: pending.map((i) => i.id) } },
        data: { exportedAt: new Date() },
      }),
      db.outboxEvent.create({
        data: {
          aggregateType: "high_touch",
          aggregateId: "batch",
          eventType: "high_touch.exported",
          payload: JSON.stringify({ rows: rows.length }),
        },
      }),
    ]);

    const stamp = new Date().toISOString().replace(/[:T]/g, "").slice(0, 15);
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="josias-high-touch-${stamp}.csv"`,
      },
    });
  } catch (error) {
    console.error("[api/dispatch/export]", error);
    return NextResponse.json({ error: "export failed" }, { status: 500 });
  }
}
