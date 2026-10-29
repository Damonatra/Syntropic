/**
 * Command centre seed — operational state for the Vertebra Executive Enclave.
 *
 * Seeds Modules 5-9 surfaces on top of the existing ingested pipeline:
 *   - LeadCluster rows (Module 7 theatres: Houston PVF, Midwest Electrical,
 *     Toronto HVAC)
 *   - erp_metadata / quote_portal_type / pitch angles (Module 5)
 *   - 48h TelemetryEvent backfill + high-intent IntentAlerts (Module 8)
 *   - InboundReply / AgentDraft triage states under tiered autonomy (Module 9)
 *
 * Idempotent: engine-seeded prospects and module 5-9 state are replaced on
 * each run; console-ingested prospects are preserved and enriched in place.
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

type FactorKey = "rfq_latency" | "legacy_portal" | "unapplied_spa" | "manual_quoting_share" | "vertical_fit" | "size_fit";

const WEIGHTS: Record<FactorKey, number> = {
  rfq_latency: 0.28,
  legacy_portal: 0.22,
  unapplied_spa: 0.18,
  manual_quoting_share: 0.14,
  vertical_fit: 0.1,
  size_fit: 0.08,
};

function bandForScore(score: number): string {
  if (score >= 85) return "critical";
  if (score >= 65) return "high";
  if (score >= 40) return "medium";
  return "low";
}

interface ScoreSpec {
  points: Record<FactorKey, number>;
  evidence: Record<FactorKey, string>;
  rationale: string;
}

function computeScore(spec: ScoreSpec): { qlvScore: number; factorsJson: string; hooksJson: string } {
  const factors = (Object.keys(WEIGHTS) as FactorKey[]).map((key) => ({
    key,
    weight: WEIGHTS[key],
    points: spec.points[key],
    evidence: spec.evidence[key],
  }));
  const total = Math.max(1, Math.min(100, Math.round(factors.reduce((sum, f) => sum + f.points * f.weight, 0))));
  const hooks = [
    {
      flavor: total >= 85 ? "rfq_latency" : "portal_drift",
      body: `Most distributors on this stack lose 6-14 hours per week re-keying RFQs between fax, email threads and their quoting system. If a quote request sits longer than a day, the contractor has already called the next house. Worth 15 minutes to see the numbers?`,
    },
  ];
  return {
    qlvScore: total,
    factorsJson: JSON.stringify(factors),
    hooksJson: JSON.stringify(hooks),
  };
}

const NOW = Date.now();
const minutesAgo = (m: number) => new Date(NOW - m * 60_000);
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000);
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000);

function erpDoc(input: {
  detectedErp: string;
  erpFamily: string;
  quotePortalType: string;
  jobPosts: Array<{ board: string; title: string; keyword: string; weeksAgo: number }>;
  pitchAngle: string;
  serverHeader: string;
  sslIssuer: string;
}): string {
  return JSON.stringify({
    detected_erp: input.detectedErp,
    erp_family: input.erpFamily,
    quote_portal_type: input.quotePortalType,
    evidence: {
      http_headers: { server: input.serverHeader, x_powered_by: null },
      ssl: { issuer: input.sslIssuer, days_to_expiry: 240 },
      job_posts: input.jobPosts.map((j) => ({
        board: j.board,
        title: j.title,
        keyword: j.keyword,
        posted_at: daysAgo(j.weeksAgo * 7).toISOString(),
      })),
    },
    job_signal_count: input.jobPosts.length,
    recommended_pitch_angle: input.pitchAngle,
    profiled_at: daysAgo(2).toISOString(),
  });
}

const ANGLE = {
  p21: "Prophet 21 REST hooks read their RFQ inbox directly — pitch the bi-directional quote sync into P21, not another portal to log into.",
  eclipse: "Epicor Eclipse quoting is desk-bound; pitch the intake layer that writes RFQs straight into Eclipse quote lines with SPA terms applied.",
  quickbooks: "No quote infrastructure at all — mailto RFQs rot in a shared inbox. Pitch the managed quote desk as their first system of record.",
  sage: "Sage 100 has no RFQ surface; pitch the quote desk that sits in front of Sage and pushes won quotes back as sales orders.",
  netsuite: "NetSuite handles orders, not quoting velocity — pitch RFQ intake with SLA timers that push hot quotes before lunch.",
  infor: "Infor CSI quoting is license-gated per seat; pitch the external intake layer that feeds CSI without added seats.",
  sap: "SAP B1 integration cycles are 9-month projects — pitch the zero-integration quote desk that exports clean B1-ready orders.",
  odoo: "Odoo CRM has half a quoting module — pitch the intake desk that completes the loop and syncs won quotes to Odoo sales.",
  kinetic: "Epicor Kinetic configures-to-order poorly for hose assemblies — pitch the parametric hose/fitting configurator on top.",
  s2k: "Vormittag S2K customers quote by spreadsheet — pitch the structured quote desk with S2K order export.",
};

interface ProspectSpec {
  name: string;
  domain: string;
  vertical: string;
  city: string;
  stateProvince: string;
  country: string;
  postalCode?: string;
  region: string;
  employees: number;
  revenue: number;
  lat: number;
  lng: number;
  cluster: string | null;
  detectedErp: string;
  erpFamily: string;
  portal: string;
  portalLabel: string;
  jobPosts: Array<{ board: string; title: string; keyword: string; weeksAgo: number }>;
  serverHeader: string;
  sslIssuer: string;
  contact: { firstName: string; lastName: string; role: string; titleRaw: string; phone: string; email: string; pattern: string };
  score: ScoreSpec;
  heat: number;
}

const SPECS: ProspectSpec[] = [
  {
    name: "Gulf Coast Valve & Fitting",
    domain: "gulfcoastvalve.com",
    vertical: "pvf", city: "Houston", stateProvince: "TX", country: "United States", postalCode: "77002",
    region: "us", employees: 74, revenue: 48_000_000, lat: 29.7604, lng: -95.3698, cluster: "houston_gulf_pvf",
    detectedErp: "Prophet 21", erpFamily: "epicor_p21", portal: "static_pdf_form", portalLabel: "static PDF quote form",
    jobPosts: [
      { board: "Indeed", title: "Inside Sales — Quoting Desk (P21)", keyword: "Prophet 21", weeksAgo: 3 },
      { board: "LinkedIn", title: "RFQ Coordinator", keyword: "RFQ", weeksAgo: 5 },
    ],
    serverHeader: "nginx/1.24.0", sslIssuer: "DigiCert TLS RSA SHA256 2020 CA1",
    contact: { firstName: "Marcus", lastName: "Webb", role: "coo", titleRaw: "Chief Operating Officer", phone: "+1 713 555 0148", email: "m.webb@gulfcoastvalve.com", pattern: "f.last@domain" },
    score: {
      points: { rfq_latency: 96, legacy_portal: 88, unapplied_spa: 94, manual_quoting_share: 92, vertical_fit: 95, size_fit: 100 },
      evidence: {
        rfq_latency: "PDF quote form returns quotes in 24-48h per mystery-shop",
        legacy_portal: "Static PDF RFQ form only; no portal session observed",
        unapplied_spa: "P21 SPA module present per job posts, unapplied to counter quotes",
        manual_quoting_share: "Quoting desk job post implies manual re-keying into P21",
        vertical_fit: "PVF — highest RFQ complexity fit",
        size_fit: "revenue $48M inside the corridor sweet spot",
      },
      rationale: "Critical band: P21 stack still quoting off a static PDF form with a dedicated manual quoting desk; mystery-shop latency 24-48h and no SPA enforcement on counter quotes.",
    },
    heat: 94,
  },
  {
    name: "Bayou Pipe & Supply Co",
    domain: "bayoupipe.com",
    vertical: "pvf", city: "Pasadena", stateProvince: "TX", country: "United States", postalCode: "77502",
    region: "us", employees: 38, revenue: 22_000_000, lat: 29.6911, lng: -95.2091, cluster: "houston_gulf_pvf",
    detectedErp: "QuickBooks", erpFamily: "quickbooks", portal: "manual_mailto", portalLabel: "manual mailto: RFQs",
    jobPosts: [{ board: "Indeed", title: "Estimating / Inside Sales", keyword: "estimating", weeksAgo: 2 }],
    serverHeader: "Apache/2.4.57", sslIssuer: "Let's Encrypt R3",
    contact: { firstName: "Dana", lastName: "Whitfield", role: "vp_operations", titleRaw: "VP Operations", phone: "+1 713 555 0193", email: "dwhitfield@bayoupipe.com", pattern: "lastfirst@domain" },
    score: {
      points: { rfq_latency: 92, legacy_portal: 95, unapplied_spa: 90, manual_quoting_share: 94, vertical_fit: 95, size_fit: 100 },
      evidence: {
        rfq_latency: "mailto: RFQ link; no intake system observable",
        legacy_portal: "Quote requests via sales@ mailbox only",
        unapplied_spa: "No SPA concept on QuickBooks stack",
        manual_quoting_share: "Estimator role posting confirms manual quotes",
        vertical_fit: "PVF — highest RFQ complexity fit",
        size_fit: "revenue $22M inside the corridor sweet spot",
      },
      rationale: "Critical band: QuickBooks-only stack with mailto RFQ intake and a dedicated estimator hire; every quote is hand-built from a shared inbox.",
    },
    heat: 71,
  },
  {
    name: "Magnolia Industrial Flange",
    domain: "magnoliaflange.com",
    vertical: "pvf", city: "Houston", stateProvince: "TX", country: "United States", postalCode: "77032",
    region: "us", employees: 52, revenue: 31_000_000, lat: 29.9802, lng: -95.4072, cluster: "houston_gulf_pvf",
    detectedErp: "Epicor Eclipse", erpFamily: "epicor_eclipse", portal: "legacy_portal", portalLabel: "legacy ASP.NET portal",
    jobPosts: [{ board: "LinkedIn", title: "Customer Service Rep — Eclipse", keyword: "Eclipse", weeksAgo: 8 }],
    serverHeader: "Microsoft-IIS/10.0", sslIssuer: "Sectigo RSA Domain Validation Secure Server CA",
    contact: { firstName: "Ray", lastName: "Ortega", role: "general_manager", titleRaw: "General Manager", phone: "+1 832 555 0117", email: "rortega@magnoliaflange.com", pattern: "lastfirst@domain" },
    score: {
      points: { rfq_latency: 78, legacy_portal: 82, unapplied_spa: 74, manual_quoting_share: 76, vertical_fit: 95, size_fit: 100 },
      evidence: {
        rfq_latency: "Legacy portal RFQ form, no status feedback",
        legacy_portal: "ASP.NET webforms portal circa 2011",
        unapplied_spa: "Eclipse SPA module licensed but CS-rep keyed",
        manual_quoting_share: "CS rep job post covers manual quote entry",
        vertical_fit: "PVF — highest RFQ complexity fit",
        size_fit: "revenue $31M inside the corridor sweet spot",
      },
      rationale: "High band: legacy IIS portal with Eclipse behind it; quotes keyed by CS reps, portal gives customers zero status feedback.",
    },
    heat: 58,
  },
  {
    name: "Port City PVF Distribution",
    domain: "portcitypvf.com",
    vertical: "pvf", city: "La Porte", stateProvince: "TX", country: "United States", postalCode: "77571",
    region: "us", employees: 29, revenue: 17_000_000, lat: 29.6657, lng: -95.0194, cluster: "houston_gulf_pvf",
    detectedErp: "Sage 100", erpFamily: "sage", portal: "manual_mailto", portalLabel: "manual mailto: RFQs",
    jobPosts: [],
    serverHeader: "cloudflare", sslIssuer: "Let's Encrypt E5",
    contact: { firstName: "Alicia", lastName: "Tran", role: "ops_director", titleRaw: "Director of Operations", phone: "+1 281 555 0166", email: "atran@portcitypvf.com", pattern: "firstlastinitial@domain" },
    score: {
      points: { rfq_latency: 74, legacy_portal: 92, unapplied_spa: 78, manual_quoting_share: 80, vertical_fit: 95, size_fit: 100 },
      evidence: {
        rfq_latency: "Contact form routes to shared mailbox",
        legacy_portal: "No quoting surface at all — mailto only",
        unapplied_spa: "No SPA enforcement possible on Sage 100",
        manual_quoting_share: "Two-person inside sales desk quotes everything",
        vertical_fit: "PVF — highest RFQ complexity fit",
        size_fit: "revenue $17M inside the corridor",
      },
      rationale: "High band: Sage 100 with no quoting surface whatsoever; all RFQs via a shared mailbox handled by a two-person desk.",
    },
    heat: 34,
  },
  {
    name: "Northline Electric Supply",
    domain: "northlineelectric.com",
    vertical: "electrical", city: "Chicago", stateProvince: "IL", country: "United States", postalCode: "60607",
    region: "us", employees: 96, revenue: 64_000_000, lat: 41.8781, lng: -87.6298, cluster: "chicago_midwest_electrical",
    detectedErp: "Epicor Eclipse", erpFamily: "epicor_eclipse", portal: "static_pdf_form", portalLabel: "static PDF quote form",
    jobPosts: [
      { board: "Indeed", title: "Quoting Specialist — Solar & Switchgear", keyword: "quoting", weeksAgo: 4 },
      { board: "LinkedIn", title: "Purchasing Agent", keyword: "procurement", weeksAgo: 6 },
    ],
    serverHeader: "nginx/1.25.2", sslIssuer: "DigiCert Global G2 TLS RSA SHA256 2022 CA1",
    contact: { firstName: "Peter", lastName: "Kowalski", role: "coo", titleRaw: "Chief Operating Officer", phone: "+1 312 555 0182", email: "pkowalski@northlineelectric.com", pattern: "firstlast@domain" },
    score: {
      points: { rfq_latency: 90, legacy_portal: 86, unapplied_spa: 84, manual_quoting_share: 88, vertical_fit: 70, size_fit: 100 },
      evidence: {
        rfq_latency: "PDF quote request form; 24h+ turnaround per trade referral",
        legacy_portal: "Static form only, no account portal",
        unapplied_spa: "Eclipse Eclipse SPA flags unused per job post language",
        manual_quoting_share: "Quoting specialist hire for solar/switchgear desk",
        vertical_fit: "Electrical — moderate RFQ complexity fit",
        size_fit: "revenue $64M inside the corridor sweet spot",
      },
      rationale: "Critical band: Eclipse shop quoting switchgear and solar packages off a static PDF with a specialist hire; large project quotes queue behind counter traffic.",
    },
    heat: 81,
  },
  {
    name: "Lakeshore Circuit & Control",
    domain: "lakeshorecircuit.com",
    vertical: "electrical", city: "Milwaukee", stateProvince: "WI", country: "United States", postalCode: "53202",
    region: "us", employees: 41, revenue: 27_000_000, lat: 43.0389, lng: -87.9065, cluster: "chicago_midwest_electrical",
    detectedErp: "NetSuite", erpFamily: "netsuite", portal: "legacy_portal", portalLabel: "legacy portal",
    jobPosts: [{ board: "LinkedIn", title: "Quote Desk Administrator", keyword: "quote desk", weeksAgo: 7 }],
    serverHeader: "AkamaiGHost", sslIssuer: "Entrust Certification Authority - L1K",
    contact: { firstName: "Imani", lastName: "Brooks", role: "vp_purchasing", titleRaw: "VP Purchasing", phone: "+1 414 555 0129", email: "ibrooks@lakeshorecircuit.com", pattern: "firstlastinitial@domain" },
    score: {
      points: { rfq_latency: 72, legacy_portal: 70, unapplied_spa: 66, manual_quoting_share: 74, vertical_fit: 70, size_fit: 100 },
      evidence: {
        rfq_latency: "Portal RFQs manually triaged by quote desk admin",
        legacy_portal: "Portal exists but quote status invisible to customers",
        unapplied_spa: "NetSuite RP module unconfigured for supplier SPAs",
        manual_quoting_share: "Dedicated quote desk administrator posting",
        vertical_fit: "Electrical — moderate RFQ complexity fit",
        size_fit: "revenue $27M inside the corridor sweet spot",
      },
      rationale: "High band: NetSuite backend with a manual quote desk layered on top; portal exists but customers still call for status.",
    },
    heat: 44,
  },
  {
    name: "Prairie State Conduit",
    domain: "prairieconduit.com",
    vertical: "electrical", city: "Joliet", stateProvince: "IL", country: "United States", postalCode: "60431",
    region: "us", employees: 22, revenue: 14_000_000, lat: 41.525, lng: -88.0817, cluster: "chicago_midwest_electrical",
    detectedErp: "QuickBooks", erpFamily: "quickbooks", portal: "manual_mailto", portalLabel: "manual mailto: RFQs",
    jobPosts: [],
    serverHeader: "LiteSpeed", sslIssuer: "Let's Encrypt R3",
    contact: { firstName: "Sal", lastName: "DiMarco", role: "owner", titleRaw: "Owner", phone: "+1 815 555 0171", email: "sal@prairieconduit.com", pattern: "first@domain" },
    score: {
      points: { rfq_latency: 84, legacy_portal: 94, unapplied_spa: 86, manual_quoting_share: 88, vertical_fit: 70, size_fit: 100 },
      evidence: {
        rfq_latency: "mailto: quotes answered evenings by owner",
        legacy_portal: "No quote surface — Gmail mailbox is the intake",
        unapplied_spa: "No SPA capability on QuickBooks",
        manual_quoting_share: "Owner builds every quote personally",
        vertical_fit: "Electrical — moderate RFQ complexity fit",
        size_fit: "revenue $14M inside the corridor",
      },
      rationale: "High band: QuickBooks shop where the owner personally quotes everything from a Gmail mailbox — classic single-point quote leakage.",
    },
    heat: 39,
  },
  {
    name: "Maple Climate Systems",
    domain: "mapleclimate.ca",
    vertical: "hvac", city: "Toronto", stateProvince: "ON", country: "Canada", postalCode: "M5V 2T6",
    region: "ca", employees: 60, revenue: 38_000_000, lat: 43.6532, lng: -79.3832, cluster: "toronto_gta_hvac",
    detectedErp: "Infor CSI", erpFamily: "infor", portal: "legacy_portal", portalLabel: "legacy portal",
    jobPosts: [{ board: "Indeed", title: "Technical Quoting Analyst", keyword: "quoting", weeksAgo: 3 }],
    serverHeader: "AkamaiGHost", sslIssuer: "DigiCert Global G2 TLS RSA SHA256 2022 CA1",
    contact: { firstName: "Harpreet", lastName: "Singh", role: "coo", titleRaw: "Chief Operating Officer", phone: "+1 416 555 0134", email: "hsingh@mapleclimate.ca", pattern: "lastfirstinitial@domain" },
    score: {
      points: { rfq_latency: 82, legacy_portal: 78, unapplied_spa: 72, manual_quoting_share: 80, vertical_fit: 80, size_fit: 100 },
      evidence: {
        rfq_latency: "Portal form + 48h promise on engineered submittals",
        legacy_portal: "Portal session required; mobile flow broken",
        unapplied_spa: "CSI quoting seat-gated; analysts queue",
        manual_quoting_share: "Technical quoting analyst hire signals manual load",
        vertical_fit: "HVAC — strong engineered-systems fit",
        size_fit: "revenue $38M inside the corridor sweet spot",
      },
      rationale: "Critical band: Infor CSI shop with seat-gated quoting and a 48h engineered-submittal promise; analyst hire confirms the queue is human-limited.",
    },
    heat: 66,
  },
  {
    name: "Huron Heating & Air Supply",
    domain: "huronhvac.ca",
    vertical: "hvac", city: "Kitchener", stateProvince: "ON", country: "Canada", postalCode: "N2G 1A1",
    region: "ca", employees: 31, revenue: 19_000_000, lat: 43.4516, lng: -80.4925, cluster: "toronto_gta_hvac",
    detectedErp: "Sage 100", erpFamily: "sage", portal: "manual_mailto", portalLabel: "manual mailto: RFQs",
    jobPosts: [],
    serverHeader: "Apache/2.4.41", sslIssuer: "Let's Encrypt R3",
    contact: { firstName: "Erin", lastName: "Walsh", role: "ops_manager", titleRaw: "Operations Manager", phone: "+1 519 555 0119", email: "ewalsh@huronhvac.ca", pattern: "firstlastinitial@domain" },
    score: {
      points: { rfq_latency: 66, legacy_portal: 88, unapplied_spa: 70, manual_quoting_share: 72, vertical_fit: 80, size_fit: 100 },
      evidence: {
        rfq_latency: "mailto: intake; quotes overnight batch",
        legacy_portal: "No quote surface; PDF price lists emailed",
        unapplied_spa: "No SPA on Sage stack",
        manual_quoting_share: "Two inside sales reps quote all PM jobs",
        vertical_fit: "HVAC — strong engineered-systems fit",
        size_fit: "revenue $19M inside the corridor",
      },
      rationale: "High band: Sage 100 with mailto intake and PDF price lists; PM quotes batch overnight and expire against faster competitors.",
    },
    heat: 28,
  },
];

const CLUSTERS = [
  { clusterKey: "houston_gulf_pvf", clusterName: "Gulf Coast PVF Corridor", anchorCity: "Houston", anchorCountry: "United States", centroidLat: 29.7604, centroidLng: -95.3698, radiusM: 45_000, verticalFocus: "pvf" },
  { clusterKey: "chicago_midwest_electrical", clusterName: "Midwest Electrical Belt", anchorCity: "Chicago", anchorCountry: "United States", centroidLat: 41.8781, centroidLng: -87.6298, radiusM: 60_000, verticalFocus: "electrical" },
  { clusterKey: "toronto_gta_hvac", clusterName: "Greater Toronto HVAC Arc", anchorCity: "Mississauga", anchorCountry: "Canada", centroidLat: 43.589, centroidLng: -79.6441, radiusM: 55_000, verticalFocus: "hvac" },
];

const EXISTING_ENRICHMENT: Record<string, { lat: number; lng: number; portal: string; portalLabel: string; erpFamily: string; cluster: string | null; heat: number }> = {
  "keystone pipe & fitting co": { lat: 41.4993, lng: -81.6944, portal: "manual_mailto", portalLabel: "manual mailto: RFQs", erpFamily: "quickbooks", cluster: null, heat: 31 },
  "harbour fluid power": { lat: 43.2557, lng: -79.8711, portal: "legacy_portal", portalLabel: "legacy portal", erpFamily: "sage", cluster: "toronto_gta_hvac", heat: 40 },
  "northern hydronics ltd": { lat: 43.589, lng: -79.6441, portal: "manual_mailto", portalLabel: "manual mailto: RFQs", erpFamily: "quickbooks", cluster: "toronto_gta_hvac", heat: 25 },
  "meridian electric supply": { lat: 39.9612, lng: -82.9988, portal: "legacy_portal", portalLabel: "legacy portal", erpFamily: "sap", cluster: null, heat: 12 },
  "superior valve & fitting": { lat: 40.4406, lng: -79.9959, portal: "static_pdf_form", portalLabel: "static PDF quote form", erpFamily: "epicor_eclipse", cluster: null, heat: 36 },
};

function angleFor(spec: { erpFamily: string }): string {
  const map: Record<string, string> = {
    epicor_p21: ANGLE.p21, epicor_eclipse: ANGLE.eclipse, quickbooks: ANGLE.quickbooks, sage: ANGLE.sage,
    netsuite: ANGLE.netsuite, infor: ANGLE.infor, sap: ANGLE.sap, odoo: ANGLE.odoo,
    epicor_kinetic: ANGLE.kinetic,
  };
  return map[spec.erpFamily] ?? ANGLE.quickbooks;
}

const DEVICE_DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const DEVICE_MOBILE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

function eventUrl(type: string): string {
  switch (type) {
    case "portal_visit": return "https://syntropic.engine/portal";
    case "audit_view": return "https://syntropic.engine/audit";
    case "document_download": return "https://syntropic.engine/assets/quote-leakage-audit.pdf";
    case "pricing_view": return "https://syntropic.engine/portal#engagement";
    default: return "https://syntropic.engine/portal";
  }
}

async function main() {
  console.log("[seed] clearing module 5-9 state…");
  await db.operatorAction.deleteMany();
  await db.intentAlert.deleteMany();
  await db.inboundReply.deleteMany();
  await db.telemetryEvent.deleteMany();
  await db.prospect.deleteMany({ where: { source: "engine-seed" } });
  await db.leadCluster.deleteMany();

  console.log("[seed] upserting tactical clusters…");
  const clusterIds = new Map<string, string>();
  for (const c of CLUSTERS) {
    const row = await db.leadCluster.create({ data: { ...c, densityCount: 0 } });
    clusterIds.set(c.clusterKey, row.id);
  }

  console.log("[seed] creating engine-seed prospects…");
  const byDomain = new Map<string, string>();
  for (const s of SPECS) {
    const score = computeScore(s.score);
    const domainKey = s.domain;
    const prospect = await db.prospect.upsert({
      where: { source_domainKey: { source: "engine-seed", domainKey } },
      update: {},
      create: {
        source: "engine-seed",
        sourceUrl: `https://${s.domain}`,
        name: s.name,
        domainKey,
        domain: s.domain,
        website: `https://${s.domain}`,
        vertical: s.vertical,
        region: s.region,
        city: s.city,
        stateProvince: s.stateProvince,
        country: s.country,
        postalCode: s.postalCode ?? null,
        employeeCount: s.employees,
        revenueEstimateUsd: s.revenue,
        revenueConfidence: "directory_range",
        detectedErp: s.detectedErp,
        erpMetadata: erpDoc({
          detectedErp: s.detectedErp, erpFamily: s.erpFamily, quotePortalType: s.portal,
          jobPosts: s.jobPosts, pitchAngle: angleFor(s), serverHeader: s.serverHeader, sslIssuer: s.sslIssuer,
        }),
        quotePortalType: s.portal,
        latitude: s.lat,
        longitude: s.lng,
        clusterId: s.cluster ? clusterIds.get(s.cluster)! : null,
        lastIntentHeat: s.heat,
        ingestion: "ingested",
        caslScope: s.region === "ca",
        caslReason: s.region === "ca" ? "ca_domain" : null,
        bestEmail: s.contact.email,
        emailPattern: s.contact.pattern,
      },
    });
    await db.contact.create({
      data: {
        prospectId: prospect.id,
        firstName: s.contact.firstName,
        lastName: s.contact.lastName,
        role: s.contact.role,
        titleRaw: s.contact.titleRaw,
        phone: s.contact.phone,
      },
    });
    await db.score.create({
      data: {
        prospectId: prospect.id,
        qlvScore: score.qlvScore,
        band: bandForScore(score.qlvScore),
        factorsJson: score.factorsJson,
        hooksJson: score.hooksJson,
        rationale: s.score.rationale,
        model: "vertebra-rubric-1.0",
        fingerprint: `seed:${s.domain}`,
      },
    });
    byDomain.set(s.domain, prospect.id);
    console.log(`  + ${s.name}  qlv=${score.qlvScore}`);
  }

  console.log("[seed] enriching console-ingested prospects (Module 5/7)…");
  const existing = await db.prospect.findMany({ where: { source: { not: "engine-seed" } } });
  for (const p of existing) {
    const enrich = EXISTING_ENRICHMENT[p.name.toLowerCase()];
    if (!enrich) continue;
    await db.prospect.update({
      where: { id: p.id },
      data: {
        quotePortalType: enrich.portal,
        latitude: enrich.lat,
        longitude: enrich.lng,
        clusterId: enrich.cluster ? clusterIds.get(enrich.cluster) ?? null : null,
        lastIntentHeat: Math.max(p.lastIntentHeat, enrich.heat),
        erpMetadata: erpDoc({
          detectedErp: p.detectedErp ?? "Unknown", erpFamily: enrich.erpFamily, quotePortalType: enrich.portal,
          jobPosts: [], pitchAngle: angleFor({ erpFamily: enrich.erpFamily }),
          serverHeader: "nginx", sslIssuer: "n/a (sandbox profile)",
        }),
      },
    });
  }

  console.log("[seed] cluster density…");
  for (const [key, id] of clusterIds) {
    const count = await db.prospect.count({ where: { clusterId: id } });
    await db.leadCluster.update({ where: { id }, data: { densityCount: count } });
    console.log(`  ${key}: ${count} members`);
  }

  console.log("[seed] telemetry backfill (48h)…");
  const all = await db.prospect.findMany({ include: { scores: { orderBy: { createdAt: "desc" }, take: 1 }, cluster: true } });
  const highSignal = new Set(["portal_visit", "audit_view", "document_download"]);
  const typeWeights: Array<[string, number]> = [
    ["portal_visit", 0.3], ["pricing_view", 0.22], ["session_end", 0.14], ["audit_view", 0.18], ["document_download", 0.16],
  ];
  const pickType = (r: number): string => {
    let acc = 0;
    for (const [t, w] of typeWeights) { acc += w; if (r <= acc) return t; }
    return "session_end";
  };

  interface Pinned { domain: string; type: string; minutes: number; duration?: number; device?: "desktop" | "mobile" }
  const pinned: Pinned[] = [
    { domain: "gulfcoastvalve.com", type: "portal_visit", minutes: 6, duration: 214_000, device: "desktop" },
    { domain: "gulfcoastvalve.com", type: "audit_view", minutes: 14, duration: 96_000, device: "desktop" },
    { domain: "gulfcoastvalve.com", type: "document_download", minutes: 38, device: "desktop" },
    { domain: "gulfcoastvalve.com", type: "portal_visit", minutes: 180, duration: 88_000 },
    { domain: "northlineelectric.com", type: "document_download", minutes: 41, device: "desktop" },
    { domain: "northlineelectric.com", type: "audit_view", minutes: 55, duration: 122_000, device: "desktop" },
    { domain: "northlineelectric.com", type: "portal_visit", minutes: 126, duration: 64_000 },
    { domain: "mapleclimate.ca", type: "pricing_view", minutes: 95, duration: 58_000 },
    { domain: "bayoupipe.com", type: "portal_visit", minutes: 210, duration: 41_000 },
    { domain: "superiorvalve.com", type: "pricing_view", minutes: 320, duration: 36_000 },
  ];

  let eventCount = 0;
  for (const p of all) {
    const score = p.scores[0]?.qlvScore ?? 0;
    const spec = SPECS.find((s) => s.domain === p.domain);
    const geo = { city: p.city, country: p.country, latitude: p.latitude, longitude: p.longitude };
    const history = spec ? 5 + Math.floor(score / 18) : 2 + Math.floor(score / 30);
    for (let i = 0; i < history; i++) {
      const type = pickType(Math.random());
      const at = hoursAgo(3 + Math.random() * 45);
      const device = Math.random() > 0.72 ? "mobile" : "desktop";
      await db.telemetryEvent.create({
        data: {
          prospectId: p.id,
          sessionId: `seed-${p.id.slice(-6)}-${i}`,
          eventType: type,
          url: eventUrl(type),
          referrer: i % 3 === 0 ? "https://mail.google.com/" : "direct",
          ...geo,
          userAgent: device === "mobile" ? DEVICE_MOBILE : DEVICE_DESKTOP,
          device,
          durationMs: type === "session_end" ? 45_000 + Math.floor(Math.random() * 180_000) : null,
          payloadJson: JSON.stringify({ seeded: true, qlv_at_event: score }),
          occurredAt: at,
        },
      });
      eventCount += 1;
    }
  }
  for (const pin of pinned) {
    const pid = byDomain.get(pin.domain) ?? (await db.prospect.findFirst({ where: { domainKey: pin.domain } }))?.id;
    if (!pid) continue;
    const p = await db.prospect.findUniqueOrThrow({ where: { id: pid }, include: { scores: { take: 1, orderBy: { createdAt: "desc" } } } });
    const score = p.scores[0]?.qlvScore ?? 0;
    const device = pin.device ?? "desktop";
    await db.telemetryEvent.create({
      data: {
        prospectId: pid,
        sessionId: `live-${pin.type}-${pin.minutes}`,
        eventType: pin.type,
        url: eventUrl(pin.type),
        referrer: "direct",
        city: p.city, country: p.country, latitude: p.latitude, longitude: p.longitude,
        userAgent: device === "mobile" ? DEVICE_MOBILE : DEVICE_DESKTOP,
        device,
        durationMs: pin.duration ?? null,
        payloadJson: JSON.stringify({ seeded: true, qlv_at_event: score }),
        occurredAt: minutesAgo(pin.minutes),
      },
    });
    eventCount += 1;
  }
  console.log(`  ${eventCount} telemetry events`);

  console.log("[seed] high-intent alerts…");
  const alertSpecs = [
    { domain: "gulfcoastvalve.com", minutes: 6, eventType: "portal_visit" },
    { domain: "northlineelectric.com", minutes: 41, eventType: "document_download" },
  ];
  for (const a of alertSpecs) {
    const pid = byDomain.get(a.domain);
    if (!pid) continue;
    const p = await db.prospect.findUniqueOrThrow({ where: { id: pid }, include: { contacts: true, scores: { take: 1, orderBy: { createdAt: "desc" } }, cluster: true } });
    const contact = p.contacts[0];
    const score = p.scores[0]?.qlvScore ?? 0;
    if (score < 85) continue;
    const exec = contact ? `${contact.firstName} ${contact.lastName} (${contact.titleRaw}) — ${contact.phone ?? "direct line pending"}` : "Primary contact pending";
    await db.intentAlert.create({
      data: {
        prospectId: pid,
        title: "HIGH-INTENT PROSPECT ON PORTAL",
        body: [
          `Company: ${p.name}`,
          `Executive: ${exec}`,
          `Location: ${p.city}, ${p.country}`,
          `Action: Call direct line immediately.`,
        ].join("\n"),
        dedupeKey: `hi:${pid}:${a.eventType}:${Math.floor(Date.now() / 3_600_000)}`,
        channelsAttempted: JSON.stringify(["in_app", "telegram", "slack"]),
        channelsDelivered: JSON.stringify(["in_app"]),
        delivered: true,
        createdAt: minutesAgo(a.minutes),
      },
    });
    console.log(`  alert: ${p.name}`);
  }

  console.log("[seed] dispatch sequences (Module 4 states)…");
  const hookFor = (name: string, flavor: string) =>
    flavor === "rfq_latency"
      ? `Most distributors lose 6-14 hours a week re-keying RFQs between fax, email and their quoting system. At ${name}, that shows up as quotes that leave after the contractor already called the next house. Worth 15 minutes to see the numbers?`
      : `Teams on legacy quoting portals tell us the same story: status lives in someone's inbox, and customers call asking where their RFQ went. There is a cleaner way to run this at ${name}.`;
  const stepStatuses = ["sent", "opened", "clicked"] as const;
  for (const p of all) {
    const score = p.scores[0]?.qlvScore ?? 0;
    if (score < 70) continue;
    const steps = score >= 85 ? 3 : 2;
    for (let step = 1; step <= steps; step++) {
      const status = p.lastIntentHeat > 60 && step === steps ? "clicked" : stepStatuses[Math.min(step - 1, 2)];
      await db.dispatch.create({
        data: {
          prospectId: p.id,
          channel: "channel_a_automated_email",
          status: p.ingestion === "filtered" ? "suppressed" : status,
          caslScope: p.caslScope,
          subject: `Quote leakage at ${p.name} — the 15-minute version`,
          body: hookFor(p.name, score >= 85 ? "rfq_latency" : "portal_drift"),
          fromDomain: "josias@syntropic.engine",
          provider: "resend",
          providerMsgId: `seed-${p.id.slice(-6)}-${step}`,
          footerApplied: "syntropic-standard-v3",
          createdAt: daysAgo(steps - step + 1),
          updatedAt: hoursAgo(2 + step),
        },
      });
    }
    if (score >= 85) {
      await db.highTouchQueueItem.upsert({
        where: { prospectId: p.id },
        update: { qlvScore: score, exportedAt: null },
        create: {
          prospectId: p.id,
          qlvScore: score,
          qlvBand: bandForScore(score),
          topHook: hookFor(p.name, "rfq_latency").slice(0, 140),
          rationale: `QLV ${score}/100 — ${p.detectedErp ?? "unknown ERP"} with ${(p.quotePortalType ?? "manual").replace(/_/g, " ")}. Cluster: ${p.cluster?.clusterName ?? "unclustered"}.`,
        },
      });
    }
  }

  console.log("[seed] Module 9 triage states (tiered autonomy)…");
  const replySpecs: Array<{
    domain: string; intent: string; confidence: number; fromEmail: string; subject: string; body: string;
    draft?: { subject: string; body: string; autoSent?: boolean };
    rationale: string;
  }> = [
    {
      domain: "gulfcoastvalve.com", intent: "interested", confidence: 0.94,
      fromEmail: "m.webb@gulfcoastvalve.com",
      subject: "Re: Quote leakage at Gulf Coast Valve — the 15-minute version",
      body: "Your leakage math on our mailto flow is close — closer than I'd like. Our quoting desk is drowning during turnaround season. Can you walk our ops team through it Thursday morning?",
      draft: {
        subject: "Thursday works — bringing the Gulf Coast numbers",
        body: "Marcus — Thursday 9:00 CT works. I'll bring the mystery-shop latency data for three Houston PVF houses (yours anonymized), the P21 quote-sync walkthrough, and a one-page costed rollout. 20 minutes, then your ops team takes over. Sending a calendar hold now. — Josias",
      },
      rationale: "Direct meeting request referencing the audit math — route to Channel B calendar flow immediately.",
    },
    {
      domain: "magnoliaflange.com", intent: "objection_erp", confidence: 0.88,
      fromEmail: "rortega@magnoliaflange.com",
      subject: "Re: Quote leakage at Magnolia Industrial Flange",
      body: "We just spent 14 months and a lot of money getting Eclipse stable. I'm not bolting another system onto it this year. Who maintains your side of the integration when Eclipse updates break it?",
      draft: {
        subject: "Re: Re: Quote leakage at Magnolia Industrial Flange",
        body: "Ray — fair challenge, and you're right to ask. The intake layer doesn't touch Eclipse at all: RFQs land structured in the quote desk, your CS team approves, and the won quote exports as a clean Eclipse order entry import. No API coupling, no breaking updates on your side. If you want, I'll send the two-paragraph integration memo your IT lead can veto line by line. — Josias",
      },
      rationale: "ERP-switching-cost objection — needs a specific zero-coupling answer before any call; human review required.",
    },
    {
      domain: "superiorvalve.com", intent: "objection_price", confidence: 0.91,
      fromEmail: "jsnyder@superiorvalve.com",
      subject: "Re: Quote leakage at Superior Valve & Fitting",
      body: "Interesting audit, but your pricing is 3x what we pay our answering service and we've survived 30 years without a quote desk platform. Make the ROI case or we're done here.",
      draft: {
        subject: "The ROI case, in your own numbers",
        body: "Jared — done here is fair if the math doesn't hold, so here it is in your numbers: $41M revenue, 72 QLV means roughly $610K/yr in net margin walking out through late and unapplied-SPA quotes. The desk costs a fraction of that, and the audit PDF shows the three leak points we'd close first. If the ratio isn't 5:1 on your own numbers, I'll say so and leave you alone. — Josias",
      },
      rationale: "Price objection with explicit ROI demand — respond with prospect-specific leakage math, never a discount; human review required.",
    },
    {
      domain: "harbourfp.ca", intent: "send_information", confidence: 0.96,
      fromEmail: "gmetcalfe@harbourfp.ca",
      subject: "Re: Quote leakage at Harbour Fluid Power",
      body: "Send me the one-pager and the audit sample. No calls yet — I'll circulate it internally first.",
      draft: {
        subject: "The one-pager + audit sample, as requested",
        body: "Graham — attached: the one-pager and a redacted audit sample from a fluid-power house your size. No call scheduled; when you've circulated it, reply with a time and I'll work around your team. — Josias",
      },
      rationale: "Explicit information request — tier 1 autonomy: auto-acknowledge with collateral, no human gate.",
    },
    {
      domain: "northernhydronics.ca", intent: "out_of_office", confidence: 0.98,
      fromEmail: "d.kearns@northernhydronics.ca",
      subject: "Automatic reply: Quote leakage at Northern Hydronics",
      body: "I'm away from the office until Monday, August 12 with limited email access. For urgent matters contact the main line. — Darryl",
      rationale: "Out-of-office — tier 1 autonomy: no draft; sequence rescheduled past the return date.",
    },
    {
      domain: "prairieconduit.com", intent: "not_interested", confidence: 0.9,
      fromEmail: "sal@prairieconduit.com",
      subject: "Re: Quote leakage at Prairie State Conduit",
      body: "Appreciate the note but we're a two-man shop and happy that way. Take us off the list.",
      rationale: "Explicit decline — tier 1 autonomy: no draft; sequences stopped, prospect closed politely.",
    },
  ];

  for (const r of replySpecs) {
    const pid = byDomain.get(r.domain) ?? (await db.prospect.findFirst({ where: { domainKey: r.domain } }))?.id;
    if (!pid) continue;
    const tier1 = r.intent === "send_information" || r.intent === "out_of_office" || r.intent === "not_interested";
    const receivedAt = hoursAgo(2 + Math.random() * 20);
    const reply = await db.inboundReply.create({
      data: {
        prospectId: pid,
        messageId: `seed-rePLY-${r.domain}-${Math.floor(Math.random() * 99999)}`,
        fromEmail: r.fromEmail,
        subject: r.subject,
        body: r.body,
        intent: r.intent,
        intentConfidence: r.confidence,
        rationale: r.rationale,
        extractedJson: r.intent === "out_of_office" ? JSON.stringify({ return_date: daysAgo(-9).toISOString().slice(0, 10) }) : null,
        processedAt: new Date(receivedAt.getTime() + 90_000),
        receivedAt,
      },
    });
    if (r.draft) {
      await db.agentDraft.create({
        data: {
          replyId: reply.id,
          prospectId: pid,
          intent: r.intent,
          subject: r.draft.subject,
          body: r.draft.body,
          status: r.draft.autoSent ? "sent" : "pending_human_review",
          sentAt: r.draft.autoSent ? new Date(receivedAt.getTime() + 120_000) : null,
        },
      });
    }
    if (r.intent === "not_interested") {
      await db.dispatch.updateMany({ where: { prospectId: pid, channel: "channel_a_automated_email" }, data: { status: "stopped" } });
    }
    if (r.intent === "out_of_office") {
      await db.dispatch.updateMany({
        where: { prospectId: pid, channel: "channel_a_automated_email", status: { in: ["queued", "sent", "opened"] } },
        data: { status: "queued", scheduledAt: daysAgo(-9) },
      });
    }
  }

  console.log("[seed] operator action history…");
  const gulf = byDomain.get("gulfcoastvalve.com");
  if (gulf) {
    await db.operatorAction.create({
      data: { prospectId: gulf, action: "called", note: "Left voicemail referencing the audit PDF. Callback expected before Thursday.", createdAt: hoursAgo(20) },
    });
    await db.operatorAction.create({
      data: { prospectId: gulf, action: "booked", note: "Tentative Thursday 09:00 CT — pending calendar confirmation.", createdAt: minutesAgo(30) },
    });
  }

  console.log("[seed] done.");
  const summary = {
    prospects: await db.prospect.count(),
    clusters: await db.leadCluster.count(),
    telemetry: await db.telemetryEvent.count(),
    alerts: await db.intentAlert.count(),
    replies: await db.inboundReply.count(),
    drafts: await db.agentDraft.count(),
    dispatches: await db.dispatch.count(),
    highTouch: await db.highTouchQueueItem.count(),
    operatorActions: await db.operatorAction.count(),
  };
  console.log(JSON.stringify(summary, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
