"use client";

/** Gestural QLV trend line — Steep-style chart: no axes, no gridlines. */
export function QlvSparkline({ values, className }: { values: number[]; className?: string }) {
  if (values.length < 2) {
    return <div className={`h-[72px] ${className ?? ""}`} aria-hidden />;
  }
  const width = 220;
  const height = 72;
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 100);
  const points = values.map((value, index) => {
    const x = (index / (values.length - 1)) * (width - 8) + 4;
    const y = height - 8 - ((value - min) / (max - min || 1)) * (height - 20);
    return [x, y] as const;
  });
  const path = points
    .map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");
  const last = points[points.length - 1];

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      role="img"
      aria-label="Quote leakage score trend"
    >
      <path d={path} fill="none" stroke="#17191c" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r="3.5" fill="#17191c" />
    </svg>
  );
}
