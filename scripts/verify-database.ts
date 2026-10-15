// `npm run db:verify` — read-only baseline verification for a
// fictional-data database (`testing`, a preview/pr-N branch, or local
// dev).
//
// Answers the question the adoption audit raised: "is this database
// demonstrably a safe, fictional-only baseline?" — without changing a
// single row.
//
//   1. Identity: prints normalized host:port/database (never
//      credentials) and fails when it resolves to the production host
//      (APP_PRODUCTION_DB_HOST).
//   2. Schema: runs `prisma migrate status` — pending or failed
//      migrations are reported, not applied.
//   3. Shape: asserts fictional-only invariants — every Member and
//      AuthIdentity is a seed fixture (seed-* ids, reserved-TLD
//      emails); operational history tables flag rows the seed did not
//      create.
//
// Exits 0 only when every check passes. Read-only under all outcomes.

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { normalizeDatabaseEndpoint } from "../src/lib/env";
import {
  describeDatabaseTarget,
  parseDatabaseTargetUrl,
  LOOPBACK_HOSTS,
} from "./lib/db-target";

export interface BaselineSnapshot {
  members: { id: string; email: string | null }[];
  authIdentities: {
    id: string;
    provider: string;
    providerUid: string;
    email: string | null;
  }[];
  /** Per-model count of rows whose id is not a `seed-*` fixture id. */
  nonSeedCounts: Record<string, number>;
}

export interface Finding {
  severity: "fail" | "warn";
  message: string;
}

const SEED_ID_PREFIX = "seed-";

// RFC 2606 reserved TLDs + the example.* second-level domains — an
// email is only provably fictional when it cannot route anywhere.
const FICTIONAL_TLDS = [".test", ".invalid", ".example", ".localhost"];
const FICTIONAL_DOMAINS = new Set([
  "example.com",
  "example.org",
  "example.net",
  "localhost",
]);

/** DNS names are case-insensitive — compare in lowercase or
 *  `Seed@Example.TEST` false-fails. */
export function isFictionalEmail(email: string): boolean {
  const at = email.lastIndexOf("@");
  if (at <= 0) {
    return false;
  }
  const domain = email.slice(at + 1).toLowerCase();
  if (!domain) {
    return false;
  }
  return (
    FICTIONAL_TLDS.some((tld) => domain.endsWith(tld)) ||
    FICTIONAL_DOMAINS.has(domain)
  );
}

export function assessBaseline(snapshot: BaselineSnapshot): Finding[] {
  const findings: Finding[] = [];
  const fail = (message: string) =>
    findings.push({ severity: "fail", message });
  const warn = (message: string) =>
    findings.push({ severity: "warn", message });

  if (snapshot.members.length === 0) {
    warn(
      "no Member rows — the fictional baseline fixtures have not been seeded",
    );
  }
  for (const member of snapshot.members) {
    if (!member.id.startsWith(SEED_ID_PREFIX)) {
      fail(
        `Member ${member.id} is not a seed fixture — this database holds member records that are not provably fictional`,
      );
    }
    if (member.email && !isFictionalEmail(member.email)) {
      fail(
        `Member ${member.id} has a non-fictional email domain — only reserved (RFC 2606) addresses may exist on a seed baseline`,
      );
    }
  }

  for (const identity of snapshot.authIdentities) {
    // Every sign-in identity on a baseline must come from the seed —
    // the fixture uses provider "seed" deliberately so a real
    // firebase-provider identity is unmistakable.
    if (
      identity.provider !== "seed" ||
      !identity.providerUid.startsWith(SEED_ID_PREFIX) ||
      !identity.id.startsWith(SEED_ID_PREFIX)
    ) {
      fail(
        `AuthIdentity ${identity.id} (provider ${identity.provider}) is not a seed fixture — this database holds sign-in identities that are not provably fictional`,
      );
    }
    if (identity.email && !isFictionalEmail(identity.email)) {
      fail(
        `AuthIdentity ${identity.id} has a non-fictional email domain — only reserved (RFC 2606) addresses may exist on a seed baseline`,
      );
    }
  }

  // Operational history: the seed marks its own rows with seed-* ids,
  // so any other row is data the fixtures did not declare. These are
  // warnings rather than failures — a preview that a tester exercised
  // legitimately accumulates non-seed rows; the warning is what makes
  // a human confirm they are fictional rather than real operational
  // history (incidents, callouts, expenses, notifications, …).
  for (const [model, count] of Object.entries(snapshot.nonSeedCounts)) {
    if (count > 0) {
      warn(
        `${model}: ${count} row(s) not created by the seed fixture — confirm they are fictional test data, not real records`,
      );
    }
  }

  return findings;
}

export function isProductionHost(
  host: string,
  productionHost: string | undefined,
): boolean {
  if (!productionHost) return false;
  return (
    normalizeDatabaseEndpoint(host) ===
    normalizeDatabaseEndpoint(productionHost.trim())
  );
}

function runMigrateStatus(url: string): { ok: boolean; output: string } {
  // The schema's datasource declares url + directUrl, and Prisma
  // requires both — supply the URL under verification for each so a
  // caller that set only one still checks the selected database
  // instead of failing schema validation.
  const command =
    process.platform === "win32"
      ? "npx.cmd prisma migrate status"
      : "npx prisma migrate status";
  const result = spawnSync(command, {
    shell: true,
    encoding: "utf-8",
    env: {
      ...process.env,
      DATABASE_URL: url,
      DATABASE_URL_UNPOOLED: url,
    },
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return { ok: result.status === 0, output };
}

/**
 * Every model with a scalar `id` primary key that is not checked
 * individually for fictional identity. The IncidentSequence /
 * ExpenseSequence counters are excluded (no `id` column — they are
 * per-organization number allocators, not records).
 */
const OPERATIONAL_MODELS = [
  "organization",
  "unit",
  "memberUnit",
  "organizationAccess",
  "storageLocation",
  "asset",
  "inventoryItem",
  "vendor",
  "inspectionDefinition",
  "inspectionRecord",
  "inspectionRecordChange",
  "assetMeter",
  "assetMeterReading",
  "maintenancePlan",
  "maintenanceRecord",
  "maintenanceRecordChange",
  "defect",
  "defectChange",
  "trainingTopic",
  "trainingEvent",
  "trainingAttendance",
  "trainingAttendanceChange",
  "memberAvailabilityUpdate",
  "memberNotificationPreference",
  "qualificationDefinition",
  "memberQualification",
  "notification",
  "notificationAttempt",
  "callout",
  "calloutInvitation",
  "calloutResponseChange",
  "incident",
  "incidentMember",
  "incidentAsset",
  "incidentTimelineEvent",
  "incidentNote",
  "incidentNoteCorrection",
  "incidentChange",
  "attachment",
  "attachmentEvent",
  "organizationDocument",
  "organizationDocumentVersion",
  "incidentAttachment",
  "incidentNoteAttachment",
  "memberQualificationAttachment",
  "trainingEventAttachment",
  "assetAttachment",
  "inspectionRecordAttachment",
  "maintenanceRecordAttachment",
  "defectAttachment",
  "expense",
  "expenseIncident",
  "expenseTrainingEvent",
  "expenseAsset",
  "expenseMaintenanceRecord",
  "expenseInventoryItem",
  "expenseAttachment",
  "expenseEvent",
  "expenseChange",
] as const;

interface CountingDelegate {
  count(args: {
    where: { NOT: { id: { startsWith: string } } };
  }): import("@prisma/client").Prisma.PrismaPromise<number>;
}

async function main(): Promise<void> {
  const url =
    process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "";
  if (!url) {
    throw new Error("DATABASE_URL_UNPOOLED or DATABASE_URL must be set");
  }
  // Identity comes from the strict target parser — it refuses
  // target-override query parameters (host/hostaddr/port/database/
  // dbname/service) that could redirect the driver past the authority
  // hostname this check verifies.
  const parsed = parseDatabaseTargetUrl(url);
  const host = normalizeDatabaseEndpoint(parsed.hostname);

  console.log(`Database identity: ${describeDatabaseTarget(url)}`);

  const findings: Finding[] = [];
  const fail = (message: string) =>
    findings.push({ severity: "fail", message });

  const productionHost = process.env.APP_PRODUCTION_DB_HOST;
  if (!productionHost) {
    // Fail closed on any hosted target: without the reference host we
    // cannot prove this is not production. Loopback targets are local
    // by definition, so the check is skipped for them.
    if (!LOOPBACK_HOSTS.has(host)) {
      fail(
        "APP_PRODUCTION_DB_HOST is not set — cannot prove this remote database is not production; refusing to verify",
      );
    }
  } else if (isProductionHost(parsed.hostname, productionHost)) {
    fail(
      "database URL resolves to the PRODUCTION host — this is not a seed baseline",
    );
  }

  const report = () => {
    for (const finding of findings) {
      console.log(
        `${finding.severity === "fail" ? "FAIL" : "WARN"}  ${finding.message}`,
      );
    }
  };

  // Identity problems are gating: print them now and stop before any
  // database connection — an unverifiable or production-looking target
  // must never see a query, and its finding must never be buried under
  // a connection error.
  if (findings.some((f) => f.severity === "fail")) {
    report();
    console.log("db:verify FAILED");
    process.exit(1);
  }

  const migrate = runMigrateStatus(url);
  if (migrate.ok) {
    console.log("prisma migrate status: up to date");
  } else {
    // Not gating by itself — the baseline reads below still produce
    // useful diagnostics against a pending/failed-migration database.
    fail("prisma migrate status reported pending or failed migrations");
    if (migrate.output) console.log(migrate.output);
  }

  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    // One transaction at RepeatableRead = one consistent snapshot for
    // every read. Read Committed (the default) would give each
    // statement a fresh snapshot, and the reads could combine results
    // that never coexisted.
    const delegates = prisma as unknown as Record<string, CountingDelegate>;
    const [members, authIdentities, ...counts] = await prisma.$transaction(
      [
        prisma.member.findMany({ select: { id: true, email: true } }),
        prisma.authIdentity.findMany({
          select: { id: true, provider: true, providerUid: true, email: true },
        }),
        ...OPERATIONAL_MODELS.map((model) =>
          delegates[model]!.count({
            where: { NOT: { id: { startsWith: SEED_ID_PREFIX } } },
          }),
        ),
      ],
      { isolationLevel: "RepeatableRead" },
    );

    const nonSeedCounts: Record<string, number> = {};
    OPERATIONAL_MODELS.forEach((model, index) => {
      nonSeedCounts[model] = counts[index] ?? 0;
    });

    findings.push(
      ...assessBaseline({ members, authIdentities, nonSeedCounts }),
    );
  } finally {
    await prisma.$disconnect();
  }

  report();
  if (findings.some((f) => f.severity === "fail")) {
    console.log("db:verify FAILED");
    process.exit(1);
  }
  console.log("db:verify OK");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
