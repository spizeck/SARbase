import { timingSafeEqual } from "node:crypto";

import { ApiError, withApiObservability } from "@/lib/api";
import {
  parseGuardDutyEvent,
  recordGuardDutyScanEvent,
} from "@/lib/domain/malware-scan";
import {
  parseMalwareScanEnvironment,
  parseStorageEnvironment,
} from "@/lib/env";
import { logExpected } from "@/lib/logging";

/**
 * GuardDuty Malware Protection for S3 — scan-result ingest.
 *
 * Delivery path (docs/attachments.md): EventBridge rule matching
 * "GuardDuty Malware Protection Object Scan Result" → API destination
 * → this endpoint. The EventBridge connection holds the shared bearer
 * token; nothing else may call this route.
 *
 * Fail-closed posture:
 * - 503 until MALWARE_SCAN_WEBHOOK_TOKEN / MALWARE_SCAN_AWS_ACCOUNT_ID
 *   and the S3 storage env are all configured.
 * - 401 for a missing or mismatched bearer token (constant-time
 *   compare; the header is never logged).
 * - 400 for any event that fails shape or identity validation —
 *   source, detail-type, account, region, bucket, and key shape are all
 *   verified before a single row is written.
 * - The handler never marks anything clean itself; it records the
 *   event and lets the domain apply it to the matching attachment.
 */

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token || null;
}

/** Constant-time compare that tolerates differing lengths. */
function tokenEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

async function handlePost(request: Request) {
  const scanEnv = parseMalwareScanEnvironment();
  const storageEnv = parseStorageEnvironment();
  const expected = {
    bucket: storageEnv.FILE_STORAGE_S3_BUCKET,
    region: storageEnv.FILE_STORAGE_S3_REGION,
    account: scanEnv.MALWARE_SCAN_AWS_ACCOUNT_ID,
  };
  if (
    !scanEnv.MALWARE_SCAN_WEBHOOK_TOKEN ||
    !expected.bucket ||
    !expected.region ||
    !expected.account
  ) {
    // Not configured — fail closed, loudly.
    throw new ApiError(
      "SCAN_INGEST_NOT_CONFIGURED",
      503,
      "Malware scan result ingest is not configured on this deployment.",
    );
  }

  const token = bearerToken(request);
  if (!token || !tokenEquals(token, scanEnv.MALWARE_SCAN_WEBHOOK_TOKEN)) {
    throw new ApiError("UNAUTHENTICATED", 401, "Authentication required.");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ApiError("BAD_REQUEST", 400, "Request body must be JSON.");
  }

  const parsed = parseGuardDutyEvent(body, {
    bucket: expected.bucket,
    account: expected.account,
    region: expected.region,
  });
  if (!parsed.ok) {
    // Rejections are logged (the event id if present, never the body —
    // a malformed payload may carry attacker-controlled content).
    logExpected({
      event: "attachment.scan_event_rejected",
      subsystem: "attachments",
      outcome: "expected_failure",
      detail: {
        reason: parsed.reason,
        awsEventId:
          body && typeof body === "object"
            ? ((body as Record<string, unknown>).id ?? null)
            : null,
      },
    });
    throw new ApiError("BAD_REQUEST", 400, "Event rejected.");
  }

  const outcome = await recordGuardDutyScanEvent(parsed.input);
  return Response.json({ outcome }, { status: 200 });
}

// No path params — the context arg exists only to satisfy the router's
// handler contract.
export const POST = withApiObservability<
  Request,
  { params: Promise<Record<string, never>> }
>("attachments.guardduty_scan_result", (request) => handlePost(request));
