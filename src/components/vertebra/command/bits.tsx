/**
 * Enclave atom library — Monochromatic Defense Neumorphism (DESIGN.md).
 * Pristine white elevation on the #F4F5F7 canvas, pitch-black controls,
 * gunmetal micro-type, status color used only as high-density micro-dots.
 */
"use client";

import { useEffect, useState, type ReactNode } from "react";
import { HEAT_BAR, HEAT_TEXT, heatLevel } from "@/lib/vertebra/command";

/* ---------------------------------------------------------------- tokens -- */

export const GUNMETAL = "text-[#5F646D]";

/* ---------------------------------------------------------------- labels -- */

export function SectionLabel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <p className={`font-mono text-[10.5px] font-medium uppercase tracking-[0.22em] text-[#5F646D] ${className}`}>
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
  tone?: "default" | "raised" | "inverted" | "outline" | "well";
  className?: string;
}) {
  const tones = {
    default: "bg-[#F0F1F3] text-[#3A3F46] border border-black/[0.04]",
    well: "bg-[#EBEDEF] text-[#08080A] border border-black/[0.05]",
    raised: "bg-white text-[#08080A] border border-black/[0.07] shadow-[2px_2px_6px_rgba(0,0,0,0.05),-2px_-2px_6px_rgba(255,255,255,0.9)]",
    inverted: "bg-[#08080A] text-white border border-[#08080A]",
    outline: "bg-transparent text-[#5F646D] border border-black/10",
  } as const;
  return (
    <span
      className={`inline-flex h-[22px] items-center gap-1.5 rounded-full px-2.5 font-mono text-[10.5px] font-medium uppercase tracking-[0.08em] ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

/* ---------------------------------------------------------------- status -- */

/** Defense status micro-dot — System Green / Alert Amber / AST Veto Red, sparingly. */
export function LiveDot({
  level = "live",
  className = "",
}: {
  level?: "live" | "idle" | "warn" | "fail";
  className?: string;
}) {
  const color =
    level === "live" ? "bg-[#00C853]" : level === "warn" ? "bg-[#FF9100]" : level === "fail" ? "bg-[#FF1744]" : "bg-[#A6ABB2]";
  return <span className={`inline-block size-2 shrink-0 rounded-full ${color} ${level === "live" ? "cc-pulse-dot" : ""} ${className}`} />;
}

/* ------------------------------------------------------------------- HUD -- */

/** Live ping latency — jitters around the node baseline. */
export function useLatency(base = 14, spread = 8): number {
  const [ms, setMs] = useState(base);
  useEffect(() => {
    const t = setInterval(() => setMs(Math.max(4, base + Math.round((Math.random() - 0.45) * spread))), 2800);
    return () => clearInterval(t);
  }, [base, spread]);
  return ms;
}

/** Deterministic zero-trust hash fragment per node. */
export function hashFragment(seed: string): string {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).slice(0, 4);
}

/**
 * System telemetry overlay — top-right corner micro-badges:
 * NODE // AST-04 · LATENCY: 14ms · ENCLAVE: SECURE · SHA-256 ·8f3a
 */
export function HudMeta({
  node = "AST-04",
  latencyBase,
  hash,
  secure = true,
  className = "",
}: {
  node?: string;
  latencyBase?: number;
  hash?: string;
  secure?: boolean;
  className?: string;
}) {
  const ms = useLatency(latencyBase ?? 10 + (hashFragment(node).charCodeAt(0) % 9));
  return (
    <span className={`inline-flex shrink-0 items-center gap-2.5 font-mono text-[9.5px] font-medium uppercase tracking-[0.14em] text-[#5F646D] ${className}`}>
      <span className="hidden xl:inline">NODE // {node}</span>
      <span className="hidden sm:inline tabular-nums">LATENCY: {ms}ms</span>
      <span className="inline-flex items-center gap-1.5">
        <span className={`size-1.5 rounded-full ${secure ? "bg-[#00C853] cc-pulse-dot" : "bg-[#FF9100]"}`} />
        {secure ? "ENCLAVE: SECURE" : "SYNCING"}
      </span>
      {hash && <span className="hidden lg:inline">SHA-256 ·{hash}</span>}
    </span>
  );
}

/** Geo-IP regional badge — Houston · Chicago · Toronto · Vancouver monitoring ring. */
export function GeoBadge({ city, live = true, className = "" }: { city: string; live?: boolean; className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border border-black/[0.06] bg-[#F0F1F3] px-3 py-1 font-mono text-[9.5px] font-medium uppercase tracking-[0.12em] text-[#3A3F46] ${className}`}
    >
      <span className={`size-1.5 rounded-full ${live ? "bg-[#00C853]" : "bg-[#A6ABB2]"}`} />
      GEO // {city}
    </span>
  );
}

/** ERP stack tag — the tactile pill from the DESIGN.md blueprint. */
export function ErpBadge({ erp, className = "" }: { erp: string; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 rounded-full border border-black/5 bg-[#F0F1F3] px-3 py-1 ${className}`}>
      <span className="size-2 rounded-full bg-emerald-500 animate-pulse" />
      <span className="text-[11.5px] font-semibold tracking-tight text-[#08080A]">{erp}</span>
    </span>
  );
}

/* ------------------------------------------------------------------ score -- */

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
      <span className={`font-display font-semibold tabular-nums tracking-[-0.03em] ${dims} ${score == null ? "text-[#C6CAD0]" : text}`}>
        {score ?? "—"}
      </span>
      {band != null && (
        <span className="mt-1.5 font-mono text-[9.5px] uppercase tracking-[0.18em] text-[#5F646D]">{band}</span>
      )}
    </div>
  );
}

export function PriorityBar({ value, max, heat }: { value: number; max: number; heat: ReturnType<typeof heatLevel> }) {
  const pct = Math.max(4, Math.min(100, Math.round((value / Math.max(1, max)) * 100)));
  return (
    <div className="h-[3px] w-full overflow-hidden rounded-full bg-[#E4E6EA]">
      <div className={`h-full rounded-full ${HEAT_BAR[heat]}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

/* ------------------------------------------------------------------ cards -- */

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
      className={`neu ${interactive ? "cursor-pointer transition-all duration-150 hover:-translate-y-[1px] hover:shadow-[12px_14px_28px_rgba(0,0,0,0.07),-12px_-12px_24px_rgba(255,255,255,0.95)]" : ""} ${className}`}
    >
      {children}
    </div>
  );
}

/** Deep onyx control surface — guarantee banners, threat matrix, machine output. */
export function InkPanel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`ink ${className}`}>{children}</div>;
}

export function KpiCard({
  label,
  value,
  sub,
  hot = false,
  node,
  children,
  onClick,
}: {
  label: string;
  value: ReactNode;
  sub?: string;
  hot?: boolean;
  node?: string;
  children?: ReactNode;
  onClick?: () => void;
}) {
  return (
    <SoftCard
      onClick={onClick}
      className={`neu-lg flex-1 px-6 py-5 ${onClick ? "cursor-pointer" : ""} ${hot ? "border-black/[0.10]" : ""}`}
    >
      <div className="flex items-center justify-between gap-3">
        <SectionLabel>{label}</SectionLabel>
        {node && (
          <span
            title={`node // ${node.toLowerCase()}`}
            className="inline-flex shrink-0 items-center gap-1.5 font-mono text-[9px] font-medium uppercase tracking-[0.14em] text-[#5F646D]"
          >
            <span className="size-1.5 rounded-full bg-[#00C853] cc-pulse-dot" />
            ENCLAVE: SECURE
          </span>
        )}
      </div>
      <p
        className={`mt-3 font-display text-[30px] font-semibold leading-none tracking-[-0.03em] tabular-nums ${
          hot ? "text-[#08080A]" : "text-[#1A1D21]"
        }`}
      >
        {value}
      </p>
      {sub && <p className="mt-2.5 line-clamp-2 text-[12px] leading-relaxed text-[#5F646D]">{sub}</p>}
      {children}
    </SoftCard>
  );
}

export function Kv({ k, v, mono = true }: { k: string; v: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="shrink-0 font-mono text-[10.5px] uppercase tracking-[0.14em] text-[#5F646D]">{k}</span>
      <span className={`text-right text-[13px] text-[#1A1D21] ${mono ? "font-mono tabular-nums" : ""}`}>{v}</span>
    </div>
  );
}

export function EmptyHint({ children }: { children: ReactNode }) {
  return (
    <div className="neu-well flex flex-col items-center justify-center gap-2 rounded-2xl px-6 py-10 text-center">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[#8A8F97]">{children}</p>
    </div>
  );
}

/* ------------------------------------------------------------- controls -- */

/** Soft circular tactile button — high-contrast arrow for command stepping. */
export function ArrowButton({
  onClick,
  direction = "right",
  dark = true,
  label,
  className = "",
}: {
  onClick?: () => void;
  direction?: "left" | "right" | "up" | "down";
  dark?: boolean;
  label: string;
  className?: string;
}) {
  const glyph = direction === "left" ? "←" : direction === "up" ? "↑" : direction === "down" ? "↓" : "→";
  return (
    <button
      onClick={onClick}
      aria-label={label}
      className={`tactile-btn size-10 text-[16px] ${
        dark ? "bg-[#08080A] text-white hover:bg-[#1D2025]" : "bg-white text-[#08080A] shadow-[4px_4px_10px_rgba(0,0,0,0.08),-4px_-4px_10px_rgba(255,255,255,0.95)] hover:bg-[#F6F7F8]"
      } ${className}`}
    >
      {glyph}
    </button>
  );
}

/** Solid pitch-black pill — the primary executive action. */
export function PillButton({
  children,
  onClick,
  tone = "dark",
  className = "",
  href,
  disabled = false,
}: {
  children: ReactNode;
  onClick?: () => void;
  tone?: "dark" | "ghost" | "well";
  className?: string;
  href?: string;
  disabled?: boolean;
}) {
  const cls = `inline-flex h-9 items-center justify-center rounded-full px-4 font-mono text-[11px] font-medium uppercase tracking-[0.14em] transition-all disabled:opacity-40 ${
    tone === "dark"
      ? "bg-[#08080A] text-white hover:bg-[#1D2025]"
      : tone === "ghost"
        ? "border border-[#08080A]/25 text-[#08080A] hover:border-[#08080A]"
        : "bg-[#F0F1F3] text-[#08080A] hover:bg-[#E7E9EC]"
  } ${className}`;
  if (href) {
    return (
      <a href={href} onClick={onClick} className={cls}>
        {children}
      </a>
    );
  }
  return (
    <button onClick={onClick} disabled={disabled} className={cls}>
      {children}
    </button>
  );
}
