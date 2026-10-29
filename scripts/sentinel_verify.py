#!/usr/bin/env python3
"""
M3 sentinel verification — honest round-trip:

  backfill  insert 9 synthetic CommandBaseline rows over ~8h with a convexly
            rising outbox backlog (0,0,1,2,3,5,8,13,20) — exactly the shape a
            stalling publish pipeline produces. The rows are marked cb_test_
            and PURGED on cleanup so the ledger never keeps invented data.
  cleanup   delete every cb_test_ row.

Usage: python3 scripts/sentinel_verify.py backfill|cleanup
"""
import json
import sqlite3
import sys
import time

DB = "/home/z/my-project/db/custom.db"

VALS = [0, 0, 1, 2, 3, 5, 8, 13, 20]  # convex rise — slope accelerates
SPAN_H = 8  # hours back from now for the first row


def base_metrics(outbox: int) -> dict:
    # Full KpiInputs shape so persona readers never see nulls; the sentinel
    # fields ride along exactly as the live capture now writes them.
    return {
        "leakageTotalUsd": 17477565,
        "criticalCount": 4,
        "draftsPending": 2,
        "scoredCount": 9,
        "latencyCrew": 0,
        "spaLaggards": 0,
        "manualAvg": 0,
        "highIntentCount": 1,
        "telemetryEvents24h": 7,
        "dispatchesSent24h": 0,
        "outboxPending": outbox,
        "dispatchFailed24h": 0,
    }


def backfill() -> None:
    conn = sqlite3.connect(DB)
    cur = conn.cursor()
    now = time.time() * 1000
    rows = []
    for i, v in enumerate(VALS):
        ts = int(now - (SPAN_H - i) * 3_600_000)
        rows.append((f"cb_test_{i}_{ts}", ts, json.dumps(base_metrics(v))))
    cur.executemany(
        "INSERT OR REPLACE INTO CommandBaseline (id, capturedAt, metricsJson) VALUES (?, ?, ?)",
        rows,
    )
    conn.commit()
    print(f"backfilled {len(rows)} synthetic baseline rows (ids prefixed cb_test_)")
    conn.close()


def cleanup() -> None:
    conn = sqlite3.connect(DB)
    cur = conn.cursor()
    cur.execute("DELETE FROM CommandBaseline WHERE id LIKE 'cb_test_%'")
    print(f"purged {cur.rowcount} synthetic rows")
    conn.commit()
    conn.close()


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "backfill":
        backfill()
    elif cmd == "cleanup":
        cleanup()
    else:
        print("usage: sentinel_verify.py backfill|cleanup")
        sys.exit(1)
