import { PrismaClient } from "@prisma/client";

/**
 * Process-wide PrismaClient. The globalThis cache prevents connection
 * exhaustion during dev-server hot reloads (each reload would otherwise
 * construct a fresh client and pool).
 *
 * Server-only: never import this from a Client Component or anything in
 * its module graph.
 */
const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
