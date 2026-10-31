/**
 * Sending domains — the console face of the egress ledger.
 *
 * Renders exactly the math the mailer gate enforces: registration, DNS
 * status, warmup day + cap, sends counted today, queued backlog, 7-day
 * hard-bounce rate. The operator's hands on the ramp live here (register a
 * domain, flip DNS status, start/pause warmup) — the gate itself stays in
 * the mailer and never trusts this panel. Zero color law holds: state is
 * words and chips, not traffic lights.
 *
 * Self-contained fetch — the command snapshot polls its own route; the
 * ledger has its own cadence and its own empty state ("nothing registered:
 * the gate refuses everything unledgered").
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { Chip, PillButton, SectionLabel, SoftCard } from "./bits";
import { onConsoleRefresh, requestConsoleRefresh } from "@/lib/vertebra/console-bus";

interface DomainRow {
  domain: string;
  role: string;
  dnsStatus: string;
  status: string;
  warmupStartedAt: string | null;
  warmupDay: number | null;
  cap: number | null;
  sentToday: number;
  sends7d: number;
  hardBounces7d: number;
  bounceRate7d: number | null;
  queuedBacklog: number;
  notes: string | null;
  updatedAt: string;
}

interface DomainsPayload {
  ok: boolean;
  domains: DomainRow[];
  unknownDomains: Array<{ domain: string; dispatches: number }>;
  plateauCap: number;
}

const DNS_NEXT: Record<string, string | null> = { pending: "dns_added", dns_added: "verified", verified: null };

function warmupLabel(d: DomainRow): string {
  if (d.role !== "sending") return "no ramp — transactional";
  if (d.warmupDay == null || d.cap == null) return "warmup not started";
  return `day ${d.warmupDay} · cap ${d.sentToday}/${d.cap}`;
}

export function SendingDomainsPanel() {
  const [data, setData] = useState<DomainsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newDomain, setNewDomain] = useState("");
  const [newRole, setNewRole] = useState<"sending" | "transactional">("sending");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/ops/domains", { cache: "no-store" });
      const j = (await res.json()) as DomainsPayload;
      if (!res.ok || !j.ok) throw new Error("read failed");
      setData(j);
      setError(null);
    } catch {
      setError("ledger read failed");
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  // One beat everywhere: a register/patch here refreshes the cockpit deck;
  // any other surface's write refreshes the ledger here.
  useEffect(() => onConsoleRefresh(() => void load()), [load]);

  const mutate = useCallback(
    async (init: RequestInit) => {
      setBusy(true);
      try {
        const res = await fetch("/api/ops/domains", { headers: { "Content-Type": "application/json" }, ...init });
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          setError(j.error ?? `action failed (${res.status})`);
        } else {
          setError(null);
          requestConsoleRefresh(`domains:${String(init.method ?? "get").toLowerCase()}`);
          await load();
        }
      } catch {
        setError("action failed");
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const register = () => {
    const domain = newDomain.trim().toLowerCase();
    if (!domain) return;
    void mutate({ method: "POST", body: JSON.stringify({ domain, role: newRole }) }).then(() => setNewDomain(""));
  };

  const patch = (domain: string, body: Record<string, string>) => void mutate({ method: "PATCH", body: JSON.stringify({ domain, ...body }) });

  const rows = data?.domains ?? [];
  const unknown = data?.unknownDomains ?? [];

  return (
    <SoftCard className="mt-5 px-6 py-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <SectionLabel>Sending domains — egress ledger</SectionLabel>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-[#8E9194]">
            Every domain that may leave the building. The mailer refuses unregistered, DNS-unverified, paused, or over-cap domains;
            warmup ramps 5 → {data?.plateauCap ?? 40}/day over 15 days per domain. Register them the day you buy — wiring steps live in the runbook.
          </p>
        </div>
      </div>

      {error && <p className="mt-3 font-mono text-[10.5px] uppercase tracking-[0.14em] text-[#FF8A7A]">{error}</p>}

      {/* register — the buy-day step one */}
      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-white/[0.08] pt-4">
        <input
          value={newDomain}
          onChange={(e) => setNewDomain(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && register()}
          placeholder="send.yourdomain.com"
          spellCheck={false}
          className="h-8 w-64 rounded-lg border border-white/[0.09] bg-[#0E100E] px-3 font-mono text-[11px] text-[#F4F5F2] placeholder:text-[#5F6460] focus:border-white/25 focus:outline-none"
        />
        <button
          onClick={() => setNewRole(newRole === "sending" ? "transactional" : "sending")}
          className="h-8 rounded-lg border border-white/[0.09] px-3 font-mono text-[10px] uppercase tracking-[0.12em] text-[#8E9194] transition-colors hover:text-[#F4F5F2]"
        >
          {newRole}
        </button>
        <PillButton tone="dark" onClick={register} disabled={busy || newDomain.trim().length < 4}>
          Register
        </PillButton>
        <p className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-[#5F6460]">dnsStatus starts pending · add records → flip → warmup</p>
      </div>

      {rows.length === 0 && (
        <p className="mt-4 rounded-lg border border-white/[0.08] bg-[#0E100E] px-3.5 py-2.5 font-mono text-[10px] leading-relaxed tracking-[0.04em] text-[#8E9194]">
          nothing registered — the egress gate refuses every send from an unledgered domain, and the sandbox stays staged until a provider is configured. domains bought? register them above, then follow the runbook for DNS + Resend wiring.
        </p>
      )}

      <div className="mt-4 flex flex-col">
        {rows.map((d) => (
          <div key={d.domain} className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-white/[0.06] py-3 first:border-t-0 first:pt-0">
            <p className="font-display text-[14px] font-semibold tracking-[-0.01em] text-[#F4F5F2]">{d.domain}</p>
            <Chip tone={d.role === "sending" ? "raised" : "outline"}>{d.role}</Chip>
            <Chip tone={d.dnsStatus === "verified" ? "inverted" : "outline"}>dns {d.dnsStatus}</Chip>
            <Chip tone={d.status === "paused" || d.status === "burned" ? "well" : "outline"}>{d.status}</Chip>
            <p className="font-mono text-[10.5px] tabular-nums text-[#8E9194]">{warmupLabel(d)}</p>
            {d.queuedBacklog > 0 && <p className="font-mono text-[10.5px] tabular-nums text-[#C9CCC7]">{d.queuedBacklog} queued</p>}
            {d.bounceRate7d != null && (
              <p className="font-mono text-[10.5px] tabular-nums text-[#8E9194]">
                bounces 7d {Math.round(d.bounceRate7d * 100)}% ({d.hardBounces7d}/{d.sends7d})
              </p>
            )}
            <div className="ml-auto flex items-center gap-2">
              {DNS_NEXT[d.dnsStatus] && (
                <button
                  onClick={() => patch(d.domain, { dnsStatus: DNS_NEXT[d.dnsStatus] as string })}
                  disabled={busy}
                  className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-[#8E9194] transition-colors hover:text-[#F4F5F2]"
                >
                  dns → {DNS_NEXT[d.dnsStatus]}
                </button>
              )}
              {d.role === "sending" && d.status === "spare" && (
                <button
                  onClick={() => patch(d.domain, { status: "warming" })}
                  disabled={busy || d.dnsStatus !== "verified"}
                  className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-[#8E9194] transition-colors hover:text-[#F4F5F2] disabled:opacity-40"
                >
                  start warmup
                </button>
              )}
              {d.role === "sending" && (d.status === "warming" || d.status === "ready") && (
                <button
                  onClick={() => patch(d.domain, { status: "paused" })}
                  disabled={busy}
                  className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-[#8E9194] transition-colors hover:text-[#F4F5F2]"
                >
                  pause
                </button>
              )}
              {d.role === "sending" && d.status === "paused" && (
                <button
                  onClick={() => patch(d.domain, { status: "warming" })}
                  disabled={busy}
                  className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-[#8E9194] transition-colors hover:text-[#F4F5F2]"
                >
                  resume
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {unknown.length > 0 && (
        <div className="mt-3 border-t border-white/[0.06] pt-3">
          <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-[#6E736E]">dispatch domains not in the ledger — the gate refuses these</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {unknown.map((u) => (
              <Chip key={u.domain} tone="outline">
                {u.domain} · {u.dispatches} rows
              </Chip>
            ))}
          </div>
        </div>
      )}
    </SoftCard>
  );
}
