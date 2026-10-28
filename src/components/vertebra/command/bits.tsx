/** Command centre shared atoms — soft-tactile, greys and blacks only. */
"use client";

import type { ReactNode } from "react";
import { HEAT_BAR, HEAT_TEXT, heatLevel } from "@/lib/vertebra/command";

export function SectionLabel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <p className={`font-mono text-[10.5px] font-medium uppercase tracking-[0.22em] text-[#5c5c64] ${className}`}>
      {children}
    </p>
  );
}

export function Chip({
  children,
  tone = "default",
  className = "",
}: {
  children: ReactNode;
  tone?: "default" | "raised" | "inverted" | "outline";
  className?: string;
}) {
  const tones = {
    default: "bg-[#1a1a1e] text-[#b6b6bd]",
    raised: "bg-[#232327] text-[#e4e4e8]",
    inverted: "bg-[#fafafa] text-[#0a0a0b]",
    outline: "border border-[#2a2a2f] text-[#8b8b93]",
  } as const;
  return (
    <span
      className={`inline-flex h-[22px] items-center rounded-full px-2.5 font-mono text-[10.5px] uppercase tracking-[0.08em] ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function LiveDot({ level = "live", className = "" }: { level?: "live" | "idle" | "warn" | "fail"; className?: string }) {
  const color =
    level === "live" ? "bg-[#fafafa]" : level === "warn" ? "bg-[#8b8b93]" : level === "fail" ? "bg-[#3a3a41]" : "bg-[#55555c]";
  return <span className={`inline-block size-2 shrink-0 rounded-full ${color} ${level === "live" ? "cc-pulse-dot" : ""} ${className}`} />;
}

export function ScoreBlock({
  score,
  band,
  size = "md",
}: {
  score: number | null;
  band: string | null;
  size?: "sm" | "md" | "lg";
}) {
  const heat = heatLevel(score);
  const text = HEAT_TEXT[heat];
  const dims = size === "lg" ? "text-[34px]" : size === "sm" ? "text-[18px]" : "text-[26px]";
  return (
    <div className="flex flex-col items-start leading-none">
      <span className={`font-mono font-medium tabular-nums ${dims} ${score == null ? "text-[#3f3f46]" : text}`}>
        {score ?? "—"}
      </span>
      {band != null && (
        <span className="mt-1.5 font-mono text-[9.5px] uppercase tracking-[0.18em] text-[#5c5c64]">{band}</span>
      )}
    </div>
  );
}

export function PriorityBar({ value, max, heat }: { value: number; max: number; heat: ReturnType<typeof heatLevel> }) {
  const pct = Math.max(4, Math.min(100, Math.round((value / Math.max(1, max)) * 100)));
  return (
    <div className="h-[3px] w-full overflow-hidden rounded-full bg-[#1c1c1f]">
      <div className={`h-full rounded-full ${HEAT_BAR[heat]}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Kv({ k, v, mono = true }: { k: string; v: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="shrink-0 font-mono text-[10.5px] uppercase tracking-[0.14em] text-[#5c5c64]">{k}</span>
      <span className={`text-right text-[13px] text-[#d6d6db] ${mono ? "font-mono tabular-nums" : ""}`}>{v}</span>
    </div>
  );
}

export function SoftCard({
  children,
  className = "",
  onClick,
  interactive = false,
}: {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
  interactive?: boolean;
}) {
  return (
    <div
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
      className={`rounded-2xl border border-[#1e1e22] bg-[#121214] shadow-[inset_0_1px_0_rgba(255,255,255,0.02),0_10px_30px_-18px_rgba(0,0,0,0.8)] ${
        interactive ? "cursor-pointer transition-colors duration-150 hover:border-[#2e2e34]" : ""
      } ${className}`}
    >
      {children}
    </div>
  );
}

export function KpiCard({
  label,
  value,
  sub,
  hot = false,
  onClick,
}: {
  label: string;
  value: ReactNode;
  sub?: string;
  hot?: boolean;
  onClick?: () => void;
}) {
  return (
    <SoftCard className={`flex-1 px-5 py-4 ${onClick ? "cursor-pointer transition-colors hover:border-[#2e2e34]" : ""}`} onClick={onClick}>
      <SectionLabel>{label}</SectionLabel>
      <p className={`mt-2 font-mono text-[28px] font-medium leading-none tabular-nums ${hot ? "text-[#fafafa]" : "text-[#e4e4e8]"}`}>
        {value}
      </p>
      {sub && <p className="mt-2 truncate text-[12px] text-[#8b8b93]">{sub}</p>}
    </SoftCard>
  );
}

export function EmptyHint({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[#232327] px-6 py-10 text-center">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[#4a4a52]">{children}</p>
    </div>
  );
}
