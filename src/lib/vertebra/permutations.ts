/**
 * Deterministic executive email permutations — TypeScript parity with
 * `vertebra/enrichment/permutations.py`. Ranked by North American
 * distribution prevalence; every candidate is hygiene-checked.
 */

export const PATTERNS: Array<{ name: string; build: (n: NameParts) => string }> = [
  { name: "first.last", build: (n) => `${n.first}.${n.last}` },
  { name: "flast", build: (n) => `${n.f}${n.last}` },
  { name: "first_last", build: (n) => `${n.first}_${n.last}` },
  { name: "firstlast", build: (n) => `${n.first}${n.last}` },
  { name: "f.last", build: (n) => `${n.f}.${n.last}` },
  { name: "first", build: (n) => n.first },
  { name: "firstl", build: (n) => `${n.first}${n.l}` },
  { name: "last", build: (n) => n.last },
  { name: "lastfirst", build: (n) => `${n.last}${n.first}` },
  { name: "last.first", build: (n) => `${n.last}.${n.first}` },
  { name: "lfirst", build: (n) => `${n.l}${n.first}` },
];

export interface NameParts {
  first: string;
  last: string;
  f: string;
  l: string;
}

export function normaliseName(first: string, last: string): NameParts {
  const fold = (value: string) =>
    value
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[''`´]/g, "")
      .replace(/[^a-zA-Z0-9\s-]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  const firstClean = fold(first).split(" ")[0] ?? "";
  const lastClean = fold(last).replace(/\s/g, "");
  if (!firstClean || !lastClean) throw new Error("both first and last name are required");
  return { first: firstClean, last: lastClean, f: firstClean[0], l: lastClean[0] };
}

const LOCAL_RE = /^(?!^\.)[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}(?<!\.)$/;
const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function syntaxHygiene(localPart: string, domain: string): boolean {
  if (!localPart || localPart.length > 64) return false;
  if (localPart.startsWith(".") || localPart.endsWith(".") || localPart.includes("..")) return false;
  if (!LOCAL_RE.test(localPart)) return false;
  if (!DOMAIN_RE.test(domain)) return false;
  return localPart.length + domain.length + 1 <= 254;
}

export interface EmailCandidate {
  address: string;
  pattern: string;
  domain: string;
  syntaxValid: boolean;
}

export function generateCandidates(
  firstName: string,
  lastName: string,
  domainRaw: string,
  max = 6,
): EmailCandidate[] {
  const domain = domainRaw.trim().toLowerCase().replace(/^@/, "");
  const parts = normaliseName(firstName, lastName);
  const seen = new Set<string>();
  const out: EmailCandidate[] = [];
  for (const pattern of PATTERNS) {
    if (out.length >= max) break;
    const local = pattern.build(parts).replace(/^\.+|\.+$/g, "");
    if (!local || seen.has(local)) continue;
    seen.add(local);
    out.push({
      address: `${local}@${domain}`,
      pattern: pattern.name,
      domain,
      syntaxValid: syntaxHygiene(local, domain),
    });
  }
  return out;
}
