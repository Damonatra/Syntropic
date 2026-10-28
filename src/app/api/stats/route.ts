import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { CHANNEL_A_MIN_SCORE } from "@/lib/vertebra/scoring";

export async function GET() {
  try {
    const [byIngestion, byDispatch, scoreAgg, caslCount, outboxPending, highTouchPending, verticalAgg] =
      await Promise.all([
        db.prospect.groupBy({ by: ["ingestion"], _count: { _all: true } }),
        db.dispatch.groupBy({ by: ["channel", "status"], _count: { _all: true } }),
        db.score.aggregate({ _count: { _all: true }, _avg: { qlvScore: true } }),
        db.prospect.count({ where: { caslScope: true } }),
        db.outboxEvent.count({ where: { publishedAt: null } }),
        db.highTouchQueueItem.count({ where: { exportedAt: null } }),
        db.prospect.groupBy({ by: ["vertical"], _count: { _all: true } }),
      ]);

    const bands = await db.score.groupBy({ by: ["band"], _count: { _all: true } });

    return NextResponse.json({
      prospects: byIngestion.reduce<Record<string, number>>((acc, row) => {
        acc[row.ingestion] = row._count._all;
        return acc;
      }, {}),
      dispatches: byDispatch.map((row) => ({
        channel: row.channel,
        status: row.status,
        count: row._count._all,
      })),
      scoring: {
        scored: scoreAgg._count._all,
        avgQlv: scoreAgg._avg.qlvScore != null ? Math.round(scoreAgg._avg.qlvScore * 10) / 10 : null,
        bands: bands.reduce<Record<string, number>>((acc, row) => {
          acc[row.band] = row._count._all;
          return acc;
        }, {}),
        channelAThreshold: CHANNEL_A_MIN_SCORE,
      },
      caslScopeCount: caslCount,
      outboxPending,
      highTouchPending,
      verticals: verticalAgg.reduce<Record<string, number>>((acc, row) => {
        if (row.vertical) acc[row.vertical] = row._count._all;
        return acc;
      }, {}),
    });
  } catch (error) {
    console.error("[api/stats]", error);
    return NextResponse.json({ error: "stats failed" }, { status: 500 });
  }
}
