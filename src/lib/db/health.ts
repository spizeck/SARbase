import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

/**
 * Liveness check for the database dependency — a bare `SELECT 1` that
 * proves connectivity and pool health without touching data. Used by
 * /api/health; the response exposes only ok/latency, never error text
 * or connection details.
 */
export async function checkDatabaseConnection(): Promise<{
  ok: boolean;
  latencyMs: number;
}> {
  const start = Date.now();
  try {
    await prisma.$queryRaw(Prisma.sql`SELECT 1`);
    return { ok: true, latencyMs: Date.now() - start };
  } catch {
    return { ok: false, latencyMs: Date.now() - start };
  }
}
