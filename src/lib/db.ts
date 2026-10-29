import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

function freshClient() {
  return new PrismaClient({
    log: ['query'],
  })
}

// In dev the global survives HMR — if it predates the current Prisma Client
// generation (schema pushed, client regenerated), rebuild it so newly pushed
// models are visible without a server restart.
export const db =
  globalForPrisma.prisma && 'commandBaseline' in globalForPrisma.prisma
    ? globalForPrisma.prisma
    : freshClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db