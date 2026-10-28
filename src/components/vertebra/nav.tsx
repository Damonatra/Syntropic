"use client";

import { useCallback } from "react";

export function Nav({ onAddProspect }: { onAddProspect: () => void }) {
  const scrollTo = useCallback((id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  return (
    <header className="sticky top-0 z-40 bg-white/85 backdrop-blur-md">
      <nav className="mx-auto flex h-16 max-w-[1200px] items-center justify-between px-5 sm:px-8">
        <button
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          className="font-display text-[22px] tracking-[-0.01em] text-[#17191c]"
          aria-label="Vertebra home"
        >
          vertebra
        </button>

        <div className="hidden items-center gap-8 md:flex" aria-label="Sections">
          {[
            ["Pipeline", "pipeline"],
            ["Scoring", "scoring"],
            ["Dispatch", "dispatch"],
          ].map(([label, id]) => (
            <button key={id} onClick={() => scrollTo(id)} className="text-link">
              {label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-4">
          <button onClick={() => scrollTo("dispatch")} className="hidden text-[15px] text-[#777b86] hover:text-[#17191c] sm:inline">
            Channel status ↗
          </button>
          <button className="pill pill-dark !h-10 text-[14px]" onClick={onAddProspect}>
            Add prospect
          </button>
        </div>
      </nav>
    </header>
  );
}
