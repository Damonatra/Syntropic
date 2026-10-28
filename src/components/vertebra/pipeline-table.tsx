"use client";

import { ProspectRow, VERTICAL_LABELS } from "@/lib/vertebra/types";
import { formatRevenue } from "@/lib/vertebra/classify";

interface PipelineTableProps {
  prospects: ProspectRow[];
  busyId: string | null;
  selectedId: string | null;
  onSelect: (prospect: ProspectRow) => void;
  onScore: (prospect: ProspectRow) => void;
  onDispatch: (prospect: ProspectRow) => void;
}

function bandWidth(score: number) {
  return `${Math.max(4, Math.min(100, score))}%`;
}

export function PipelineTable({
  prospects,
  busyId,
  selectedId,
  onSelect,
  onScore,
  onDispatch,
}: PipelineTableProps) {
  if (prospects.length === 0) {
    return (
      <div className="artifact p-10 text-center">
        <p className="font-display text-[24px] text-[#17191c]">The pipeline is empty.</p>
        <p className="mx-auto mt-2 max-w-[420px] text-[15px] text-[#777b86]">
          Add the first distributor manually — the engine&apos;s directory workers
          (Blue Book, NFPA, CIPH, HARDI, FPDA) take over once deployed with Neon
          credentials.
        </p>
      </div>
    );
  }

  return (
    <div className="artifact overflow-hidden">
      <div className="scroll-slim max-h-[560px] overflow-y-auto">
        <table className="w-full border-collapse text-left">
          <thead className="sticky top-0 z-10 bg-white">
            <tr className="border-b border-[#ececec]">
              {["Company", "Vertical", "Location", "Revenue", "QLV", "Status", ""].map((head) => (
                <th key={head} className="px-5 py-3.5 text-[12.5px] font-normal uppercase tracking-[0.06em] text-[#979799]">
                  {head}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {prospects.map((prospect) => {
              const isSelected = prospect.id === selectedId;
              const isBusy = prospect.id === busyId;
              return (
                <tr
                  key={prospect.id}
                  onClick={() => onSelect(prospect)}
                  className={`cursor-pointer border-b border-[#f2f2f3] transition-colors last:border-0 ${
                    isSelected ? "bg-[#fafafb]" : "hover:bg-[#fafafb]"
                  }`}
                >
                  <td className="px-5 py-4">
                    <p className="text-[15px] font-medium text-[#17191c]">{prospect.name}</p>
                    <p className="text-[13px] text-[#a3a6af]">
                      {prospect.domain ?? "—"}
                      {prospect.detectedErp ? ` · ${prospect.detectedErp}` : ""}
                    </p>
                  </td>
                  <td className="px-5 py-4">
                    <span className="tag">
                      {prospect.vertical ? VERTICAL_LABELS[prospect.vertical] ?? prospect.vertical : "—"}
                    </span>
                  </td>
                  <td className="px-5 py-4">
                    <p className="text-[14px] text-[#17191c]">
                      {prospect.city ?? "—"}
                      {prospect.stateProvince ? `, ${prospect.stateProvince}` : ""}
                    </p>
                    {prospect.caslScope ? (
                      <span className="mt-1 inline-block rounded-full border border-[#17191c] px-2 py-px text-[10.5px] uppercase tracking-[0.08em] text-[#17191c]">
                        CASL
                      </span>
                    ) : null}
                  </td>
                  <td className="px-5 py-4 text-[14px] tabular-nums text-[#17191c]">
                    {formatRevenue(prospect.revenueEstimateUsd)}
                    <span className="ml-1 text-[11px] text-[#a3a6af]">{prospect.revenueConfidence}</span>
                  </td>
                  <td className="px-5 py-4">
                    {prospect.score ? (
                      <div className="w-[110px]">
                        <div className="flex items-baseline justify-between">
                          <span className="text-[15px] font-medium tabular-nums text-[#17191c]">
                            {prospect.score.qlvScore}
                          </span>
                          <span className="tag">{prospect.score.band}</span>
                        </div>
                        <div className="qlv-track mt-1.5">
                          <div className="qlv-fill" style={{ width: bandWidth(prospect.score.qlvScore) }} />
                        </div>
                      </div>
                    ) : (
                      <span className="text-[13px] text-[#a3a6af]">not scored</span>
                    )}
                  </td>
                  <td className="px-5 py-4">
                    {prospect.dispatch ? (
                      <span className="text-[13px] text-[#777b86]">
                        {prospect.dispatch.channel === "channel_a_automated_email" ? "Channel A" : "Channel B"} ·{" "}
                        <span className={prospect.dispatch.status === "sent" ? "text-[#17191c]" : ""}>
                          {prospect.dispatch.status}
                        </span>
                      </span>
                    ) : prospect.ingestion === "filtered" ? (
                      <span className="text-[13px] text-[#a3a6af]" title={prospect.filterReason ?? ""}>
                        filtered
                      </span>
                    ) : (
                      <span className="text-[13px] text-[#a3a6af]">queued</span>
                    )}
                  </td>
                  <td className="px-5 py-4">
                    <div className="flex justify-end gap-2" onClick={(event) => event.stopPropagation()}>
                      <button
                        className="pill pill-ghost pill-small"
                        disabled={isBusy || prospect.ingestion === "filtered"}
                        onClick={() => onScore(prospect)}
                      >
                        {isBusy ? "…" : prospect.score ? "Rescore" : "Score"}
                      </button>
                      <button
                        className="pill pill-dark pill-small"
                        disabled={isBusy || !prospect.score || Boolean(prospect.dispatch)}
                        onClick={() => onDispatch(prospect)}
                      >
                        Dispatch
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
