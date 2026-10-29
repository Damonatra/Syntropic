/**
 * Enclave atom library — CUSTO dark achromatic system (DESIGN.md).
 * Obsidian canvas #0B0C0B · hairline panels #131513 · anodized graphite
 * objects #4B514D · brushed steel ink #8E9194. Zero chromatic color:
 * status reads as luminance only (brighter = hotter, inversion = emphasis).
 */
"use client";

import { useEffect, useState, type ReactNode } from "react";
import { HEAT_BAR, HEAT_TEXT, heatLevel } from "@/lib/vertebra/command";

/* ---------------------------------------------------------------- tokens -- */

export const GUNMETAL = "text-[#8E9194]";

/* ---------------------------------------------------------------- labels -- */

export function SectionLabel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <p className={`font-mono text-[10.5px] font-medium uppercase tracking-[0.22em] text-[#8E9194] ${className}`}>
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
    default: "bg-[#1A1D1A] text-[#C9CCC7] border border-white/[0.08]",
    well: "bg-[#222522] text-[#F4F5F2] border border-white/[0.10]",
    raised: "bg-[#222522] text-[#F4F5F2] border border-white/[0.16]",
    inverted: "bg-[#F4F5F2] text-[#0B0C0B] border border-[#F4F5F2]",
    outline: "bg-transparent text-[#8E9194] border border-white/15",
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

/** Defense status micro-dot — luminance only: white live · steel idle · blink fail. */
export function LiveDot({
  level = "live",
  className = "",
}: {
  level?: "live" | "idle" | "warn" | "fail";
  className?: string;
}) {
  const color =
    level === "live" ? "bg-[#F4F5F2]" : level === "warn" ? "bg-[#8E9194]" : level === "fail" ? "bg-[#F4F5F2] cc-blink" : "bg-[#5F6460]";
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
 * tone: "steel" on obsidian panels · "graphite" on anodized objects · "light" on the gunmetal band.
 */
export function HudMeta({
  node = "AST-04",
  latencyBase,
  hash,
  secure = true,
  tone = "steel",
  className = "",
}: {
  node?: string;
  latencyBase?: number;
  hash?: string;
  secure?: boolean;
  tone?: "steel" | "graphite" | "light";
  className?: string;
}) {
  const ms = useLatency(latencyBase ?? 10 + (hashFragment(node).charCodeAt(0) % 9));
  const text = tone === "graphite" ? "text-white/70" : tone === "light" ? "text-[#2E322E]" : "text-[#8E9194]";
  const dot = tone === "light" ? "bg-[#0B0C0B]" : "bg-[#F4F5F2]";
  return (
    <span className={`inline-flex shrink-0 items-center gap-2.5 font-mono text-[9.5px] font-medium uppercase tracking-[0.14em] ${text} ${className}`}>
      <span className="hidden xl:inline">NODE // {node}</span>
      <span className="hidden sm:inline tabular-nums">LATENCY: {ms}ms</span>
      <span className="inline-flex items-center gap-1.5">
        <span className={`size-1.5 rounded-full ${secure ? `${dot} cc-pulse-dot` : "bg-[#8E9194]"}`} />
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
      className={`inline-flex items-center gap-1.5 rounded-full border border-white/[0.12] bg-[#131513] px-3 py-1 font-mono text-[9.5px] font-medium uppercase tracking-[0.12em] text-[#C9CCC7] ${className}`}
    >
      <span className={`size-1.5 rounded-full ${live ? "bg-[#F4F5F2] cc-pulse-dot" : "bg-[#5F6460]"}`} />
      GEO // {city}
    </span>
  );
}

/** ERP stack tag — the tactile pill from the DESIGN.md blueprint. */
export function ErpBadge({ erp, className = "" }: { erp: string; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 rounded-full border border-white/[0.12] bg-[#131513] px-3 py-1 ${className}`}>
      <span className="size-2 rounded-full bg-[#F4F5F2] cc-pulse-dot" />
      <span className="text-[11.5px] font-semibold tracking-tight text-[#E9EBE7]">{erp}</span>
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
      <span className={`font-display font-semibold tabular-nums tracking-[-0.03em] ${dims} ${score == null ? "text-[#3F433F]" : text}`}>
        {score ?? "—"}
      </span>
      {band != null && (
        <span className="mt-1.5 font-mono text-[9.5px] uppercase tracking-[0.18em] text-[#8E9194]">{band}</span>
      )}
    </div>
  );
}

export function PriorityBar({ value, max, heat }: { value: number; max: number; heat: ReturnType<typeof heatLevel> }) {
  const pct = Math.max(4, Math.min(100, Math.round((value / Math.max(1, max)) * 100)));
  return (
    <div className="h-[3px] w-full overflow-hidden rounded-full bg-[#232623]">
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
      className={`neu ${interactive ? "cursor-pointer transition-all duration-150 hover:-translate-y-[1px] hover:border-white/[0.24]" : ""} ${className}`}
    >
      {children}
    </div>
  );
}

/** Anodized graphite object — guarantee banners, threat matrix, machine output. */
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
  delta,
}: {
  label: string;
  value: ReactNode;
  sub?: string;
  hot?: boolean;
  node?: string;
  children?: ReactNode;
  onClick?: () => void;
  /** 24h baseline delta chip — luminance only: good = bright, bad = steel, flat = graphite. */
  delta?: { text: string; tone: "good" | "bad" | "flat" } | null;
}) {
  return (
    <SoftCard
      onClick={onClick}
      className={`neu-lg flex-1 px-6 py-5 ${onClick ? "cursor-pointer" : ""} ${hot ? "border-white/[0.22]" : ""}`}
    >
      <div className="flex items-center justify-between gap-3">
        <SectionLabel>{label}</SectionLabel>
        {node && (
          <span
            title={`node // ${node.toLowerCase()}`}
            className="inline-flex shrink-0 items-center gap-1.5 font-mono text-[9px] font-medium uppercase tracking-[0.14em] text-[#6E736E]"
          >
            <span className="size-1.5 rounded-full bg-[#F4F5F2] cc-pulse-dot" />
            ENCLAVE: SECURE
          </span>
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <p
          className={`font-display text-[30px] font-semibold leading-none tracking-[-0.03em] tabular-nums ${
            hot ? "text-white" : "text-[#E9EBE7]"
          }`}
        >
          {value}
        </p>
        {delta && (
          <span
            title="delta vs the ~24h-ago baseline capture"
            className={`font-mono text-[10px] font-medium uppercase tracking-[0.1em] tabular-nums ${
              delta.tone === "good" ? "text-[#F4F5F2]" : delta.tone === "bad" ? "text-[#8E9194]" : "text-[#5F6460]"
            }`}
          >
            {delta.text}
          </span>
        )}
      </div>
      {sub && <p className="mt-2.5 line-clamp-2 text-[12px] leading-relaxed text-[#8E9194]">{sub}</p>}
      {children}
    </SoftCard>
  );
}

export function Kv({ k, v, mono = true }: { k: string; v: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="shrink-0 font-mono text-[10.5px] uppercase tracking-[0.14em] text-[#8E9194]">{k}</span>
      <span className={`text-right text-[13px] text-[#E9EBE7] ${mono ? "font-mono tabular-nums" : ""}`}>{v}</span>
    </div>
  );
}

export function EmptyHint({ children }: { children: ReactNode }) {
  return (
    <div className="neu-well flex flex-col items-center justify-center gap-2 rounded-lg px-6 py-10 text-center">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[#6E736E]">{children}</p>
    </div>
  );
}

/* ------------------------------------------------------------- controls -- */

/** Circular control — white fill on obsidian, obsidian fill on graphite objects. */
export function ArrowButton({
  onClick,
  direction = "right",
  dark = false,
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
        dark ? "border border-white/25 bg-transparent text-[#F4F5F2] hover:bg-white/10" : "bg-[#F4F5F2] text-[#0B0C0B] hover:bg-white"
      } ${className}`}
    >
      {glyph}
    </button>
  );
}

/** Solid white pill — the primary executive action. Ghost inverts on hover (Custo). */
export function PillButton({
  children,
  onClick,
  tone = "dark",
  className = "",
  href,
  target,
  disabled = false,
}: {
  children: ReactNode;
  onClick?: () => void;
  tone?: "dark" | "ghost" | "well";
  className?: string;
  href?: string;
  target?: string;
  disabled?: boolean;
}) {
  const cls = `inline-flex h-9 items-center justify-center rounded-full px-4 font-mono text-[11px] font-medium uppercase tracking-[0.14em] transition-all disabled:opacity-40 ${
    tone === "dark"
      ? "bg-[#F4F5F2] text-[#0B0C0B] hover:bg-white"
      : tone === "ghost"
        ? "border border-white/30 text-[#F4F5F2] hover:bg-[#F4F5F2] hover:text-[#0B0C0B] hover:border-[#F4F5F2]"
        : "border border-white/[0.10] bg-[#1A1D1A] text-[#C9CCC7] hover:text-[#F4F5F2] hover:border-white/25"
  } ${className}`;
  if (href) {
    return (
      <a href={href} target={target} rel={target === "_blank" ? "noopener" : undefined} onClick={onClick} className={cls}>
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
