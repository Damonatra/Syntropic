/**
 * Email delivery — Resend when RESEND_API_KEY is configured, console
 * fallback otherwise (the link lands in dev.log; the sandbox demo relies
 * on this path). Both senders return 'sent' | 'logged' so callers can
 * surface the honest delivery mode.
 */

export async function sendMagicLink(email: string, url: string): Promise<'sent' | 'logged'> {
  if (process.env.RESEND_API_KEY) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: process.env.MAIL_FROM ?? 'Syntropic <ops@syntropic.ai>',
          to: email,
          subject: 'Your Syntropic Backbone sign-in link',
          text: `Sign in to the Backbone Command Tower (valid 15 minutes, single use):\n\n${url}\n\nIf you did not request this, ignore this message.`,
        }),
      });
      if (res.ok) return 'sent';
    } catch {
      /* fall through to console */
    }
  }
  console.log(`[auth] magic link for ${email}: ${url}`);
  return 'logged';
}

export async function sendTenantUnlockEmail(email: string, loginUrl: string, company: string, accessCode: string): Promise<'sent' | 'logged'> {
  if (process.env.RESEND_API_KEY) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: process.env.MAIL_FROM ?? 'Syntropic <ops@syntropic.ai>',
          to: email,
          subject: 'Your Syntropic audit enclave is unlocked',
          text: `${company}'s $3,500 Diagnostic Audit deposit is confirmed.\n\nSign in at: ${loginUrl}\nAccess code (shown here only): ${accessCode}\n\nUpload your 20 historical quote PDFs to begin the spatial parse.`,
        }),
      });
      if (res.ok) return 'sent';
    } catch {
      /* fall through to console */
    }
  }
  console.log(`[tenant] unlock for ${email} (${company}): login ${loginUrl} · code ${accessCode}`);
  return 'logged';
}
