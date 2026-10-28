"use client";

import { Stats } from "@/lib/vertebra/types";
import { QlvSparkline } from "./qlv-sparkline";

interface HeroProps {
  stats: Stats | null;
  scoreTrend: number[];
  onScorePipeline: () => void;
  onExportCsv: () => void;
}

export function Hero({ stats, scoreTrend, onScorePipeline, onExportCsv }: HeroProps) {
  const ingested = stats?.prospects?.ingested ?? 0;
  const scored = stats?.scoring?.scored ?? 0;
  const avgQlv = stats?.scoring?.avgQlv;
  const channelA =
    stats?.dispatches
      ?.filter((d) => d.channel === "channel_a_automated_email")
      .reduce((sum, d) => sum + d.count, 0) ?? 0;
  const channelB =
    stats?.dispatches
      ?.filter((d) => d.channel === "channel_b_josias_high_touch")
      .reduce((sum, d) => sum + d.count, 0) ?? 0;

  return (
    <section className="relative mx-auto max-w-[1200px] px-5 pb-24 pt-14 sm:px-8 sm:pt-20">
      <div className="relative z-10 mx-auto max-w-[860px] text-center">
        <p className="tag mb-6 uppercase">Syntropic · Q4 enterprise pipeline</p>
        <h1 className="display-xl text-[#17191c]">
          Quote leakage,
          <br />
          <span className="italic-accent">quantified</span> and dispatched.
        </h1>
        <p className="subhead mx-auto mt-6 max-w-[560px]">
          Vertebra ingests US &amp; Canada industrial distributors, scores their Quote
          Leakage Vulnerability with Claude, and routes every account down the channel
          that converts — automated email or Josias high-touch.
        </p>
        <div className="mt-9 flex flex-wrap items-center justify-center gap-4">
          <button className="pill pill-dark" onClick={onScorePipeline}>
            Score the pipeline
          </button>
          <button className="pill pill-ghost" onClick={onExportCsv}>
            Export Josias CSV
          </button>
        </div>
      </div>

      {/* Floating product artifacts — cropped console fragments */}
      <div className="relative mt-16 grid grid-cols-1 gap-6 sm:mt-20 md:grid-cols-3">
        <div className="artifact relative z-10 p-5 md:-rotate-[0.6deg]">
          <p className="meta">Prospects ingested</p>
          <p className="mt-1 font-display text-[40px] leading-none text-[#17191c]">
            {ingested}
            <span className="ml-2 align-middle text-[14px] text-[#777b86]">
              {scored} scored
            </span>
          </p>
          <div className="mt-4 flex items-end justify-between gap-3">
            <p className="text-[13px] text-[#777b86]">
              {stats?.caslScopeCount ?? 0} in CASL scope
            </p>
            <div className="h-[52px] w-[140px]">
              <QlvSparkline values={scoreTrend.length > 1 ? scoreTrend : [30, 55, 42, 68, 74, 88]} />
            </div>
          </div>
        </div>

        <div className="artifact relative z-20 p-5 md:-translate-y-4">
          <p className="meta">Average QLV</p>
          <p className="mt-1 font-display text-[40px] leading-none text-[#17191c]">
            {avgQlv != null ? avgQlv.toFixed(1) : "—"}
            <span className="ml-1 text-[18px] text-[#777b86]">/100</span>
          </p>
          <div className="mt-4 space-y-2">
            {[
              ["Critical", stats?.scoring?.bands?.critical ?? 0],
              ["High", stats?.scoring?.bands?.high ?? 0],
              ["Medium", stats?.scoring?.bands?.medium ?? 0],
              ["Low", stats?.scoring?.bands?.low ?? 0],
            ].map(([band, count]) => (
              <div key={band as string} className="flex items-center gap-2">
                <span className="tag w-14 text-left">{band}</span>
                <div className="qlv-track flex-1">
                  <div
                    className="qlv-fill"
                    style={{
                      width: `${Math.min(100, (Number(count) / Math.max(1, scored)) * 100)}%`,
                      opacity: band === "Critical" || band === "High" ? 1 : 0.35,
                    }}
                  />
                </div>
                <span className="text-[13px] tabular-nums text-[#777b86]">{count}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="artifact relative z-10 p-5 md:rotate-[0.6deg]">
          <p className="meta">Channel routing</p>
          <div className="mt-4 space-y-4">
            <div>
              <div className="flex items-baseline justify-between">
                <p className="text-[15px] text-[#17191c]">A · Automated email</p>
                <p className="font-display text-[26px] leading-none text-[#17191c]">{channelA}</p>
              </div>
              <p className="mt-1 text-[13px] text-[#777b86]">
                syntropic-os.com rotation · warmup caps · CASL headers
              </p>
            </div>
            <div className="h-px bg-[#ececec]" />
            <div>
              <div className="flex items-baseline justify-between">
                <p className="text-[15px] text-[#17191c]">B · Josias high-touch</p>
                <p className="font-display text-[26px] leading-none text-[#17191c]">{channelB}</p>
              </div>
              <p className="mt-1 text-[13px] text-[#777b86]">
                structured CSV queue · Calendar follow-ups · outbox events
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
