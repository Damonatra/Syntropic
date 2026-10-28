import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Minimal Stripe client for the two calls the backbone needs — checkout
 * session creation and webhook signature verification — implemented on
 * fetch + node:crypto so no SDK dependency is added for an env-gated
 * subsystem. Both entry points 501 when STRIPE_SECRET_KEY is unset.
 */

const STRIPE_API = 'https://api.stripe.com/v1';

export const checkoutConfigured = () => Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID);

const form = (data: Record<string, string | number | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(data)) if (v !== undefined && v !== null) p.append(k, String(v));
  return p;
};

export interface CheckoutSession {
  id: string;
  url: string | null;
}

/** Creates a hosted Stripe Checkout session for the $3,500 audit deposit. */
export async function createCheckoutSession(input: {
  tenantName: string;
  email: string;
  origin: string;
  source?: string;
}): Promise<CheckoutSession> {
  const res = await fetch(`${STRIPE_API}/checkout/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form({
      mode: 'payment',
      'line_items[0][price]': process.env.STRIPE_PRICE_ID,
      'line_items[0][quantity]': 1,
      customer_email: input.email,
      client_reference_id: input.tenantName,
      'metadata[tenantName]': input.tenantName,
      'metadata[source]': input.source ?? 'unknown',
      success_url: `${input.origin}/?payment=success&tenant=${encodeURIComponent(input.tenantName)}`,
      cancel_url: `${input.origin}/?payment=cancelled`,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { id?: string; url?: string; error?: { message?: string } };
  if (!res.ok || !body.id) throw new Error(body.error?.message ?? `Stripe checkout failed (${res.status})`);
  return { id: body.id, url: body.url ?? null };
}

/**
 * Verifies the Stripe-Signature header (t=…,v1=…) against the raw body.
 * Constant-time comparison; 5-minute replay window as Stripe recommends.
 */
export function verifyStripeSignature(payload: string, header: string | null, secret: string): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
