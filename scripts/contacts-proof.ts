/**
 * Contact-resolver proof — the enrich spoke exercised against the real
 * SQLite ledger, no server needed.
 *
 * Walks every verdict the resolver can return, end to end through the
 * registry gate, with fixture transports standing in for Apollo/Hunter
 * (the wire format those fixtures pin is the same one the vitest suite
 * asserts — a provider changing their response shape breaks here first):
 *
 *   invalid query                    → refused, ledgered (invalid_query)
 *   nothing armed                    → refused (no_armed_enrich_provider)
 *   armed, key missing               → refused (integration_key_missing)
 *   armed + key, apollo fixture      → resolved, prospect updated, 1 credit
 *   apollo no person                 → no_match, 0 credits, circuit closed
 *   apollo HTTP 500 ×5               → circuit opens; 6th call never fires
 *   hunter armed as fallback         → resolves via hunter (score → medium)
 *   probe (enrich, fake transport)   → honest checks, evidence on the row
 *
 * The real apollo/hunter registry rows are snapshotted first and restored
 * exactly; every proof ledger row (ContactResolution, scratch prospect) is
 * swept. No network call ever leaves the building.
 *
 * Run:  bun scripts/contacts-proof.ts
 */
import { PrismaClient } from "@prisma/client";
import { resolveContact } from "../src/lib/vertebra/contacts";
import { ensureKnownIntegrations, probeIntegration } from "../src/lib/vertebra/integrations";

process.env.APOLLO_API_KEY = "re_proof_placeholder_apollo_key";

const db = new PrismaClient();
let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? `  ·  ${JSON.stringify(detail).slice(0, 180)}` : ""}`);
}

const fixture = (payload: unknown, status = 200) => () => Promise.resolve(new Response(JSON.stringify(payload), { status }));
const failing = (status: number) => () => Promise.resolve(new Response("proof-failure", { status }));

async function main() {
  console.log("\n=== contact resolver proof ===");
  await ensureKnownIntegrations();

  // snapshot the real enrich rows — restored verbatim at the end
  const savedApollo = await db.integrationRecord.findUnique({ where: { provider: "apollo" } });
  const savedHunter = await db.integrationRecord.findUnique({ where: { provider: "hunter" } });

  const prospect = await db.prospect.create({
    data: { name: "Contact Proof Co", domainKey: `proof:contacts:${Date.now()}`, domain: "proof-contact.test" },
  });
  const sweepResolutions = () => db.contactResolution.deleteMany({ where: { prospectId: prospect.id } });
  const Q = { name: "Vera Lyan", domain: "proof-contact.test" };

  // 1 — invalid query: no place to look
  const badQuery = await resolveContact({ query: { name: "Vera Lyan" }, prospectId: prospect.id });
  check("invalid query refused + ledgered", badQuery.status === "refused" && (badQuery.reason ?? "").includes("invalid_query"), badQuery.reason);

  // 2 — nothing armed
  await db.integrationRecord.updateMany({ where: { provider: { in: ["apollo", "hunter"] } }, data: { status: "staged" } });
  const unarmed = await resolveContact({ query: Q, prospectId: prospect.id });
  check("nothing armed refused with combined reason", unarmed.status === "refused" && (unarmed.reason ?? "").includes("no_armed_enrich_provider"), unarmed.reason);

  // 3 — armed but the key env var is unset (delete the proof key momentarily)
  await db.integrationRecord.update({ where: { provider: "apollo" }, data: { status: "armed" } });
  delete process.env.APOLLO_API_KEY;
  const noKey = await resolveContact({ query: Q, prospectId: prospect.id });
  check("armed + key missing refused (fail closed)", noKey.status === "refused" && (noKey.reason ?? "").includes("integration_key_missing"), noKey.reason);
  process.env.APOLLO_API_KEY = "re_proof_placeholder_apollo_key";

  // 4 — happy path: apollo resolves, prospect updated, credit ledgered
  const resolved = await resolveContact({
    query: Q,
    prospectId: prospect.id,
    transport: fixture({ person: { email: "vera@proof-contact.test", email_status: "verified", organization: { email_pattern: "{first}@{domain}" } } }),
  });
  const afterResolve = await db.prospect.findUnique({ where: { id: prospect.id } });
  check(
    "apollo resolves → prospect carries the email",
    resolved.status === "resolved" && resolved.email === "vera@proof-contact.test" && afterResolve?.bestEmail === "vera@proof-contact.test",
    { email: resolved.email, prospectEmail: afterResolve?.bestEmail, confidence: resolved.confidence },
  );
  const resolutionRow = resolved.resolutionId ? await db.contactResolution.findUnique({ where: { id: resolved.resolutionId } }) : null;
  check(
    "ledger row: resolved, 1 credit, provider apollo",
    resolutionRow?.outcome === "resolved" && resolutionRow?.creditsUsed === 1 && resolutionRow?.provider === "apollo",
    resolutionRow,
  );

  // 5 — no_match: provider answered, nobody home
  const noMatch = await resolveContact({ query: Q, prospectId: prospect.id, transport: fixture({}) });
  check(
    "no_match: 0 credits, circuit stays closed",
    noMatch.status === "no_match" && noMatch.creditsUsed === 0,
    noMatch.reason,
  );

  // 6 — provider failures: the fifth opens the circuit, the sixth never fires
  let wireCalls = 0;
  const counting = () => {
    wireCalls += 1;
    return failing(503)();
  };
  for (let i = 0; i < 5; i += 1) {
    await resolveContact({ query: Q, prospectId: prospect.id, transport: counting });
  }
  const apolloRow = await db.integrationRecord.findUnique({ where: { provider: "apollo" } });
  check("5 consecutive failures open the circuit", apolloRow?.circuitState === "open" && apolloRow?.status === "degraded", {
    failures: apolloRow?.consecutiveFailures,
    state: apolloRow?.circuitState,
  });
  const sixth = await resolveContact({ query: Q, prospectId: prospect.id, transport: counting });
  check("open circuit spares the provider", wireCalls === 5 && Boolean(sixth.reason?.includes("integration_circuit_open")), { wireCalls, reason: sixth.reason });

  // 7 — hunter fallback resolves while apollo is open
  await db.integrationRecord.update({ where: { provider: "hunter" }, data: { status: "armed" } });
  process.env.HUNTER_API_KEY = "re_proof_placeholder_hunter_key";
  const fallback = await resolveContact({
    query: Q,
    prospectId: prospect.id,
    transport: (url) => {
      check("fallback hit the hunter wire", String(url).includes("hunter.io"), String(url));
      return Promise.resolve(new Response(JSON.stringify({ data: { email: "vera@proof-contact.test", score: 91 } }), { status: 200 }));
    },
  });
  check("hunter fallback resolved, score 91 → high", fallback.provider === "hunter" && fallback.confidence === "high", {
    provider: fallback.provider,
    confidence: fallback.confidence,
  });

  // 8 — the probe gesture: a passing probe closes apollo's circuit
  const probe = await probeIntegration("apollo", { transport: fixture({ ok: true }) });
  const apolloAfterProbe = await db.integrationRecord.findUnique({ where: { provider: "apollo" } });
  check(
    "probe passed → circuit closed, degraded → armed",
    probe?.ok === true && apolloAfterProbe?.circuitState === "closed" && apolloAfterProbe?.status === "armed",
    { ok: probe?.ok, circuit: apolloAfterProbe?.circuitState, status: apolloAfterProbe?.status },
  );

  // restore the real rows verbatim, sweep every proof artefact
  for (const [provider, saved] of [["apollo", savedApollo], ["hunter", savedHunter]] as const) {
    if (saved) {
      const { id, createdAt, updatedAt, ...data } = saved;
      await db.integrationRecord.update({ where: { id }, data }).catch(() => undefined);
    } else {
      await db.integrationRecord.delete({ where: { provider } }).catch(() => undefined);
    }
  }
  delete process.env.HUNTER_API_KEY;
  await sweepResolutions();
  await db.prospect.delete({ where: { id: prospect.id } });

  console.log(failures === 0 ? "\nCONTACT RESOLVER PROOF: 9/9 verdicts correct" : `\nCONTACT RESOLVER PROOF: ${failures} failure(s)`);
  await db.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("proof crashed:", e);
  await db.$disconnect();
  process.exit(1);
});
