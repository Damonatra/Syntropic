/**
 * Contract parity check — Prisma schema (console/SQLite) vs vertebra engine
 * DDL (vertebra/db/migrations.sql, Neon Postgres).
 *
 * The two schemas mirror the same contracts by hand; this script fails the
 * build when a table/column exists on one side only. Best-effort static
 * parse — enough to catch drift, not a SQL parser.
 *
 * Run: bun run scripts/parity_check.ts   (exit 1 on drift)
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const prismaPath = path.join(root, "prisma", "schema.prisma");
const ddlPath = path.join(root, "vertebra", "db", "migrations.sql");

// --------------------------------------------------------------------------- //
// Parse prisma models → { table: Set<column> }
// --------------------------------------------------------------------------- //

const SQLITE_TO_PG: Record<string, string> = {
  String: "text",
  Int: "integer",
  Float: "double precision",
  Boolean: "boolean",
  DateTime: "timestamptz",
};

function parsePrisma(src: string): Map<string, Set<string>> {
  const models = new Map<string, Set<string>>();
  const modelRe = /^model\s+(\w+)\s*\{([^}]*)\}/gm;
  for (const [, table, body] of src.matchAll(modelRe)) {
    const cols = new Set<string>();
    for (const line of body.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("//") || t.startsWith("@@") || t.startsWith("///")) continue;
      // Type may end the line (aligned schema style) — require word boundary, not whitespace.
      const m = t.match(/^(\w+)\s+([A-Za-z]+)(\[\])?\??(?:\s|$)/);
      if (!m) continue;
      const [, name, type] = m;
      // Skip relation fields (typed as another model).
      if (["String", "Int", "Float", "Boolean", "DateTime"].includes(type)) {
        cols.add(name);
      }
    }
    models.set(table, cols);
  }
  return models;
}

// --------------------------------------------------------------------------- //
// Parse engine DDL → { table: Set<column> }
// --------------------------------------------------------------------------- //

function parseDdl(src: string): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();
  const createRe = /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\n\)/gi;
  for (const [, table, body] of src.matchAll(createRe)) {
    const cols = new Set<string>();
    for (const line of body.split("\n")) {
      const t = line.trim().replace(/,$/, "");
      if (!t || t.startsWith("--")) continue;
      if (/^(PRIMARY KEY|FOREIGN KEY|UNIQUE|CHECK|CONSTRAINT)\b/i.test(t)) continue;
      const m = t.match(/^(\w+)\s+/);
      if (m) cols.add(m[1]);
    }
    tables.set(table.toLowerCase(), cols);
  }
  // Columns added later via ALTER TABLE are part of the contract too.
  const alterRe = /ALTER TABLE\s+(\w+)\s+ADD COLUMN IF NOT EXISTS\s+(\w+)/gi;
  for (const [, table, col] of src.matchAll(alterRe)) {
    const cols = tables.get(table.toLowerCase());
    if (cols) cols.add(col);
  }
  return tables;
}

// --------------------------------------------------------------------------- //
// Compare
// --------------------------------------------------------------------------- //

// Prisma model → engine table. Console models are PascalCase singular;
// the engine uses snake_case plurals (two exceptions are engine-side names).
const NAME_MAP: Record<string, string> = {
  Prospect: "prospects",
  Contact: "contacts",
  Score: "scores",
  Dispatch: "dispatches",
  OutboxEvent: "outbox",
  HighTouchQueueItem: "high_touch_queue",
  LeadCluster: "lead_clusters",
  TelemetryEvent: "telemetry_events",
  IntentAlert: "intent_alerts",
  InboundReply: "inbound_replies",
  AgentDraft: "agent_drafts",
  OperatorAction: "operator_actions",
  SuppressionRecord: "suppressions",
  AuditDocument: "audit_documents",
};

// Intentional divergences the engine owns and the console collapses.
const ENGINE_ONLY_TABLES = new Set(["email_candidates"]);

// Tables the engine stores deliberately denormalized — table-level check only.
const STRUCTURAL_EXCEPTIONS = new Set(["high_touch_queue"]);

// Known contract renames between the console field and the engine column.
const COLUMN_ALIASES: Record<string, string[]> = {
  fingerprint: ["input_fingerprint"],
  createdAt: ["scored_at", "sent_at", "scraped_at", "created_at"],
  scheduledAt: ["send_after"],
  extractedJson: ["extracted"],
  payloadJson: ["payload"],
  findingsJson: ["findings"],
  factorsJson: ["factors"],
  hooksJson: ["hooks"],
  domainKey: ["domain", "name"], // engine dedupes on domain/company identity
  lastIntentHeat: ["intent_heat"],
  fromDomain: ["from_domain"],
  providerMsgId: ["provider_msg_id"],
  footerApplied: ["footer_applied"],
};

// Console-only columns (the engine stores the equivalent elsewhere — e.g.
// emailPattern lives in email_candidates.pattern) — tolerated drift.
const CONSOLE_ONLY_COLUMNS = new Set(["prospects.email_pattern"]);

// Engine-only columns with no SQLite equivalent (PostGIS geography, etc.).
const ENGINE_ONLY_COLUMNS = new Set(["lead_clusters.centroid_geog"]);

const prismaModels = parsePrisma(readFileSync(prismaPath, "utf8"));
const ddlTables = existsSync(ddlPath) ? parseDdl(readFileSync(ddlPath, "utf8")) : new Map();

const drift: string[] = [];

for (const [model, cols] of prismaModels) {
  const tableName = NAME_MAP[model] ?? model.toLowerCase();
  const table = ddlTables.get(tableName);
  if (!table) {
    drift.push(`[engine missing] ${model}: no CREATE TABLE for ${tableName} in migrations.sql`);
    continue;
  }
  // Prisma camelCase → Postgres snake_case columns.
  for (const col of cols) {
    const snake = col.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    const aliases = (COLUMN_ALIASES[col] ?? []).map((a) => a.toLowerCase());
    if (
      !table.has(col) &&
      !table.has(snake) &&
      !aliases.some((a) => table.has(a)) &&
      !CONSOLE_ONLY_COLUMNS.has(`${tableName}.${snake}`)
    ) {
      drift.push(`[column missing in engine] ${model}.${col} (${tableName})`);
    }
  }
}
for (const [table, cols] of ddlTables) {
  if (ENGINE_ONLY_TABLES.has(table)) continue;
  const model = Object.keys(NAME_MAP).find((m) => NAME_MAP[m] === table) ?? null;
  if (!model) {
    drift.push(`[console missing] table ${table} exists only in engine DDL`);
    continue;
  }
  if (STRUCTURAL_EXCEPTIONS.has(table)) continue;
  const modelCols = prismaModels.get(model);
  if (!modelCols) {
    drift.push(`[console missing] model ${model} for engine table ${table}`);
    continue;
  }
  for (const col of cols) {
    const camel = col.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    const aliases = Object.entries(COLUMN_ALIASES)
      .filter(([, al]) => al.includes(col))
      .map(([k]) => k);
    if (!modelCols.has(col) && !modelCols.has(camel) && !aliases.some((a) => modelCols.has(a)) && !ENGINE_ONLY_COLUMNS.has(`${table}.${col}`)) {
      drift.push(`[column missing in console] ${table}.${col}`);
    }
  }
}

console.log(`prisma models: ${prismaModels.size} · engine tables: ${ddlTables.size}`);
if (drift.length > 0) {
  console.error(`\nCONTRACT DRIFT (${drift.length}):`);
  for (const d of drift) console.error("  " + d);
  process.exit(1);
}
console.log("contract parity: OK — no drift between prisma schema and engine DDL");
