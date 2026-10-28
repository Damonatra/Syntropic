'use client';

/**
 * Enclave sign-in — pick your company, enter the access code from your
 * invite email. Codes are issued per tenant by a Syntropic operator from
 * the Backbone (reveal-once, rotated on every re-issue); demo code lists
 * no longer exist on this surface. One enclave per client: the session is
 * bound to exactly one tenant server-side — there is no switcher by design.
 * Server answers 429 with a lockout window after repeated wrong codes.
 */

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowUpRight, KeyRound, Loader2, ShieldCheck } from 'lucide-react';
import { ARTIFACT } from '@/components/backbone/primitives';

export default function PortalLogin({
  tenants,
  preselect,
}: {
  tenants: string[];
  preselect?: string;
}) {
  const router = useRouter();
  const [tenantName, setTenantName] = useState(preselect ?? tenants[0] ?? '');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!tenantName || !code.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/portal/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenantName, accessCode: code.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.error ?? 'Sign-in failed — try again.');
        setSubmitting(false);
        return;
      }
      router.push('/portal');
      router.refresh();
    } catch {
      setError('Network error — try again.');
      setSubmitting(false);
    }
  };

  return (
    <div className="grid min-h-screen place-items-center bg-paper px-5 py-12 text-ink selection:bg-blush selection:text-sienna">
      <main className="w-full max-w-[440px]">
        <div className="mb-8 flex items-center justify-between">
          <Link href="/backbone" className="font-display text-[21px] leading-none tracking-[-0.01em]">
            enclave
          </Link>
          <span className="text-[13px] text-smoke">Layer 03 · client boundary</span>
        </div>

        <div className={`${ARTIFACT} p-7`}>
          <h1 className="font-display text-[28px] leading-tight tracking-[-0.01em]">
            Enter your <em className="italic">enclave.</em>
          </h1>
          <p className="mt-2 text-[14px] leading-relaxed text-steel">
            Each enclave is bound to one client. Choose your company and use the
            access code from your invite email — codes rotate whenever your
            operator re-issues them.
          </p>

          <form onSubmit={submit} className="mt-6 space-y-5">
            <div>
              <div className="mb-2 text-[13px] font-medium text-steel">Your company</div>
              <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Your company">
                {tenants.map((t) => {
                  const active = t === tenantName;
                  return (
                    <button
                      key={t}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => {
                        setTenantName(t);
                        setError(null);
                      }}
                      className={`rounded-full px-3.5 py-2 text-[13px] transition-colors ${
                        active
                          ? 'bg-ink text-paper'
                          : 'border border-hairline text-steel hover:bg-mist'
                      }`}
                    >
                      {t}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <label htmlFor="access-code" className="mb-2 block text-[13px] font-medium text-steel">
                Access code
              </label>
              <input
                id="access-code"
                type="password"
                value={code}
                onChange={(e) => {
                  setCode(e.target.value);
                  setError(null);
                }}
                autoComplete="off"
                placeholder="••••••••••••"
                className="h-11 w-full rounded-full border border-hairline bg-paper px-4 text-[14px] tracking-wide outline-none transition-shadow placeholder:text-smoke focus-visible:shadow-[0_0_0_2px_rgba(93,42,26,0.25)]"
              />
            </div>

            {error && (
              <div role="alert" className="rounded-2xl bg-blush px-4 py-3 text-[13px] font-medium text-sienna">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting || !code.trim()}
              className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-full bg-ink text-[14px] font-medium text-paper transition-colors hover:bg-[#33363b] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} />
              ) : (
                <ShieldCheck className="h-4 w-4" strokeWidth={1.75} />
              )}
              Sign in to enclave
            </button>
          </form>
        </div>

        <div className="mt-5 rounded-[20px] bg-mist p-5">
          <div className="flex items-center gap-2 text-[12px] font-medium uppercase tracking-[0.08em] text-ash">
            <KeyRound className="h-3.5 w-3.5" strokeWidth={1.75} />
            No code yet?
          </div>
          <p className="mt-2.5 text-[13px] leading-relaxed text-steel">
            Access codes are issued by your Syntropic operator and delivered to
            your team by email — each code signs your company into exactly one
            enclave and is replaced whenever a new invite is issued. Lost or
            expired? Ask your operator for a fresh invite; repeated wrong
            attempts lock sign-in temporarily.
          </p>
        </div>

        <div className="mt-6 text-center">
          <Link
            href="/backbone"
            className="inline-flex items-center gap-1.5 text-[13.5px] text-steel underline-offset-4 hover:underline"
          >
            Agency? Open the Backbone command view <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={1.75} />
          </Link>
        </div>
      </main>
    </div>
  );
}
