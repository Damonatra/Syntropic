/**
 * Round-trip fixture — seal a legacy document to the test engagement.
 * The upload UI writes the same shape via /api/audit/parse; the engine test
 * needs the row, not the UI. sha256 is a fixture value (the seal check the
 * deliverable prints truncates it — no verification of content here).
 */
import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";

const db = new PrismaClient();
const engagementId = process.argv[2] ?? "cmvu6lqt30001m31nmwqwhv7w";

async function main() {
  const content = "fixture quote sheet — 12 line items, SPA discounts 4%";
  const doc = await db.auditDocument.create({
    data: {
      engagementId,
      fileName: "q4-quote-ledger.pdf",
      mimeType: "application/pdf",
      sizeBytes: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content).digest("hex"),
      pages: 3,
      lineItems: 12,
      extraction: "full_text",
      findingsJson: JSON.stringify({ lines: 12, spaMentions: 4 }),
    },
  });
  console.log("sealed:", doc.id, doc.fileName);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
