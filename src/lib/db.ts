import fs from 'node:fs'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

function freshClient() {
  return new PrismaClient({
    log: ['query'],
  })
}

// Freshness probe: the generated client ships the schema it was built from.
// If the cached global predates the current generation (schema pushed + client
// regenerated while the server was running), at least one model delegate the
// generated schema declares will be missing from the cached instance — rebuild
// instead of serving "P is not a valid property" 500s until a manual restart.
function generatedModelNames(): string[] | null {
  try {
    const schemaPath = path.join(process.cwd(), 'node_modules', '.prisma', 'client', 'schema.prisma')
    const src = fs.readFileSync(schemaPath, 'utf8')
    const names = [...src.matchAll(/^model\s+(\w+)/gm)].map((m) => m[1])
    return names.length > 0 ? names : null
  } catch {
    return null
  }
}

// In dev the global survives HMR; keep it only when it matches the current
// Prisma Client generation (all generated models present), so a schema push
// plus regenerate never requires a server restart. Editing THIS module also
// forces re-evaluation, which is what lets the probe swap a stale global for
// a fresh client after a schema push.
export const db = (() => {
  const cached = globalForPrisma.prisma
  if (!cached) return freshClient()
  const models = generatedModelNames()
  if (models && models.some((m) => !(m in cached))) return freshClient()
  return cached
})()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db