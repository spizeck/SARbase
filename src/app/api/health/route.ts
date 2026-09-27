import { NextResponse } from "next/server";

import { withApiObservability } from "@/lib/api";
import { checkDatabaseConnection } from "@/lib/db/health";

/**
 * Liveness endpoint for load-balancer/operator probes. Reports each
 * dependency's check result; any failed check degrades the whole
 * status and moves the HTTP code to 503.
 *
 * The response never includes configuration, secrets, connection
 * details, or error messages.
 */
async function handleGet() {
  const startedAt = Date.now();
  const database = await checkDatabaseConnection();

  const checks = {
    database: { ok: database.ok, latencyMs: database.latencyMs },
  };
  const healthy = Object.values(checks).every((c) => c.ok);

  return NextResponse.json(
    {
      status: healthy ? "healthy" : "degraded",
      checks,
      durationMs: Date.now() - startedAt,
    },
    { status: healthy ? 200 : 503 },
  );
}

export const GET = withApiObservability("health", handleGet);
