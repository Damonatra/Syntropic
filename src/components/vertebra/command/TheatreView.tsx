/** THEATRE — full-screen tactical plotting board for Module 7 spatial clusters. */
"use client";

import { useMemo, useState } from "react";
import { Chip, EmptyHint, SectionLabel, SoftCard } from "./bits";
import { heatLevel, money, type ClusterShape, type CommandLead, type CommandSnapshot } from "@/lib/vertebra/command";

const W = 1200;
const H = 640;
const PAD = 64;
const LNG_MIN = -97;
const LNG_MAX = 45;
const LAT_MIN = -6;
const LAT_MAX = 47;

function px(lng: number): number {
  return PAD + ((lng - LNG_MIN) / (LNG_MAX - LNG_MIN)) * (W - 2 * PAD);
}
function py(lat: number): number {
  return PAD + ((LAT_MAX - lat) / (LAT_MAX - LAT_MIN)) * (H - 2 * PAD);
}

const CORRIDOR: Array<[number, number]> = [
  [-2.2717, 40.902], // Lamu
  [0.35, 38.5], // Isiolo
  [-0.3031, 36.08], // Nakuru
];

const HEAT_FILL: Record<ReturnType<typeof heatLevel>, string> = {
  critical: "#fafafa",
  hot: "#c9c9d0",
  warm: "#8b8b93",
  cool: "#4a4a52",
};

export function TheatreView({
  snap,
  onOpenDossier,
}: {
  snap: CommandSnapshot;
  onOpenDossier: (lead: CommandLead) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);

  const leadsWithGeo = useMemo(() => snap.leads.filter((l) => l.latitude != null && l.longitude != null), [snap.leads]);
  const cluster = selected ? snap.clusters.find((c) => c.id === selected) ?? null : null;

  const totalStake = useMemo(() => snap.leads.reduce((s, l) => s + (l.leakageUsd ?? 0), 0), [snap.leads]);

  const graticule = useMemo(() => {
    const lines: Array<{ x1: number; y1: number; x2: number; y2: number; label: string; lx: number; ly: number }> = [];
    for (let lng = -90; lng <= 40; lng += 10) {
      const x = px(lng);
      lines.push({ x1: x, y1: PAD - 22, x2: x, y2: H - PAD + 22, label: `${lng}°E`, lx: x, ly: H - PAD + 38 });
    }
    for (let lat = 0; lat <= 40; lat += 10) {
      const y = py(lat);
      lines.push({ x1: PAD - 22, y1: y, x2: W - PAD + 22, y2: y, label: `${lat}°N`, lx: PAD - 34, ly: y + 3 });
    }
    return lines;
  }, []);

  return (
    <div className="flex h-full flex-col overflow-y-auto cc-scroll p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <SectionLabel>Theatre board — Module 7 spatial clusters</SectionLabel>
          <p className="mt-2 font-serif text-[22px] tracking-[-0.01em] text-[#f2f2f4]">
            Four theatres · {leadsWithGeo.length} plotted leads · {money(totalStake)} at stake
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setSelected(null)}
            className={`h-8 rounded-xl px-3.5 font-mono text-[10.5px] uppercase tracking-[0.12em] transition-colors ${
              selected == null ? "bg-[#fafafa] text-[#0a0a0b]" : "border border-[#232327] text-[#8b8b93] hover:text-[#d6d6db]"
            }`}
          >
            All theatres
          </button>
          {snap.clusters.map((c) => (
            <button
              key={c.id}
              onClick={() => setSelected(c.id === selected ? null : c.id)}
              className={`h-8 rounded-xl px-3.5 font-mono text-[10.5px] uppercase tracking-[0.12em] transition-colors ${
                selected === c.id ? "bg-[#fafafa] text-[#0a0a0b]" : "border border-[#232327] text-[#8b8b93] hover:text-[#d6d6db]"
              }`}
            >
              {c.clusterName}
            </button>
          ))}
        </div>
      </div>

      <SoftCard className="mt-5 shrink-0 overflow-hidden p-2">
        <svg viewBox={`0 0 ${W} ${H}`} className="block w-full select-none" style={{ aspectRatio: "1200 / 640" }} role="img" aria-label="Tactical cluster map">
          <defs>
            <radialGradient id="ringGlow" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#fafafa" stopOpacity="0.05" />
              <stop offset="100%" stopColor="#fafafa" stopOpacity="0" />
            </radialGradient>
          </defs>

          <rect x="0" y="0" width={W} height={H} fill="#0d0d0f" rx="14" />

          {/* graticule */}
          {graticule.map((g, i) => (
            <g key={i}>
              <line x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2} stroke="#17171a" strokeWidth="1" />
              <text x={g.lx} y={g.ly} fill="#33333a" fontSize="10" fontFamily="ui-monospace, monospace" textAnchor="middle">
                {g.label}
              </text>
            </g>
          ))}

          {/* LAPPSET corridor */}
          <polyline
            points={CORRIDOR.map(([lat, lng]) => `${px(lng)},${py(lat)}`).join(" ")}
            fill="none"
            stroke="#2e2e34"
            strokeWidth="1.5"
            strokeDasharray="5 6"
          />
          <text x={px(37.2)} y={py(-0.9)} fill="#3f3f46" fontSize="9.5" fontFamily="ui-monospace, monospace" letterSpacing="2" transform={`rotate(-24 ${px(37.2)} ${py(-0.9)})`}>
            LAPPSET CORRIDOR
          </text>

          {/* cluster rings */}
          {snap.clusters.map((c) => {
            const cx = px(c.centroidLng);
            const cy = py(c.centroidLat);
            const r = Math.max(26, Math.sqrt(c.memberIds.length + 2) * 15);
            const active = selected == null || selected === c.id;
            return (
              <g key={c.id} opacity={active ? 1 : 0.22} onClick={() => setSelected(c.id === selected ? null : c.id)} className="cursor-pointer">
                <circle cx={cx} cy={cy} r={r * 1.9} fill="url(#ringGlow)" />
                <circle cx={cx} cy={cy} r={r} fill="none" stroke="#3a3a41" strokeWidth="1.2" strokeDasharray="3 4" />
                <circle cx={cx} cy={cy} r={4} fill="#8b8b93" />
                <text x={cx} y={cy - r - 10} fill={selected === c.id ? "#fafafa" : "#8b8b93"} fontSize="11" fontFamily="ui-monospace, monospace" letterSpacing="1.5" textAnchor="middle">
                  {c.clusterName.toUpperCase()}
                </text>
                <title>{`${c.clusterName} — ${c.memberIds.length} members`}</title>
              </g>
            );
          })}

          {/* lead dots */}
          {leadsWithGeo.map((lead) => {
            const heat = heatLevel(lead.score?.qlvScore ?? null);
            const active = selected == null || (lead.clusterId != null && lead.clusterId === selected);
            const x = px(lead.longitude!);
            const y = py(lead.latitude!);
            return (
              <g
                key={lead.id}
                opacity={active ? 1 : 0.18}
                className="cursor-pointer"
                onClick={(e) => {
                  e.stopPropagation();
                  const l = snap.leads.find((x2) => x2.id === lead.id);
                  if (l) onOpenDossier(l);
                }}
              >
                {heat === "critical" && <circle cx={x} cy={y} r={4} fill="none" stroke="#fafafa" strokeWidth="1" className="cc-svg-pulse" />}
                <circle cx={x} cy={y} r={heat === "critical" ? 5.5 : 4.5} fill={HEAT_FILL[heat]} stroke="#0a0a0b" strokeWidth="1.5" />
                <title>{`${lead.name} — QLV ${lead.score?.qlvScore ?? "—"} — ${lead.clusterName ?? "unclustered"}`}</title>
              </g>
            );
          })}

          {/* luminance legend */}
          <g fontFamily="ui-monospace, monospace" fontSize="9.5" letterSpacing="1">
            <text x={W - PAD} y={PAD - 26} fill="#5c5c64" textAnchor="end">
              QLV LADDER
            </text>
            {(["critical", "hot", "warm", "cool"] as const).map((h, i) => (
              <g key={h} transform={`translate(${W - PAD - 210 + i * 56}, ${PAD - 14})`}>
                <circle cx={0} cy={0} r={3.5} fill={HEAT_FILL[h]} />
                <text x={9} y={3.5} fill="#4a4a52">
                  {h === "critical" ? "85+" : h === "hot" ? "72+" : h === "warm" ? "50+" : "<50"}
                </text>
              </g>
            ))}
          </g>
        </svg>
      </SoftCard>

      {/* readout */}
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <SoftCard className="px-5 py-4">
          {cluster ? (
            <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
              <div>
                <SectionLabel>Selected theatre</SectionLabel>
                <p className="mt-1.5 font-serif text-[19px] text-[#f2f2f4]">{cluster.clusterName}</p>
              </div>
              <div>
                <SectionLabel>Anchor</SectionLabel>
                <p className="mt-1.5 font-mono text-[13px] text-[#d6d6db]">
                  {cluster.anchorCity ?? "—"}, {cluster.anchorCountry ?? "—"}
                </p>
              </div>
              <div>
                <SectionLabel>Density</SectionLabel>
                <p className="mt-1.5 font-mono text-[13px] tabular-nums text-[#d6d6db]">{cluster.memberIds.length} leads · {Math.round(cluster.radiusM / 1000)}km radius</p>
              </div>
              <div>
                <SectionLabel>Critical band</SectionLabel>
                <p className="mt-1.5 font-mono text-[13px] tabular-nums text-[#d6d6db]">{cluster.hotCount}</p>
              </div>
              <div>
                <SectionLabel>Leakage at stake</SectionLabel>
                <p className="mt-1.5 font-mono text-[13px] tabular-nums text-[#fafafa]">{money(cluster.leakageUsd)}</p>
              </div>
            </div>
          ) : (
            <p className="text-[13px] leading-relaxed text-[#8b8b93]">
              Select a theatre — Houston PVF, Midwest Electrical, the Greater Toronto HVAC arc, or the LAPPSET corridor — to focus the board.
              Cluster hooks localize outreach: &ldquo;we&rsquo;re onboarding two PVF distributors in the Gulf Coast corridor this month.&rdquo;
            </p>
          )}
        </SoftCard>
        <SoftCard className="px-5 py-4">
          <SectionLabel className="mb-2">Outreach hook · localized</SectionLabel>
          {cluster ? (
            <p className="font-serif text-[14.5px] italic leading-relaxed text-[#d6d6db]">
              &ldquo;Hey [Name], we&rsquo;re onboarding two {cluster.verticalFocus?.replace(/_/g, " ") ?? "distribution"} companies in the{" "}
              {cluster.clusterName} region this month — worth 15 minutes to see what their quote flow looks like?&rdquo;
            </p>
          ) : (
            <EmptyHint>Select a theatre to arm the local hook</EmptyHint>
          )}
        </SoftCard>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 pb-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#3f3f46]">members:</span>
        {(cluster ? snap.leads.filter((l) => l.clusterId === cluster.id) : snap.clusters.flatMap((c) => snap.leads.filter((l) => l.clusterId === c.id)))
          .slice(0, 24)
          .map((l) => (
            <Chip key={l.id} tone={heatLevel(l.score?.qlvScore ?? null) === "critical" ? "inverted" : "outline"} className="cursor-pointer" >
              <span onClick={() => onOpenDossier(l)}>{l.name}</span>
            </Chip>
          ))}
      </div>
    </div>
  );
}
