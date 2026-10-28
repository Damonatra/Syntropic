# SYNTRROPIC UI/UX SPECIFICATION — DEFENSE ARCHITECTURE EDITION (`DESIGN.md`)

## Visual Identity: Monochromatic Defense Neumorphism
The Syntropic design language fuses high-legibility neo-grotesque typography, soft-tactile neumorphic gray-black card surfaces, and high-density tactical command features reminiscent of modern defense OS environments (Anduril Lattice, Palantir Gotham/Foundry, and Slade Technologies defense interfaces).

---

## 1. Typography & Aesthetic Reference

- Primary Font Family: **Neue Haas Grotesk** / **Space Grotesk** / **Inter Tight** (High-contrast, tight tracking `-0.03em`, sharp executive weight hierarchy).
- Monospace Font (Tactical Data / Coordinate Feeds): **JetBrains Mono** or **SF Mono** (`font-weight: 500`).
- Color Scheme:
  - Base Canvas: Soft Tactile Grey (`#F0F1F3` to `#F4F5F7`).
  - Card Containers: Pristine Elevated White (`#FFFFFF`) with soft shadow elevation.
  - Primary Typography & Solid Controls: Deep Onyx / Pitch Black (`#08080A`)[cite: 3].
  - Muted Subtext & Micro-headers: Muted Gunmetal (`#5F646D`)[cite: 3].
  - Defense Status Accents: Monochromatic Pulsing Status Rings (System Green `#00C853`, Alert Amber `#FF9100`, AST Veto Red `#FF1744` used sparingly as high-density status micro-dots).

---

## 2. Tactical Defense & Enterprise Features (Palantir / Anduril / Slade Vibe)

Every dashboard view and portal component in Syntropic must feel like an operational command node:

1. **System Telemetry & Coordinate Overlays (AST Enclave Node):**
   - Top-right corner of cards feature micro-badges showing system status, ping latency (`12ms`), zero-trust hash (`SHA-256`), and Geo-IP telemetry (`LAT/LONG: 1.2921° S, 36.8219° E`).

2. **Tactical Target Cards (Industrial Lead & Margin Threat Scoring):**
   - Incorporate sharp dual-weight headline text ("What Our Clients Say" / "Target Acquisition Vector")[cite: 3].
   - Micro pill badges (`Ailitic`, `Buildwave`, `InHive`) replaced with real-time ERP Stack Tags (`Prophet 21`, `Infor`, `SAP`) and Threat Clearance Badges[cite: 3].

3. **Autonomous Command Sliders & Navigation:**
   - Soft circular tactile buttons with high-contrast icon arrows (`←` `→`) for stepping through multi-agent LangGraph execution chains or quote audit logs[cite: 3].
   - Monochromatic HUD-style telemetry bars showing live compute footprint, vector search index status (Qdrant), and AST security veto checks.

4. **Quote Defense Threat Matrix:**
   - Display margin leakage data like a tactical radar: clean numerical metrics (`$120,700.00`, `92%`), line-item anomaly detection, and automated execution overrides.

---

## 3. Tailwind CSS Component Blueprints

```tsx
// Tactical Metric Card Component (Neue Haas Grotesk + Defense HUD Badge)
export function DefenseMetricTile({ label, metric, erpTag, telemetryHash }) {
  return (
    <div className="bg-[#FFFFFF] rounded-[28px] p-8 shadow-[12px_12px_24px_rgba(0,0,0,0.04),-12px_-12px_24px_rgba(255,255,255,0.8)] border border-black/[0.03] transition-all hover:scale-[1.01]">
      {/* Top Telemetry & ERP Pill */}
      <div className="flex justify-between items-center mb-6">
        <span className="text-[11px] font-mono tracking-wider text-[#5F646D] uppercase">
          NODE // {telemetryHash}
        </span>
        <div className="px-4 py-1.5 rounded-full bg-[#F0F1F3] border border-black/5 flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          <span className="text-[12px] font-bold text-[#08080A] tracking-tight">{erpTag}</span>
        </div>
      </div>

      {/* Main Quote / Margin Statement */}
      <h3 className="font-['Space_Grotesk'] text-[24px] leading-[1.3] font-medium text-[#08080A] tracking-tight mb-8">
        "{label}"
      </h3>

      {/* Bottom Executive Detail */}
      <div className="pt-6 border-t border-black/5 flex justify-between items-end">
        <div>
          <p className="font-bold text-[15px] text-[#08080A]">{metric.title}</p>
          <p className="text-[12px] text-[#5F646D]">{metric.subtitle}</p>
        </div>
        <button className="w-10 h-10 rounded-full bg-[#08080A] text-white flex items-center justify-center hover:bg-black/80 transition-colors">
          →
        </button>
      </div>
    </div>
  );
}