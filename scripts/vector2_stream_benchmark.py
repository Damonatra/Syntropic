#!/usr/bin/env python3
"""Vector 2 gate benchmark — Taelin Memory Stream recall SLA at scale.

Methodology mirrors the Gate C3 500k Qdrant probe (real component, real
storage, worst-case tenant selectivity):

* 1,000,000 events across 10 tenants, appended through the REAL
  ``TaelinStream.emit`` path onto local disk.
* Worst-case tenant carries 500,000 events (50% selectivity stress,
  mirroring C3's 80%-tenant methodology at stream scale).
* Recall measured on the hot tenant through the production read paths:
  tail(50) for active-session views, 1,000-event range windows, and
  event-filtered scans — 300/200/100 samples respectively.
* Cross-tenant isolation probes assert zero record leakage between
  partitions.

Verdict: recall SLA (<=30ms) holds iff tail p99 AND range p99 both fit.

Output: /home/z/my-project/download/vector2_stream_results.json
"""

from __future__ import annotations

import json
import shutil
import sys
import time
from pathlib import Path

sys.path.insert(0, "/home/z/my-project/Syntropic")

from syntropic.core.stream.taelin import TaelinStream  # noqa: E402

STREAM_ROOT = Path("/tmp/my-project/stream_bench")
HOT_TENANT = "tenant-alpha"
COLD_TENANTS = [f"tenant-beta-{i:02d}" for i in range(9)]
HOT_EVENTS = 500_000
COLD_EVENTS = 500_000  # spread evenly across the 9 cold tenants
RESULTS_PATH = Path("/home/z/my-project/download/vector2_stream_results.json")

EVENT_TYPES = ("rfq_ingested", "ocr_extracted", "margin_adjusted", "draft_injected")


def percentile(sorted_samples: list[float], pct: float) -> float:
    idx = max(int(pct / 100.0 * len(sorted_samples)) - 1, 0)
    return sorted_samples[idx]


def measure(fn, samples: int) -> dict[str, float]:
    latencies: list[float] = []
    for _ in range(samples):
        started = time.perf_counter()
        fn()
        latencies.append((time.perf_counter() - started) * 1000.0)
    latencies.sort()
    return {
        "p50": round(percentile(latencies, 50), 3),
        "p95": round(percentile(latencies, 95), 3),
        "p99": round(percentile(latencies, 99), 3),
        "max": round(latencies[-1], 3),
        "samples": samples,
    }


def main() -> int:
    if STREAM_ROOT.exists():
        shutil.rmtree(STREAM_ROOT)
    STREAM_ROOT.mkdir(parents=True, exist_ok=True)
    stream = TaelinStream(root=STREAM_ROOT, rotate_mb=64)

    # ------------------------------------------------------------------
    print(f"[load] writing {HOT_EVENTS} events -> {HOT_TENANT} ...", flush=True)
    started = time.perf_counter()
    for i in range(HOT_EVENTS):
        stream.emit(
            HOT_TENANT,
            EVENT_TYPES[i % 4],
            {"i": i, "decision": "pass", "line_count": 3, "delta_usd": 12.5},
        )
        if (i + 1) % 100_000 == 0:
            rate = (i + 1) / (time.perf_counter() - started)
            print(f"  {i + 1:,} events ({rate:,.0f} ev/s)", flush=True)
    hot_emit_seconds = time.perf_counter() - started
    hot_emit_rate = HOT_EVENTS / hot_emit_seconds

    print(f"[load] writing {COLD_EVENTS} events across 9 cold tenants ...", flush=True)
    per_cold = COLD_EVENTS // len(COLD_TENANTS)
    cold_started = time.perf_counter()
    for tenant in COLD_TENANTS:
        for i in range(per_cold):
            stream.emit(
                tenant,
                EVENT_TYPES[i % 4],
                {"i": i, "decision": "pass", "line_count": 3},
            )
    cold_emit_seconds = time.perf_counter() - cold_started
    total_events = HOT_EVENTS + COLD_EVENTS

    # ------------------------------------------------------------------
    print("[recall] tail(50) x300 on hot tenant ...", flush=True)
    tail_stats = measure(lambda: stream.tail(HOT_TENANT, last_n=50), 300)

    print("[recall] 1,000-event range x200 on hot tenant ...", flush=True)
    from_seq = HOT_EVENTS - 999
    range_stats = measure(
        lambda: stream.range(HOT_TENANT, from_seq=from_seq, to_seq=HOT_EVENTS), 200
    )

    print("[recall] event-filtered scan x100 on hot tenant ...", flush=True)
    filtered_stats = measure(
        lambda: stream.range(HOT_TENANT, from_seq=from_seq, event="draft_injected"),
        100,
    )

    # Cold-start index rebuild (informational — one-time cost per process)
    cold_index_started = time.perf_counter()
    fresh = TaelinStream(root=STREAM_ROOT, rotate_mb=64)
    fresh.stats(HOT_TENANT)
    cold_index_seconds = time.perf_counter() - cold_index_started

    # ------------------------------------------------------------------
    print("[integrity] full hash-chain verify (hot tenant) ...", flush=True)
    verify_started = time.perf_counter()
    report = stream.verify(HOT_TENANT)
    verify_seconds = time.perf_counter() - verify_started

    print("[isolation] cross-tenant leakage probes ...", flush=True)
    leaks = 0
    # Per-partition event counts via stats() — counts must not bleed.
    for tenant in COLD_TENANTS[:3]:
        if fresh.stats(tenant)["events"] != per_cold:
            leaks += 1
            continue
        # Content probe within the MAX_RANGE_RESULTS cap: no hot-tenant-only
        # field (delta_usd) may appear in a cold partition's records.
        window = fresh.range(tenant, from_seq=1, to_seq=10_000)
        if len(window) != 10_000 or any(
            "delta_usd" in r["payload"] for r in window
        ):
            leaks += 1
    # Hot partition bounded-window probe: exactly 10,000 records, every seq
    # inside the requested window (seq = payload i + 1 by construction).
    from_seq = HOT_EVENTS - 9_999
    hot_probe = stream.range(HOT_TENANT, from_seq=from_seq, to_seq=HOT_EVENTS)
    if len(hot_probe) != 10_000 or any(
        not (from_seq <= r["seq"] <= HOT_EVENTS) for r in hot_probe
    ):
        leaks += 1

    tail_pass = tail_stats["p99"] <= 30.0
    range_pass = range_stats["p99"] <= 30.0
    verdict = (
        "PASS"
        if (tail_pass and range_pass and report["ok"] and leaks == 0)
        else "FAIL"
    )

    results = {
        "gate": "LAYER4_VECTOR2_TAELIN_STREAM_RECALL_SLA",
        "date": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "method": "1M real events via TaelinStream.emit; worst-case tenant 500k; production read paths",
        "scale": {
            "total_events": total_events,
            "hot_tenant": HOT_TENANT,
            "hot_events": HOT_EVENTS,
            "cold_tenants": len(COLD_TENANTS),
            "hot_stream_stats": stream.stats(HOT_TENANT),
        },
        "write": {
            "hot_emit_seconds": round(hot_emit_seconds, 2),
            "hot_emit_rate_eps": round(hot_emit_rate),
            "cold_emit_seconds": round(cold_emit_seconds, 2),
        },
        "recall_ms": {
            "tail_50": tail_stats,
            "range_1000": range_stats,
            "range_filtered": filtered_stats,
        },
        "sla_ms": 30.0,
        "sla_check": {"tail_p99_pass": tail_pass, "range_p99_pass": range_pass},
        "integrity": {
            "verify_ok": report["ok"],
            "verify_events": report["events"],
            "verify_seconds": round(verify_seconds, 2),
        },
        "isolation": {"cross_tenant_leaks": leaks},
        "cold_index_rebuild_seconds": round(cold_index_seconds, 3),
        "verdict": verdict,
    }
    RESULTS_PATH.parent.mkdir(parents=True, exist_ok=True)
    RESULTS_PATH.write_text(json.dumps(results, indent=2))
    print(json.dumps(results, indent=2))
    print(f"\nGATE VERDICT: {verdict} (results -> {RESULTS_PATH})", flush=True)
    return 0 if verdict == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
