/**
 * Enclave connections — the console face of the integration registry.
 *
 * One row per external API: kind, status, circuit, whether its key env var
 * is actually set in this environment, call counts, last success, last
 * error, and — for the enrich rows — the honest spend (resolutions and
 * credits from the ContactResolution ledger). The probe button fires a real
 * check: signed synthetic requests through machine doors, presence +
 * reachability through key-carrying providers, and it never pretends a
 * reachable host is a working integration.
 *
 * Zero color law holds: state is words, chips, and luminance — not traffic
 * lights. Arming is a click here and nowhere else; the gate never trusts
 * this panel, only the ledger.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { Chip, PillButton, SectionLabel, SoftCard } from "./bits";
import { humanDuration } from "@/lib/vertebra/watches";
import { onConsoleRefresh, requestConsoleRefresh } from "@/lib/vertebra/console-bus";

interface IntegrationRow {
  provider: string;
  label: string;
  kind: string;
  authType: string;
  status: string;
  circuitState: string;
  consecutiveFailures: number;
  keyEnvVar: string | null;
  keyPresent: boolean;
  quotaRemaining: number | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  callsTotal: number;
  callsFailed: number;
  notes: string | null;
  doorPath: string | null;
  resolutionsResolved?: number;
  creditsSpent?: number;
  refusals24h?: number;
  refusalsTotal?: number;
  runway?: RunwayShape;
}

interface RunwayShape {
  quotaRemaining: number | null;
  creditsSpent7d: number;
  creditsPerDay: number;
  dryInDays: number | null;
  dryAtDate: string | null;
  level: "ok" | "warn" | "crit";
}

interface FleetShape {
  total: number;
  armed: number;
  staged: number;
  degraded: number;
  retired: number;
  circuitOpen: number;
  armedKeyMissing: number;
  verdict: string;
}

interface ProbeView {
  ok: boolean;
  verdict: string;
  checks: Array<{ name: string; pass: boolean; detail: string }>;
  firedAt: string;
}

interface RegistryPayload {
  ok: boolean;
  integrations: IntegrationRow[];
  fleet?: FleetShape;
  gateRefusals24h?: number;
}

function ageLabel(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  return ms < 0 ? "just now" : `${humanDuration(ms)} ago`;
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * The fleet verdict — one glanceable line plus the star map: one dot per
 * spoke, ordered inbound → enrich → egress → pager → calendar, luminance by
 * status, a ring when its circuit is open. Zero color: state is words,
 * chips, and luminance, not traffic lights.
 */
function FleetStrip({ fleet, rows, gateRefusals }: { fleet: FleetShape; rows: IntegrationRow[]; gateRefusals: number }) {
  const order: Record<string, number> = { inbound: 0, enrich: 1, egress: 2, pager: 3, calendar: 4 };
  const dots = [...rows].sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9));
  return (
    <div className="mt-4 rounded-lg border border-white/[0.08] bg-[#0E100E] px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-[#F4F5F2]">{fleet.verdict}</p>
        <p className="font-mono text-[10.5px] tabular-nums text-[#8E9194]">
          {fleet.armed} armed · {fleet.staged} staged · {fleet.degraded} degraded · {fleet.retired} retired
          {fleet.circuitOpen > 0 ? ` · ${fleet.circuitOpen} circuit open` : ""}
          {fleet.armedKeyMissing > 0 ? ` · ${fleet.armedKeyMissing} armed w/o key` : ""}
          {gateRefusals > 0 ? ` · ${gateRefusals} gate refusals 24h` : ""}
        </p>
        <div
          className="ml-auto flex items-center gap-1.5"
          title="star map — one dot per spoke, inbound → enrich → egress → pager → calendar; brighter = armed, ring = circuit open"
        >
          {dots.map((d) => (
            <span
              key={d.provider}
              title={`${d.provider} · ${d.status}${d.circuitState === "open" ? " · circuit open" : ""}`}
              className={`h-1.5 w-1.5 rounded-full ${d.circuitState === "open" ? "ring-1 ring-[#F4F5F2]" : ""}`}
              style={{
                backgroundColor: "#F4F5F2",
                opacity: d.status === "armed" ? 1 : d.status === "degraded" ? 0.55 : d.status === "retired" ? 0.2 : 0.3,
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

const KIND_LABEL: Record<string, string> = {
  egress: "egress",
  inbound: "inbound",
  enrich: "enrich",
  calendar: "calendar",
  pager: "pager",
};

export function ConnectionsPanel() {
  const [data, setData] = useState<RegistryPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [probes, setProbes] = useState<Record<string, ProbeView>>({});
  const [probing, setProbing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [quotaFor, setQuotaFor] = useState<string | null>(null);
  const [quotaValue, setQuotaValue] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/ops/integrations", { cache: "no-store" });
      const j = (await res.json()) as RegistryPayload;
      if (!res.ok || !j.ok) throw new Error("read failed");
      setData(j);
      setError(null);
    } catch {
      setError("registry read failed");
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  // One beat everywhere: arming here refreshes the cockpit deck; a reveal in
  // the sourcing view refreshes the spend line here.
  useEffect(() => onConsoleRefresh(() => void load()), [load]);

  const patch = async (provider: string, body: Record<string, string | number | null>) => {
    setBusy(true);
    try {
      const res = await fetch("/api/ops/integrations", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, ...body }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? `action failed (${res.status})`);
      } else {
        setError(null);
        requestConsoleRefresh("connections:patch");
        await load();
      }
    } catch {
      setError("action failed");
    } finally {
      setBusy(false);
    }
  };

  const probe = async (provider: string) => {
    setProbing(provider);
    try {
      const res = await fetch("/api/ops/integrations/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      const j = (await res.json().catch(() => ({}))) as ProbeView & { ok?: boolean; error?: string };
      if (res.ok && j.verdict) {
        setProbes((p) => ({ ...p, [provider]: { ok: Boolean(j.ok), verdict: j.verdict, checks: j.checks ?? [], firedAt: j.firedAt ?? new Date().toISOString() } }));
        setError(null);
      } else {
        setError(j.error ?? `probe failed (${res.status})`);
      }
      requestConsoleRefresh("connections:probe");
      await load();
    } catch {
      setError("probe failed");
    } finally {
      setProbing(null);
    }
  };

  const saveQuota = async (provider: string) => {
    const trimmed = quotaValue.trim();
    if (trimmed !== "" && Number.isNaN(Number(trimmed))) return;
    await patch(provider, { quotaRemaining: trimmed === "" ? null : Math.max(0, Math.round(Number(trimmed))) });
    setQuotaFor(null);
  };

  const rows = data?.integrations ?? [];

  return (
    <SoftCard className="mt-5 px-6 py-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <SectionLabel>Enclave connections — integration registry</SectionLabel>
          <p className="mt-1.5 max-w-3xl text-[12.5px] leading-relaxed text-[#8E9194]">
            Every external API as one ledger row — dumb spokes, one brain. Anything a capability needs from outside is gated here: staged, key-missing,
            retired, or circuit-open integrations refuse with a named reason before a single byte leaves. Arming is a deliberate operator act; a key
            appearing in the env never arms anything by itself. The refusal counts are that gate made visible; the runway projection rings the watchtower
            before credits run dry.
          </p>
        </div>
      </div>

      {error && <p className="mt-3 font-mono text-[10.5px] uppercase tracking-[0.14em] text-[#FF8A7A]">{error}</p>}

      {data?.fleet && <FleetStrip fleet={data.fleet} rows={rows} gateRefusals={data.gateRefusals24h ?? 0} />}

      <div className="mt-4 flex flex-col">
        {rows.map((r) => {
          const probeView = probes[r.provider];
          return (
            <div key={r.provider} className={`border-t border-white/[0.06] py-3.5 first:border-t-0 first:pt-0 ${r.status === "staged" ? "opacity-70" : ""}`}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <p className="font-display text-[14px] font-semibold tracking-[-0.01em] text-[#F4F5F2]">{r.label}</p>
                <Chip tone="outline">{KIND_LABEL[r.kind] ?? r.kind}</Chip>
                <Chip tone={r.status === "armed" ? "inverted" : r.status === "degraded" || r.status === "retired" ? "well" : "outline"}>{r.status}</Chip>
                {r.circuitState === "open" && <Chip tone="well">circuit open · {r.consecutiveFailures} fails</Chip>}
                <Chip tone={r.keyPresent ? "raised" : "outline"}>{r.keyPresent ? `key set · ${r.keyEnvVar}` : `key missing · ${r.keyEnvVar ?? "no env var"}`}</Chip>
                <p className="font-mono text-[10.5px] tabular-nums text-[#8E9194]">
                  {r.callsTotal} calls{r.callsFailed > 0 ? ` · ${r.callsFailed} failed` : ""} · last ok {ageLabel(r.lastSuccessAt)}
                </p>
                {r.kind === "enrich" && (r.refusals24h ?? 0) > 0 && (
                  <Chip tone="well" className="normal-case tracking-normal">
                    {r.refusals24h} refused · 24h
                  </Chip>
                )}
                {r.runway && (
                  <Chip tone={r.runway.level === "crit" ? "well" : r.runway.level === "warn" ? "outline" : "raised"} className="normal-case tracking-normal">
                    {r.runway.creditsPerDay > 0
                      ? `${r.runway.creditsPerDay}/day${r.runway.dryAtDate ? ` · dry ~${shortDate(r.runway.dryAtDate)}` : " · quota unreported"}`
                      : r.runway.quotaRemaining != null
                        ? `${r.runway.quotaRemaining} credits left`
                        : "no spend yet"}
                  </Chip>
                )}
                {r.kind === "enrich" && (r.resolutionsResolved ?? 0) + (r.creditsSpent ?? 0) > 0 && (
                  <p className="font-mono text-[10.5px] tabular-nums text-[#C9CCC7]">
                    {r.resolutionsResolved} resolved · {r.creditsSpent} credits spent
                  </p>
                )}
                <div className="ml-auto flex items-center gap-3">
                  {r.kind === "enrich" &&
                    (quotaFor === r.provider ? (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          void saveQuota(r.provider);
                        }}
                        className="flex items-center gap-1.5"
                      >
                        <input
                          value={quotaValue}
                          onChange={(e) => setQuotaValue(e.target.value)}
                          placeholder="credits left"
                          inputMode="numeric"
                          aria-label={`quota remaining for ${r.provider}`}
                          className="h-7 w-24 rounded-md border border-white/[0.12] bg-[#0B0C0B] px-2 font-mono text-[10.5px] text-[#F4F5F2] placeholder:text-[#5F6460] focus:border-white/[0.3] focus:outline-none"
                        />
                        <button type="submit" disabled={busy} className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-[#F4F5F2]">
                          save
                        </button>
                        <button type="button" onClick={() => setQuotaFor(null)} className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-[#8E9194]">
                          cancel
                        </button>
                      </form>
                    ) : (
                      <button
                        onClick={() => {
                          setQuotaFor(r.provider);
                          setQuotaValue(r.runway?.quotaRemaining != null ? String(r.runway.quotaRemaining) : "");
                        }}
                        disabled={busy}
                        title="declare the plan allowance — the runway math needs a balance to project a dry date"
                        className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-[#8E9194] transition-colors hover:text-[#F4F5F2]"
                      >
                        quota
                      </button>
                    ))}
                  {r.status === "staged" && (
                    <button
                      onClick={() => void patch(r.provider, { status: "armed" })}
                      disabled={busy}
                      className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-[#8E9194] transition-colors hover:text-[#F4F5F2]"
                    >
                      arm
                    </button>
                  )}
                  {r.status === "armed" && (
                    <button
                      onClick={() => void patch(r.provider, { status: "staged" })}
                      disabled={busy}
                      className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-[#8E9194] transition-colors hover:text-[#F4F5F2]"
                    >
                      stage
                    </button>
                  )}
                  {r.circuitState === "open" && (
                    <button
                      onClick={() => void patch(r.provider, { circuitState: "closed" })}
                      disabled={busy}
                      className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-[#8E9194] transition-colors hover:text-[#F4F5F2]"
                    >
                      close circuit
                    </button>
                  )}
                  <PillButton tone="well" onClick={() => void probe(r.provider)} disabled={probing === r.provider} className="h-7 px-3 text-[10px]">
                    {probing === r.provider ? "probing…" : "probe"}
                  </PillButton>
                </div>
              </div>

              {r.notes && <p className="mt-1.5 max-w-4xl text-[11.5px] leading-relaxed text-[#6E736E]">{r.notes}</p>}

              {r.lastError && (
                <p className="mt-1.5 font-mono text-[10px] leading-relaxed text-[#8E9194]">
                  last error {ageLabel(r.lastErrorAt)} · {r.lastError}
                </p>
              )}

              {probeView && (
                <div className="mt-2 rounded-lg border border-white/[0.08] bg-[#0E100E] px-3 py-2">
                  <p className={`font-mono text-[10px] uppercase tracking-[0.12em] ${probeView.ok ? "text-[#F4F5F2]" : "text-[#FF8A7A]"}`}>{probeView.verdict}</p>
                  <div className="mt-1 flex flex-col gap-0.5">
                    {probeView.checks.map((c) => (
                      <p key={c.name} className="font-mono text-[9.5px] leading-relaxed text-[#6E736E]">
                        {c.pass ? "✓" : "✗"} {c.name} — {c.detail}
                      </p>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </SoftCard>
  );
}
