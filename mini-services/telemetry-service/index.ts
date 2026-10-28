/**
 * Vertebra command bridge — port 3003.
 *
 * Two jobs:
 *  1. Source simulator: emits realistic Module 8 portal telemetry and Module 9
 *     inbound replies by POSTing to the Enclave's production endpoints
 *     (/api/telemetry/ingest, /api/replies). In deployment the Python engine
 *     calls the same endpoints — this service is a stand-in source, not a
 *     parallel write path.
 *  2. Fan-out: broadcasts `telemetry`, `reply` and `heartbeat` events to the
 *     command centre over socket.io.
 *
 * Access from the browser is always io("/?XTransformPort=3003") via Caddy.
 */
import { createServer } from "http";
import { Server } from "socket.io";

const ENCLAVE = "http://127.0.0.1:3000";
const PORT = 3003;

const httpServer = createServer();
const io = new Server(httpServer, {
  // DO NOT change the path, it is used by Caddy to forward the request to the correct port
  path: "/",
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 60_000,
  pingInterval: 25_000,
});

// --------------------------------------------------------------------------- //
// Enclave access
// --------------------------------------------------------------------------- //

interface CommandLeadLite {
  id: string;
  name: string;
  qlvScore: number | null;
  lastIntentHeat: number;
  city: string | null;
  country: string | null;
}

async function fetchLeads(): Promise<CommandLeadLite[]> {
  try {
    const res = await fetch(`${ENCLAVE}/api/command`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      leads?: Array<{ id: string; name: string; score?: { qlvScore?: number } | null; lastIntentHeat?: number; city?: string | null; country?: string | null }>;
    };
    return (data.leads ?? [])
      .map((l) => ({
        id: l.id,
        name: l.name,
        qlvScore: l.score?.qlvScore ?? null,
        lastIntentHeat: l.lastIntentHeat ?? 0,
        city: l.city ?? null,
        country: l.country ?? null,
      }))
      .filter((l) => (l.qlvScore ?? 0) >= 40);
  } catch {
    return [];
  }
}

function weightedPick(leads: CommandLeadLite[]): CommandLeadLite | null {
  if (leads.length === 0) return null;
  const weights = leads.map((l) => Math.pow(Math.max(4, l.lastIntentHeat), 2));
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = Math.random() * total;
  for (let i = 0; i < leads.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return leads[i];
  }
  return leads[leads.length - 1];
}

const EVENT_TYPES = [
  ["portal_visit", 0.3],
  ["pricing_view", 0.22],
  ["session_end", 0.14],
  ["audit_view", 0.18],
  ["document_download", 0.16],
] as const;

function pickEventType(): string {
  let roll = Math.random();
  for (const [type, weight] of EVENT_TYPES) {
    roll -= weight;
    if (roll <= 0) return type;
  }
  return "session_end";
}

function eventUrl(type: string): string {
  switch (type) {
    case "portal_visit": return "https://syntropic.engine/portal";
    case "audit_view": return "https://syntropic.engine/audit";
    case "document_download": return "https://syntropic.engine/assets/quote-leakage-audit.pdf";
    case "pricing_view": return "https://syntropic.engine/portal#engagement";
    default: return "https://syntropic.engine/portal";
  }
}

const DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

// --------------------------------------------------------------------------- //
// Simulators
// --------------------------------------------------------------------------- //

let running = true;

async function simulateTelemetry(): Promise<void> {
  const leads = await fetchLeads();
  const lead = weightedPick(leads);
  if (!lead) return;
  const type = pickEventType();
  const device = Math.random() > 0.7 ? "mobile" : "desktop";
  try {
    const res = await fetch(`${ENCLAVE}/api/telemetry/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({
        prospectId: lead.id,
        eventType: type,
        sessionId: `bridge-${Date.now().toString(36)}`,
        url: eventUrl(type),
        referrer: Math.random() > 0.6 ? "direct" : "https://mail.google.com/",
        device,
        userAgent: device === "mobile" ? MOBILE_UA : DESKTOP_UA,
        durationMs: type === "session_end" ? 40_000 + Math.floor(Math.random() * 160_000) : null,
        payload: { source: "command-bridge" },
      }),
    });
    if (!res.ok) return;
    const data = await res.json();
    io.emit("telemetry", {
      event: {
        id: data.event?.id ?? `bridge-${Date.now()}`,
        prospectId: lead.id,
        prospectName: lead.name,
        qlvScore: data.prospect?.qlvScore ?? lead.qlvScore,
        eventType: type,
        url: eventUrl(type),
        city: lead.city,
        country: lead.country,
        device,
        durationMs: null,
        occurredAtMs: Date.now(),
        lastIntentHeat: data.prospect?.lastIntentHeat ?? lead.lastIntentHeat,
      },
      alert: data.alert ?? null,
    });
    console.log(`[bridge] telemetry ${type} → ${lead.name}${data.alert ? " (ALERT)" : ""}`);
  } catch (error) {
    console.warn("[bridge] telemetry simulate failed:", error);
  }
}

const REPLY_TEMPLATES: Array<{ intentHint: string; subject: (n: string) => string; body: (n: string, f: string) => string }> = [
  {
    intentHint: "send_information",
    subject: (n) => `Re: Quote leakage at ${n}`,
    body: (_n, f) => `${f} — send me the one-pager and the audit sample. No calls yet, I'll circulate internally first.`,
  },
  {
    intentHint: "objection_price",
    subject: (n) => `Re: Quote leakage at ${n}`,
    body: (_n, f) => `${f} — interesting audit, but your pricing is steep for a shop our size. Make the ROI case in our own numbers or we're done here.`,
  },
  {
    intentHint: "objection_erp",
    subject: (n) => `Re: Quote leakage at ${n}`,
    body: (_n, f) => `${f} — we just finished a long ERP implementation and I'm not bolting another system on this year. Who maintains your side when updates break it?`,
  },
  {
    intentHint: "interested",
    subject: (n) => `Re: Quote leakage at ${n}`,
    body: (_n, f) => `${f} — your leakage math is close. Can you walk our ops team through it this week?`,
  },
  {
    intentHint: "out_of_office",
    subject: (n) => `Automatic reply: Quote leakage at ${n}`,
    body: (_n, f) => `I am away from the office with limited email access until ${new Date(Date.now() + 6 * 86_400_000).toDateString()}. For urgent matters contact the main line. — ${f}`,
  },
];

async function simulateReply(): Promise<void> {
  const leads = await fetchLeads();
  const lead = weightedPick(leads);
  if (!lead) return;
  const nameParts = lead.name.split(" ");
  const first = nameParts[0]?.replace(/[^A-Za-z]/g, "") || "there";
  const tpl = REPLY_TEMPLATES[Math.floor(Math.random() * REPLY_TEMPLATES.length)];
  try {
    const res = await fetch(`${ENCLAVE}/api/replies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        prospectId: lead.id,
        fromEmail: `reply@${(lead.name.toLowerCase().replace(/[^a-z]/g, "").slice(0, 12) || "prospect")}.test`,
        subject: tpl.subject(lead.name),
        body: tpl.body(lead.name, first),
      }),
    });
    if (!res.ok) return;
    const data = await res.json();
    io.emit("reply", {
      reply: {
        replyId: data.replyId,
        prospectId: lead.id,
        prospectName: lead.name,
        qlvScore: data.prospect?.qlvScore ?? lead.qlvScore,
        intent: data.intent,
        confidence: data.confidence,
        tier: data.tier,
        action: data.action,
        draftSubject: data.draft?.subject ?? null,
        receivedAtMs: Date.now(),
      },
    });
    console.log(`[bridge] reply intent=${data.intent} tier=${data.tier} → ${lead.name}`);
  } catch (error) {
    console.warn("[bridge] reply simulate failed:", error);
  }
}

function loop(fn: () => Promise<void>, minMs: number, maxMs: number): void {
  const tick = async () => {
    if (!running) return;
    await fn();
    const delay = minMs + Math.random() * (maxMs - minMs);
    setTimeout(tick, delay);
  };
  setTimeout(tick, minMs + Math.random() * Math.min(maxMs - minMs, 6000));
}

// --------------------------------------------------------------------------- //
// Socket surface
// --------------------------------------------------------------------------- //

io.on("connection", (socket) => {
  console.log(`[bridge] client connected: ${socket.id}`);
  socket.emit("heartbeat", { clients: io.engine.clientsCount, at: new Date().toISOString() });
  socket.on("disconnect", () => {
    console.log(`[bridge] client disconnected: ${socket.id}`);
  });
  socket.on("error", (error) => {
    console.error(`[bridge] socket error (${socket.id}):`, error);
  });
});

loop(simulateTelemetry, 9_000, 18_000);
loop(simulateReply, 110_000, 200_000);

setInterval(() => {
  io.emit("heartbeat", { clients: io.engine.clientsCount, at: new Date().toISOString() });
}, 30_000);

httpServer.listen(PORT, () => {
  console.log(`Vertebra command bridge running on port ${PORT}`);
});

process.on("SIGTERM", () => {
  running = false;
  httpServer.close(() => process.exit(0));
});
process.on("SIGINT", () => {
  running = false;
  httpServer.close(() => process.exit(0));
});
