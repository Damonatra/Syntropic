/**
 * /gate — the enclave door. Per-operator sign-in: choose your account,
 * present your password. Rendered only when middleware redirects an
 * unauthenticated operator here (ENCLAVE_SESSION_SECRET configured).
 *
 * Design law: zero color — grayscale only. Hover states ride the
 * `tactile` CSS custom property (Tailwind v4: no hover: utilities).
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface OperatorOption {
  username: string;
  displayName: string;
}

export default function GatePage() {
  const router = useRouter();
  const [operators, setOperators] = useState<OperatorOption[]>([]);
  const [username, setUsername] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/gate")
      .then((r) => r.json())
      .then((d: { operators?: OperatorOption[] }) => {
        setOperators(d.operators ?? []);
        if (d.operators?.length === 1) setUsername(d.operators[0]?.username ?? null);
      })
      .catch(() => setOperators([]));
  }, []);

  const choose = (u: string) => {
    setUsername(u);
    setError(false);
    requestAnimationFrame(() => passwordRef.current?.focus());
  };

  const submit = async () => {
    if (!username || busy) return;
    setBusy(true);
    setError(false);
    try {
      const res = await fetch("/api/gate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (res.ok) {
        router.replace("/");
        router.refresh();
        return;
      }
      setError(true);
    } catch {
      setError(true);
    }
    setBusy(false);
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#0B0C0B] px-6 text-[#F4F5F2]">
      <div className="w-full max-w-[420px] rounded-lg border border-[#232623] bg-[#121412] px-8 py-10">
        <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-[#6E736E]">Syntropic // Enclave</p>
        <h1 className="mt-3 font-display text-[22px] font-semibold tracking-[-0.02em]">Operator checkpoint</h1>
        <p className="mt-2 text-[12.5px] leading-relaxed text-[#8E9194]">
          This enclave is keyed to its operators. Choose your account and present your password — actions inside are
          signed to your name.
        </p>

        {operators.length > 0 && (
          <div className="mt-6 flex flex-col gap-2" role="radiogroup" aria-label="Operator account">
            {operators.map((o) => {
              const selected = username === o.username;
              return (
                <button
                  key={o.username}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => choose(o.username)}
                  className={`flex h-12 items-center justify-between rounded-lg border px-4 transition-all ${
                    selected
                      ? "border-white/50 bg-[#F4F5F2] text-[#0B0C0B]"
                      : "tactile-card border bg-[#0E100E] text-[#F4F5F2]"
                  }`}
                >
                  <span className="font-display text-[14px] font-semibold tracking-[-0.01em]">{o.displayName}</span>
                  <span
                    className={`font-mono text-[10px] uppercase tracking-[0.18em] ${selected ? "text-[#0B0C0B]/60" : "text-[#5F6460]"}`}
                  >
                    {selected ? "● selected" : o.username}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        <form
          className="mt-4 flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <input
            ref={passwordRef}
            type="password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setError(false);
            }}
            placeholder={username ? `${username} — password` : "select an operator first"}
            disabled={!username}
            autoFocus
            className="h-11 rounded-lg border border-white/15 bg-[#0E100E] px-4 font-mono text-[13px] text-[#F4F5F2] outline-none placeholder:text-[#5F6460] focus:border-white/40 disabled:opacity-40"
          />
          {error && (
            <p className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-[#F4F5F2]">
              × access denied — credentials rejected
            </p>
          )}
          <button
            type="submit"
            disabled={busy || !username || password.length === 0}
            className="tactile-btn h-11 rounded-lg bg-[#F4F5F2] font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-[#0B0C0B] disabled:opacity-40"
          >
            {busy ? "verifying…" : "enter enclave"}
          </button>
        </form>
      </div>
    </main>
  );
}
