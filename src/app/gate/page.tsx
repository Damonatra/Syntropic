/**
 * /gate — enclave password screen. Rendered only when middleware redirects
 * an unauthenticated operator here (ENCLAVE_PASSWORD configured).
 */
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function GatePage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(false);
    try {
      const res = await fetch("/api/gate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
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
        <h1 className="mt-3 font-display text-[22px] font-semibold tracking-[-0.02em]">Zero-trust checkpoint</h1>
        <p className="mt-2 text-[12.5px] leading-relaxed text-[#8E9194]">
          This enclave requires a session. Present the operator password to proceed.
        </p>
        <form
          className="mt-6 flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="operator password"
            autoFocus
            className="h-11 rounded-lg border border-white/15 bg-[#0E100E] px-4 font-mono text-[13px] text-[#F4F5F2] outline-none placeholder:text-[#5F6460] focus:border-white/40"
          />
          {error && (
            <p className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-[#FF8A7A]">access denied — password rejected</p>
          )}
          <button
            type="submit"
            disabled={busy || password.length === 0}
            className="h-11 rounded-lg bg-[#F4F5F2] font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-[#0B0C0B] transition-all hover:bg-white disabled:opacity-40"
          >
            {busy ? "verifying…" : "enter enclave"}
          </button>
        </form>
      </div>
    </main>
  );
}
