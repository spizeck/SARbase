/**
 * Exportable dataset registry (issue #19).
 *
 * Every dataset is a self-contained definition: a stable URL key, the
 * filters it supports, the column layout, and one org-scoped query.
 * Adding a record type later = one entry here — routes, authz, audit,
 * and CSV serialization need no change.
 *
 * Rules every dataset honors:
 * - orgId scoping is inside the WHERE clause; there is no cross-org path.
 * - Rows are ordered by a stable key so repeated exports are
 *   deterministic.
 * - Stable ids are exported alongside any human-readable name, so
 *   exported files can be re-joined relationally (docs/reporting.md).
 * - Actor columns are scalar ids (the #38 policy) — they remain useful
 *   forensic references even after the identity is removed.
 */

import { Prisma } from "@prisma/client";

import { formatDateOnly, instantInZone } from "@/lib/dates";
import { amountMinorToDecimal } from "@/lib/money";

import type { CsvTable } from "./csv";
import type { ExportFilters, FilterKey } from "./filters";
import { ORG_WIDE_UNIT } from "./filters";

type Tx = Prisma.TransactionClient;

export interface DatasetDef {
  /** Stable URL key — also the DataExportEvent.exportType and filename slug. */
  key: string;
  group: string;
  label: string;
  description: string;
  /** Filters this dataset supports — anything else is a 400. */
  filters: ReadonlySet<FilterKey>;
  /** Which column the from/to range applies to, and its storage kind. */
  dateField?: { name: string; kind: "date" | "instant" };
  run(
    tx: Tx,
    organizationId: string,
    timezone: string,
    filters: ExportFilters,
  ): Promise<CsvTable>;
}

const c = {
  id: (key: string) => ({ key, kind: "id" }) as const,
  en: (key: string) => ({ key, kind: "enum" }) as const,
  t: (key: string) => ({ key, kind: "text" }) as const,
  n: (key: string) => ({ key, kind: "number" }) as const,
  dec: (key: string) => ({ key, kind: "decimal" }) as const,
  b: (key: string) => ({ key, kind: "boolean" }) as const,
  d: (key: string) => ({ key, kind: "date" }) as const,
  ts: (key: string) => ({ key, kind: "instant" }) as const,
};

const NONE = new Set<FilterKey>([]);
const DATE_ONLY = new Set<FilterKey>(["date"]);

/* ----------------------------- filter helpers ---------------------------- */

/** Range clause for a `@db.Date` column — local dates, inclusive `to`. */
function dateRange(field: string, f: ExportFilters) {
  const range: { gte?: Date; lte?: Date } = {};
  if (f.from) range.gte = f.from;
  if (f.to) range.lte = f.to;
  return Object.keys(range).length ? { [field]: range } : {};
}

/**
 * Range clause for an instant column. `from`/`to` are local calendar
 * dates; bounds translate through the organization's timezone — from
 * local-midnight inclusive to the day after `to` local-midnight
 * exclusive — never naive UTC midnights.
 */
function instantRange(field: string, f: ExportFilters, timezone: string) {
  const range: { gte?: Date; lt?: Date } = {};
  if (f.from) {
    const start = instantInZone(timezone, `${formatDateOnly(f.from)}T00:00`);
    if (start) range.gte = start;
  }
  if (f.to) {
    const dayAfter = new Date(f.to.getTime() + 86_400_000);
    const end = instantInZone(timezone, `${formatDateOnly(dayAfter)}T00:00`);
    if (end) range.lt = end;
  }
  return Object.keys(range).length ? { [field]: range } : {};
}

/** `unitId` column clause; the "org" sentinel selects NULL rows. */
function unitWhere(f: ExportFilters) {
  if (!f.unit) return {};
  return f.unit === ORG_WIDE_UNIT ? { unitId: null } : { unitId: f.unit };
}

/** Membership-based unit clause for rows related to a Member. */
function memberUnitWhere(f: ExportFilters) {
  if (!f.unit) return {};
  return f.unit === ORG_WIDE_UNIT
    ? { memberUnits: { none: {} } }
    : { memberUnits: { some: { unitId: f.unit } } };
}

/* ------------------------------ datasets --------------------------------- */

const organizationDataset: DatasetDef = {
  key: "organization",
  group: "Organization & people",
  label: "Organization",
  description: "The organization record itself — id, name, timezone.",
  filters: NONE,
  run: async (tx, organizationId) => ({
    columns: [c.id("id"), c.t("name"), c.t("timezone"), c.ts("createdAt")],
    rows: await tx.organization.findMany({
      where: { id: organizationId },
      select: { id: true, name: true, timezone: true, createdAt: true },
    }),
  }),
};

const unitsDataset: DatasetDef = {
  key: "units",
  group: "Organization & people",
  label: "Units",
  description: "Internal groupings (stations, teams).",
  filters: NONE,
  run: async (tx, organizationId) => ({
    columns: [
      c.id("id"),
      c.id("organizationId"),
      c.t("name"),
      c.ts("createdAt"),
    ],
    rows: await tx.unit.findMany({
      where: { organizationId },
      orderBy: { name: "asc" },
      select: {
        id: true,
        organizationId: true,
        name: true,
        createdAt: true,
      },
    }),
  }),
};

const membersDataset: DatasetDef = {
  key: "members",
  group: "Organization & people",
  label: "Members",
  description:
    "Member roster including contact details as recorded. Sensitive — admin only.",
  filters: new Set<FilterKey>(["unit"]),
  run: async (tx, organizationId, _tz, f) => ({
    columns: [
      c.id("id"),
      c.id("organizationId"),
      c.t("displayName"),
      c.t("email"),
      c.t("phone"),
      c.en("status"),
      c.id("authIdentityId"),
      c.ts("createdAt"),
      c.ts("updatedAt"),
    ],
    rows: await tx.member.findMany({
      where: { organizationId, ...memberUnitWhere(f) },
      orderBy: [{ displayName: "asc" }, { id: "asc" }],
      select: {
        id: true,
        organizationId: true,
        displayName: true,
        email: true,
        phone: true,
        status: true,
        authIdentityId: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
  }),
};

const memberUnitsDataset: DatasetDef = {
  key: "member-units",
  group: "Organization & people",
  label: "Member-unit memberships",
  description: "Which members belong to which units.",
  filters: NONE,
  run: async (tx, organizationId) => ({
    columns: [
      c.id("id"),
      c.id("organizationId"),
      c.id("memberId"),
      c.id("unitId"),
      c.ts("createdAt"),
    ],
    rows: await tx.memberUnit.findMany({
      where: { organizationId },
      orderBy: [{ memberId: "asc" }, { unitId: "asc" }],
    }),
  }),
};

const memberAvailabilityDataset: DatasetDef = {
  key: "member-availability",
  group: "Organization & people",
  label: "Availability history",
  description:
    "Append-only availability statements (raw history — no derived scores).",
  filters: DATE_ONLY,
  dateField: { name: "createdAt", kind: "instant" },
  run: async (tx, organizationId, tz, f) => ({
    columns: [
      c.id("id"),
      c.id("organizationId"),
      c.id("memberId"),
      c.en("status"),
      c.d("until"),
      c.t("note"),
      c.b("selfReported"),
      c.id("actorAuthIdentityId"),
      c.ts("createdAt"),
    ],
    rows: await tx.memberAvailabilityUpdate.findMany({
      where: {
        organizationId,
        ...instantRange("createdAt", f, tz),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
  }),
};

const memberNotificationPreferencesDataset: DatasetDef = {
  key: "member-notification-preferences",
  group: "Organization & people",
  label: "Notification preferences",
  description:
    "Per-member channel opt-ins (willingness flags only — no destinations).",
  filters: NONE,
  run: async (tx, organizationId) => ({
    columns: [
      c.id("id"),
      c.id("organizationId"),
      c.id("memberId"),
      c.b("notifyEmail"),
      c.b("notifySms"),
      c.b("notifyWhatsapp"),
      c.b("notifyPush"),
      c.ts("updatedAt"),
    ],
    rows: await tx.memberNotificationPreference.findMany({
      where: { organizationId },
      orderBy: { memberId: "asc" },
    }),
  }),
};

const qualificationDefinitionsDataset: DatasetDef = {
  key: "qualification-definitions",
  group: "Qualifications & training",
  label: "Qualification definitions",
  description: "The qualification/certification types tracked.",
  filters: NONE,
  run: async (tx, organizationId) => ({
    columns: [
      c.id("id"),
      c.id("organizationId"),
      c.t("name"),
      c.t("description"),
      c.en("status"),
      c.ts("createdAt"),
    ],
    rows: await tx.qualificationDefinition.findMany({
      where: { organizationId },
      orderBy: { name: "asc" },
    }),
  }),
};

const memberQualificationsDataset: DatasetDef = {
  key: "member-qualifications",
  group: "Qualifications & training",
  label: "Member qualifications",
  description: "Append-only certificate records per member.",
  filters: NONE,
  run: async (tx, organizationId) => ({
    columns: [
      c.id("id"),
      c.id("organizationId"),
      c.id("memberId"),
      c.id("definitionId"),
      c.d("issuedOn"),
      c.d("expiresOn"),
      c.t("issuer"),
      c.t("reference"),
      c.t("notes"),
      c.ts("createdAt"),
    ],
    rows: await tx.memberQualification.findMany({
      where: { organizationId },
      orderBy: [{ memberId: "asc" }, { id: "asc" }],
    }),
  }),
};

const trainingEventsDataset: DatasetDef = {
  key: "training-events",
  group: "Qualifications & training",
  label: "Training events",
  description:
    "Training records. `from`/`to` filter the org-local event date; `unit` filters the recorded unit.",
  filters: new Set<FilterKey>(["date", "unit"]),
  dateField: { name: "date", kind: "date" },
  run: async (tx, organizationId, _tz, f) => ({
    columns: [
      c.id("id"),
      c.id("organizationId"),
      c.id("unitId"),
      c.t("title"),
      c.d("date"),
      c.n("durationMinutes"),
      c.t("location"),
      c.t("instructorName"),
      c.id("leadMemberId"),
      c.t("notes"),
      c.t("followUp"),
      c.en("status"),
      c.ts("createdAt"),
    ],
    rows: await tx.trainingEvent.findMany({
      where: {
        organizationId,
        ...dateRange("date", f),
        ...unitWhere(f),
      },
      orderBy: [{ date: "asc" }, { id: "asc" }],
    }),
  }),
};

const trainingTopicsDataset: DatasetDef = {
  key: "training-topics",
  group: "Qualifications & training",
  label: "Training topics",
  description: "Topic labels per training event.",
  filters: NONE,
  run: async (tx, organizationId) => ({
    columns: [
      c.id("id"),
      c.id("organizationId"),
      c.id("trainingEventId"),
      c.t("label"),
    ],
    rows: await tx.trainingTopic.findMany({
      where: { organizationId },
      orderBy: [{ trainingEventId: "asc" }, { label: "asc" }],
    }),
  }),
};

const trainingAttendanceDataset: DatasetDef = {
  key: "training-attendance",
  group: "Qualifications & training",
  label: "Training attendance",
  description: "Member attendance rows per training event.",
  filters: NONE,
  run: async (tx, organizationId) => ({
    columns: [
      c.id("id"),
      c.id("organizationId"),
      c.id("trainingEventId"),
      c.id("memberId"),
      c.t("notes"),
      c.ts("createdAt"),
    ],
    rows: await tx.trainingAttendance.findMany({
      where: { organizationId },
      orderBy: [{ trainingEventId: "asc" }, { memberId: "asc" }],
    }),
  }),
};

const storageLocationsDataset: DatasetDef = {
  key: "storage-locations",
  group: "Assets & maintenance",
  label: "Storage locations",
  description: "Named places where assets and stock are kept.",
  filters: NONE,
  run: async (tx, organizationId) => ({
    columns: [
      c.id("id"),
      c.id("organizationId"),
      c.id("parentLocationId"),
      c.id("containingAssetId"),
      c.t("name"),
      c.t("description"),
      c.en("status"),
      c.ts("createdAt"),
    ],
    rows: await tx.storageLocation.findMany({
      where: { organizationId },
      orderBy: { name: "asc" },
    }),
  }),
};

const assetsDataset: DatasetDef = {
  key: "assets",
  group: "Assets & maintenance",
  label: "Assets",
  description: "Durable equipment records. `unit` filters recorded unit.",
  filters: new Set<FilterKey>(["unit"]),
  run: async (tx, organizationId, _tz, f) => ({
    columns: [
      c.id("id"),
      c.id("organizationId"),
      c.id("unitId"),
      c.id("parentAssetId"),
      c.id("storageLocationId"),
      c.t("name"),
      c.t("category"),
      c.t("manufacturer"),
      c.t("model"),
      c.t("serialNumber"),
      c.t("assetTag"),
      c.d("purchaseDate"),
      c.t("vendor"),
      c.en("status"),
      c.en("condition"),
      c.t("notes"),
      c.ts("createdAt"),
    ],
    rows: await tx.asset.findMany({
      where: { organizationId, ...unitWhere(f) },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    }),
  }),
};

const inventoryItemsDataset: DatasetDef = {
  key: "inventory-items",
  group: "Assets & maintenance",
  label: "Inventory items",
  description: "Consumable stock records. `unit` filters recorded unit.",
  filters: new Set<FilterKey>(["unit"]),
  run: async (tx, organizationId, _tz, f) => ({
    columns: [
      c.id("id"),
      c.id("organizationId"),
      c.id("unitId"),
      c.id("storageLocationId"),
      c.t("name"),
      c.t("category"),
      c.dec("quantity"),
      c.t("unitOfMeasure"),
      c.t("vendor"),
      c.en("condition"),
      c.en("status"),
      c.t("notes"),
      c.ts("createdAt"),
    ],
    rows: await tx.inventoryItem.findMany({
      where: { organizationId, ...unitWhere(f) },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    }),
  }),
};

const inspectionDefinitionsDataset: DatasetDef = {
  key: "inspection-definitions",
  group: "Assets & maintenance",
  label: "Inspection definitions",
  description: "Inspection types and their recurrence.",
  filters: NONE,
  run: async (tx, organizationId) => ({
    columns: [
      c.id("id"),
      c.id("organizationId"),
      c.t("name"),
      c.t("description"),
      c.en("recurrenceType"),
      c.n("intervalValue"),
      c.en("status"),
      c.ts("createdAt"),
    ],
    rows: await tx.inspectionDefinition.findMany({
      where: { organizationId },
      orderBy: { name: "asc" },
    }),
  }),
};

const inspectionRecordsDataset: DatasetDef = {
  key: "inspection-records",
  group: "Assets & maintenance",
  label: "Inspection records",
  description:
    "Recorded inspections. `from`/`to` filter the performed-on date.",
  filters: DATE_ONLY,
  dateField: { name: "performedOn", kind: "date" },
  run: async (tx, organizationId, _tz, f) => ({
    columns: [
      c.id("id"),
      c.id("organizationId"),
      c.id("assetId"),
      c.id("definitionId"),
      c.d("performedOn"),
      c.id("inspectorMemberId"),
      c.t("inspectorName"),
      c.en("conditionObserved"),
      c.d("nextDueOn"),
      c.id("meterId"),
      c.dec("meterReading"),
      c.t("notes"),
      c.ts("createdAt"),
    ],
    rows: await tx.inspectionRecord.findMany({
      where: { organizationId, ...dateRange("performedOn", f) },
      orderBy: [{ performedOn: "asc" }, { id: "asc" }],
    }),
  }),
};

const maintenancePlansDataset: DatasetDef = {
  key: "maintenance-plans",
  group: "Assets & maintenance",
  label: "Maintenance plans",
  description: "Scheduled maintenance definitions per asset.",
  filters: NONE,
  run: async (tx, organizationId) => ({
    columns: [
      c.id("id"),
      c.id("organizationId"),
      c.id("assetId"),
      c.t("name"),
      c.t("description"),
      c.en("intervalType"),
      c.n("intervalValue"),
      c.id("meterId"),
      c.dec("meterInterval"),
      c.en("status"),
      c.ts("createdAt"),
    ],
    rows: await tx.maintenancePlan.findMany({
      where: { organizationId },
      orderBy: [{ assetId: "asc" }, { name: "asc" }],
    }),
  }),
};

const maintenanceRecordsDataset: DatasetDef = {
  key: "maintenance-records",
  group: "Assets & maintenance",
  label: "Maintenance records",
  description:
    "Service/repair events. `from`/`to` filter the performed-on date.",
  filters: DATE_ONLY,
  dateField: { name: "performedOn", kind: "date" },
  run: async (tx, organizationId, _tz, f) => ({
    columns: [
      c.id("id"),
      c.id("organizationId"),
      c.id("assetId"),
      c.id("planId"),
      c.d("performedOn"),
      c.t("title"),
      c.t("workPerformed"),
      c.t("providerName"),
      c.id("performedByMemberId"),
      c.id("meterId"),
      c.dec("meterReading"),
      c.d("nextDueOn"),
      c.t("notes"),
      c.ts("createdAt"),
    ],
    rows: await tx.maintenanceRecord.findMany({
      where: { organizationId, ...dateRange("performedOn", f) },
      orderBy: [{ performedOn: "asc" }, { id: "asc" }],
    }),
  }),
};

const assetMetersDataset: DatasetDef = {
  key: "asset-meters",
  group: "Assets & maintenance",
  label: "Asset meters",
  description: "Meter definitions (engine hours, odometer, ...).",
  filters: NONE,
  run: async (tx, organizationId) => ({
    columns: [
      c.id("id"),
      c.id("organizationId"),
      c.id("assetId"),
      c.t("name"),
      c.t("unit"),
      c.en("status"),
      c.ts("createdAt"),
    ],
    rows: await tx.assetMeter.findMany({
      where: { organizationId },
      orderBy: [{ assetId: "asc" }, { name: "asc" }],
    }),
  }),
};

const assetMeterReadingsDataset: DatasetDef = {
  key: "asset-meter-readings",
  group: "Assets & maintenance",
  label: "Meter readings",
  description:
    "Append-only meter observations. `from`/`to` filter the recorded-on date.",
  filters: DATE_ONLY,
  dateField: { name: "recordedOn", kind: "date" },
  run: async (tx, organizationId, _tz, f) => ({
    columns: [
      c.id("id"),
      c.id("organizationId"),
      c.id("meterId"),
      c.dec("reading"),
      c.d("recordedOn"),
      c.id("recordedByMemberId"),
      c.id("maintenanceRecordId"),
      c.id("inspectionRecordId"),
      c.t("notes"),
      c.ts("createdAt"),
    ],
    rows: await tx.assetMeterReading.findMany({
      where: { organizationId, ...dateRange("recordedOn", f) },
      orderBy: [{ recordedOn: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    }),
  }),
};

const defectsDataset: DatasetDef = {
  key: "defects",
  group: "Assets & maintenance",
  label: "Defects",
  description: "Reported defects. `from`/`to` filter the reported-on date.",
  filters: DATE_ONLY,
  dateField: { name: "reportedOn", kind: "date" },
  run: async (tx, organizationId, _tz, f) => ({
    columns: [
      c.id("id"),
      c.id("organizationId"),
      c.id("assetId"),
      c.d("reportedOn"),
      c.id("reportedByMemberId"),
      c.t("reporterName"),
      c.t("title"),
      c.t("description"),
      c.en("status"),
      c.d("resolvedOn"),
      c.t("resolutionNotes"),
      c.ts("createdAt"),
    ],
    rows: await tx.defect.findMany({
      where: { organizationId, ...dateRange("reportedOn", f) },
      orderBy: [{ reportedOn: "asc" }, { id: "asc" }],
    }),
  }),
};

const calloutsDataset: DatasetDef = {
  key: "callouts",
  group: "Incidents & callouts",
  label: "Callouts",
  description:
    "Callout records. `from`/`to` filter activation time (org-local dates); `unit` filters the targeted unit.",
  filters: new Set<FilterKey>(["date", "unit"]),
  dateField: { name: "activatedAt", kind: "instant" },
  run: async (tx, organizationId, tz, f) => ({
    columns: [
      c.id("id"),
      c.id("organizationId"),
      c.id("unitId"),
      c.en("audience"),
      c.t("title"),
      c.t("message"),
      c.en("status"),
      c.ts("activatedAt"),
      c.ts("closedAt"),
      c.id("createdByAuthIdentityId"),
      c.id("closedByAuthIdentityId"),
      c.ts("createdAt"),
    ],
    rows: await tx.callout.findMany({
      where: {
        organizationId,
        ...instantRange("activatedAt", f, tz),
        ...unitWhere(f),
      },
      orderBy: [{ activatedAt: "asc" }, { id: "asc" }],
    }),
  }),
};

const calloutInvitationsDataset: DatasetDef = {
  key: "callout-invitations",
  group: "Incidents & callouts",
  label: "Callout invitations",
  description:
    "Materialized invitations with raw response state and timestamps. Response token hashes are never exported.",
  filters: DATE_ONLY,
  dateField: { name: "invitedAt", kind: "instant" },
  run: async (tx, organizationId, tz, f) => ({
    columns: [
      c.id("id"),
      c.id("organizationId"),
      c.id("calloutId"),
      c.id("memberId"),
      c.id("notificationId"),
      c.ts("invitedAt"),
      c.en("response"),
      c.ts("respondedAt"),
      c.ts("createdAt"),
    ],
    rows: await tx.calloutInvitation.findMany({
      where: {
        organizationId,
        ...instantRange("invitedAt", f, tz),
      },
      orderBy: [{ invitedAt: "asc" }, { id: "asc" }],
    }),
  }),
};

const incidentsDataset: DatasetDef = {
  key: "incidents",
  group: "Incidents & callouts",
  label: "Incidents",
  description:
    "Incident records with factual timestamps. `from`/`to` filter record creation (org-local dates).",
  filters: DATE_ONLY,
  dateField: { name: "createdAt", kind: "instant" },
  run: async (tx, organizationId, tz, f) => ({
    columns: [
      c.id("id"),
      c.id("organizationId"),
      c.id("calloutId"),
      c.n("sequence"),
      c.id("reference"),
      c.t("title"),
      c.t("summary"),
      c.en("status"),
      c.ts("reportedAt"),
      c.ts("departedAt"),
      c.ts("onSceneAt"),
      c.ts("returnedAt"),
      c.ts("openedAt"),
      c.ts("closedAt"),
      c.id("createdByAuthIdentityId"),
      c.id("closedByAuthIdentityId"),
      c.ts("createdAt"),
    ],
    rows: await tx.incident.findMany({
      where: {
        organizationId,
        ...instantRange("createdAt", f, tz),
      },
      orderBy: { sequence: "asc" },
    }),
  }),
};

const incidentParticipantsDataset: DatasetDef = {
  key: "incident-participants",
  group: "Incidents & callouts",
  label: "Incident participants",
  description:
    "Recorded member participation per incident. `from`/`to` filter the recorded-at instant.",
  filters: DATE_ONLY,
  dateField: { name: "recordedAt", kind: "instant" },
  run: async (tx, organizationId, tz, f) => ({
    columns: [
      c.id("id"),
      c.id("organizationId"),
      c.id("incidentId"),
      c.id("memberId"),
      c.t("roleNote"),
      c.id("recordedByAuthIdentityId"),
      c.ts("recordedAt"),
    ],
    rows: await tx.incidentMember.findMany({
      where: {
        organizationId,
        ...instantRange("recordedAt", f, tz),
      },
      orderBy: [{ incidentId: "asc" }, { memberId: "asc" }],
    }),
  }),
};

const incidentAssetsDataset: DatasetDef = {
  key: "incident-assets",
  group: "Incidents & callouts",
  label: "Incident assets",
  description:
    "Assets recorded as used on incidents. `from`/`to` filter the recorded-at instant.",
  filters: DATE_ONLY,
  dateField: { name: "recordedAt", kind: "instant" },
  run: async (tx, organizationId, tz, f) => ({
    columns: [
      c.id("id"),
      c.id("organizationId"),
      c.id("incidentId"),
      c.id("assetId"),
      c.t("note"),
      c.id("recordedByAuthIdentityId"),
      c.ts("recordedAt"),
    ],
    rows: await tx.incidentAsset.findMany({
      where: {
        organizationId,
        ...instantRange("recordedAt", f, tz),
      },
      orderBy: [{ incidentId: "asc" }, { assetId: "asc" }],
    }),
  }),
};

const incidentTimelineDataset: DatasetDef = {
  key: "incident-timeline",
  group: "Incidents & callouts",
  label: "Incident timeline",
  description:
    "System-generated incident timeline events. `from`/`to` filter the occurred-at instant.",
  filters: DATE_ONLY,
  dateField: { name: "occurredAt", kind: "instant" },
  run: async (tx, organizationId, tz, f) => {
    const rows = await tx.incidentTimelineEvent.findMany({
      where: {
        organizationId,
        ...instantRange("occurredAt", f, tz),
      },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
    });
    return {
      columns: [
        c.id("id"),
        c.id("organizationId"),
        c.id("incidentId"),
        c.en("type"),
        c.ts("occurredAt"),
        c.id("actorAuthIdentityId"),
        c.t("metadata"),
        c.ts("createdAt"),
      ],
      rows: rows.map((r) => ({
        ...r,
        metadata: r.metadata === null ? null : JSON.stringify(r.metadata),
      })),
    };
  },
};

const incidentNotesDataset: DatasetDef = {
  key: "incident-notes",
  group: "Incidents & callouts",
  label: "Incident notes",
  description:
    "Human-authored incident notes. `from`/`to` filter entry creation. Sensitive — admin only.",
  filters: DATE_ONLY,
  dateField: { name: "createdAt", kind: "instant" },
  run: async (tx, organizationId, tz, f) => ({
    columns: [
      c.id("id"),
      c.id("organizationId"),
      c.id("incidentId"),
      c.id("authorAuthIdentityId"),
      c.en("kind"),
      c.t("body"),
      c.ts("occurredAt"),
      c.ts("createdAt"),
      c.ts("updatedAt"),
    ],
    rows: await tx.incidentNote.findMany({
      where: {
        organizationId,
        ...instantRange("createdAt", f, tz),
      },
      orderBy: [{ incidentId: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    }),
  }),
};

const incidentNoteCorrectionsDataset: DatasetDef = {
  key: "incident-note-corrections",
  group: "Incidents & callouts",
  label: "Incident note corrections",
  description:
    "Append-only before/after history for incident notes. `from`/`to` filter the correction instant.",
  filters: DATE_ONLY,
  dateField: { name: "createdAt", kind: "instant" },
  run: async (tx, organizationId, tz, f) => ({
    columns: [
      c.id("id"),
      c.id("organizationId"),
      c.id("noteId"),
      c.id("incidentId"),
      c.t("beforeBody"),
      c.t("afterBody"),
      c.t("reason"),
      c.id("actorAuthIdentityId"),
      c.ts("createdAt"),
    ],
    rows: await tx.incidentNoteCorrection.findMany({
      where: {
        organizationId,
        ...instantRange("createdAt", f, tz),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
  }),
};

const incidentChangesDataset: DatasetDef = {
  key: "incident-changes",
  group: "Incidents & callouts",
  label: "Incident changes",
  description:
    "Append-only material-field correction history. `from`/`to` filter the correction instant.",
  filters: DATE_ONLY,
  dateField: { name: "createdAt", kind: "instant" },
  run: async (tx, organizationId, tz, f) => ({
    columns: [
      c.id("id"),
      c.id("organizationId"),
      c.id("incidentId"),
      c.t("reason"),
      c.t("beforeTitle"),
      c.t("beforeSummary"),
      c.ts("beforeReportedAt"),
      c.ts("beforeDepartedAt"),
      c.ts("beforeOnSceneAt"),
      c.ts("beforeReturnedAt"),
      c.t("afterTitle"),
      c.t("afterSummary"),
      c.ts("afterReportedAt"),
      c.ts("afterDepartedAt"),
      c.ts("afterOnSceneAt"),
      c.ts("afterReturnedAt"),
      c.id("actorAuthIdentityId"),
      c.ts("createdAt"),
    ],
    rows: await tx.incidentChange.findMany({
      where: {
        organizationId,
        ...instantRange("createdAt", f, tz),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
  }),
};

const organizationDocumentsDataset: DatasetDef = {
  key: "organization-documents",
  group: "Documents & attachments",
  label: "Organization documents",
  description: "Document records (SOPs, manuals, certificates).",
  filters: NONE,
  run: async (tx, organizationId) => ({
    columns: [
      c.id("id"),
      c.id("organizationId"),
      c.t("title"),
      c.t("category"),
      c.d("effectiveOn"),
      c.d("expiresOn"),
      c.t("notes"),
      c.en("status"),
      c.id("createdByAuthIdentityId"),
      c.ts("createdAt"),
    ],
    rows: await tx.organizationDocument.findMany({
      where: { organizationId },
      orderBy: [{ title: "asc" }, { id: "asc" }],
    }),
  }),
};

const organizationDocumentVersionsDataset: DatasetDef = {
  key: "organization-document-versions",
  group: "Documents & attachments",
  label: "Document versions",
  description: "Version rows linking documents to file attachments.",
  filters: NONE,
  run: async (tx, organizationId) => ({
    columns: [
      c.id("id"),
      c.id("organizationId"),
      c.id("documentId"),
      c.id("attachmentId"),
      c.n("versionNumber"),
      c.t("note"),
      c.id("createdByAuthIdentityId"),
      c.ts("createdAt"),
    ],
    rows: await tx.organizationDocumentVersion.findMany({
      where: { organizationId },
      orderBy: [{ documentId: "asc" }, { versionNumber: "asc" }],
    }),
  }),
};

const attachmentsDataset: DatasetDef = {
  key: "attachments",
  group: "Documents & attachments",
  label: "Attachment metadata",
  description:
    "File metadata including tombstoned rows (status DELETED). Storage keys and provider internals are never exported — see docs/reporting.md for the file-retrieval path.",
  filters: DATE_ONLY,
  dateField: { name: "createdAt", kind: "instant" },
  run: async (tx, organizationId, tz, f) => ({
    columns: [
      c.id("id"),
      c.id("organizationId"),
      c.t("displayFilename"),
      c.t("mediaType"),
      c.n("sizeBytes"),
      c.t("checksumSha256"),
      c.t("description"),
      c.en("status"),
      c.t("storageProvider"),
      c.ts("deletedAt"),
      c.id("deletedByAuthIdentityId"),
      c.id("uploadedByAuthIdentityId"),
      c.ts("createdAt"),
    ],
    rows: await tx.attachment.findMany({
      where: {
        organizationId,
        ...instantRange("createdAt", f, tz),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
  }),
};

/** One row per attachment↔record link across every link table. */
const attachmentLinksDataset: DatasetDef = {
  key: "attachment-links",
  group: "Documents & attachments",
  label: "Attachment links",
  description:
    "One row per attachment-to-record link. `linkType` names the target table; `targetId` joins to that dataset's id (or to documentId for DOCUMENT_VERSION).",
  filters: NONE,
  run: async (tx, organizationId) => {
    const org = { organizationId };
    const [
      incident,
      note,
      qual,
      training,
      asset,
      insp,
      maint,
      defect,
      expense,
      docVersion,
    ] = await Promise.all([
      tx.incidentAttachment.findMany({
        where: org,
        select: { id: true, attachmentId: true, incidentId: true },
      }),
      tx.incidentNoteAttachment.findMany({
        where: org,
        select: { id: true, attachmentId: true, noteId: true },
      }),
      tx.memberQualificationAttachment.findMany({
        where: org,
        select: {
          id: true,
          attachmentId: true,
          memberQualificationId: true,
        },
      }),
      tx.trainingEventAttachment.findMany({
        where: org,
        select: { id: true, attachmentId: true, trainingEventId: true },
      }),
      tx.assetAttachment.findMany({
        where: org,
        select: { id: true, attachmentId: true, assetId: true },
      }),
      tx.inspectionRecordAttachment.findMany({
        where: org,
        select: {
          id: true,
          attachmentId: true,
          inspectionRecordId: true,
        },
      }),
      tx.maintenanceRecordAttachment.findMany({
        where: org,
        select: {
          id: true,
          attachmentId: true,
          maintenanceRecordId: true,
        },
      }),
      tx.defectAttachment.findMany({
        where: org,
        select: { id: true, attachmentId: true, defectId: true },
      }),
      tx.expenseAttachment.findMany({
        where: org,
        select: { id: true, attachmentId: true, expenseId: true },
      }),
      tx.organizationDocumentVersion.findMany({
        where: org,
        select: { id: true, attachmentId: true, documentId: true },
      }),
    ]);
    const rows = [
      ...incident.map((l) => ({
        linkId: l.id,
        linkType: "INCIDENT",
        attachmentId: l.attachmentId,
        targetId: l.incidentId,
      })),
      ...note.map((l) => ({
        linkId: l.id,
        linkType: "INCIDENT_NOTE",
        attachmentId: l.attachmentId,
        targetId: l.noteId,
      })),
      ...qual.map((l) => ({
        linkId: l.id,
        linkType: "MEMBER_QUALIFICATION",
        attachmentId: l.attachmentId,
        targetId: l.memberQualificationId,
      })),
      ...training.map((l) => ({
        linkId: l.id,
        linkType: "TRAINING_EVENT",
        attachmentId: l.attachmentId,
        targetId: l.trainingEventId,
      })),
      ...asset.map((l) => ({
        linkId: l.id,
        linkType: "ASSET",
        attachmentId: l.attachmentId,
        targetId: l.assetId,
      })),
      ...insp.map((l) => ({
        linkId: l.id,
        linkType: "INSPECTION_RECORD",
        attachmentId: l.attachmentId,
        targetId: l.inspectionRecordId,
      })),
      ...maint.map((l) => ({
        linkId: l.id,
        linkType: "MAINTENANCE_RECORD",
        attachmentId: l.attachmentId,
        targetId: l.maintenanceRecordId,
      })),
      ...defect.map((l) => ({
        linkId: l.id,
        linkType: "DEFECT",
        attachmentId: l.attachmentId,
        targetId: l.defectId,
      })),
      ...expense.map((l) => ({
        linkId: l.id,
        linkType: "EXPENSE",
        attachmentId: l.attachmentId,
        targetId: l.expenseId,
      })),
      ...docVersion.map((l) => ({
        linkId: l.id,
        linkType: "DOCUMENT_VERSION",
        attachmentId: l.attachmentId,
        targetId: l.documentId,
      })),
    ].sort(
      (a, b) =>
        a.linkType.localeCompare(b.linkType) ||
        a.attachmentId.localeCompare(b.attachmentId) ||
        a.targetId.localeCompare(b.targetId),
    );
    return {
      columns: [
        c.id("linkId"),
        c.en("linkType"),
        c.id("attachmentId"),
        c.id("targetId"),
      ],
      rows,
    };
  },
};

const vendorsDataset: DatasetDef = {
  key: "vendors",
  group: "Vendors & expenses",
  label: "Vendors",
  description: "Vendor records including contact details as recorded.",
  filters: NONE,
  run: async (tx, organizationId) => ({
    columns: [
      c.id("id"),
      c.id("organizationId"),
      c.t("name"),
      c.t("contactName"),
      c.t("email"),
      c.t("phone"),
      c.t("website"),
      c.t("accountReference"),
      c.t("notes"),
      c.en("status"),
      c.ts("createdAt"),
    ],
    rows: await tx.vendor.findMany({
      where: { organizationId },
      orderBy: { name: "asc" },
    }),
  }),
};

const expensesDataset: DatasetDef = {
  key: "expenses",
  group: "Vendors & expenses",
  label: "Expenses",
  description:
    "Bookkeeping-friendly expense rows. `amountMinor`+`currency` are exact; `amount` is the exponent-aware decimal rendering. `from`/`to` filter the org-local expense date.",
  filters: new Set<FilterKey>([
    "date",
    "vendor",
    "status",
    "reimbursementStatus",
    "currency",
    "category",
  ]),
  dateField: { name: "expenseDate", kind: "date" },
  run: async (tx, organizationId, _tz, f) => {
    const rows = await tx.expense.findMany({
      where: {
        organizationId,
        ...dateRange("expenseDate", f),
        ...(f.vendor ? { vendorId: f.vendor } : {}),
        ...(f.status ? { status: f.status } : {}),
        ...(f.reimbursementStatus
          ? { reimbursementStatus: f.reimbursementStatus }
          : {}),
        ...(f.currency ? { currency: f.currency } : {}),
        ...(f.category ? { category: f.category } : {}),
      },
      orderBy: [{ expenseDate: "asc" }, { sequence: "asc" }],
      select: {
        id: true,
        organizationId: true,
        reference: true,
        expenseDate: true,
        amountMinor: true,
        currency: true,
        vendorId: true,
        vendor: { select: { name: true } },
        category: true,
        description: true,
        status: true,
        reimbursementStatus: true,
        submittedByMemberId: true,
        submittedByMember: { select: { displayName: true } },
        paidByMemberId: true,
        paidByMember: { select: { displayName: true } },
        submittedAt: true,
        reviewedAt: true,
        reviewedByAuthIdentityId: true,
        reviewNote: true,
        reimbursedAt: true,
        reimbursedByAuthIdentityId: true,
        reimbursementNote: true,
        createdByAuthIdentityId: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { attachments: true } },
      },
    });
    return {
      columns: [
        c.id("id"),
        c.id("organizationId"),
        c.id("reference"),
        c.d("expenseDate"),
        c.n("amountMinor"),
        c.id("currency"),
        c.t("amount"),
        c.id("vendorId"),
        c.t("vendorName"),
        c.t("category"),
        c.t("description"),
        c.en("status"),
        c.en("reimbursementStatus"),
        c.id("submittedByMemberId"),
        c.t("submittedByMemberName"),
        c.id("paidByMemberId"),
        c.t("paidByMemberName"),
        c.ts("submittedAt"),
        c.ts("reviewedAt"),
        c.id("reviewedByAuthIdentityId"),
        c.t("reviewNote"),
        c.ts("reimbursedAt"),
        c.id("reimbursedByAuthIdentityId"),
        c.t("reimbursementNote"),
        c.n("attachmentCount"),
        c.id("createdByAuthIdentityId"),
        c.ts("createdAt"),
        c.ts("updatedAt"),
      ],
      rows: rows.map((e) => ({
        id: e.id,
        organizationId: e.organizationId,
        reference: e.reference,
        expenseDate: e.expenseDate,
        amountMinor: e.amountMinor,
        currency: e.currency,
        amount: amountMinorToDecimal(e.amountMinor, e.currency),
        vendorId: e.vendorId,
        vendorName: e.vendor?.name ?? null,
        category: e.category,
        description: e.description,
        status: e.status,
        reimbursementStatus: e.reimbursementStatus,
        submittedByMemberId: e.submittedByMemberId,
        submittedByMemberName: e.submittedByMember?.displayName ?? null,
        paidByMemberId: e.paidByMemberId,
        paidByMemberName: e.paidByMember?.displayName ?? null,
        submittedAt: e.submittedAt,
        reviewedAt: e.reviewedAt,
        reviewedByAuthIdentityId: e.reviewedByAuthIdentityId,
        reviewNote: e.reviewNote,
        reimbursedAt: e.reimbursedAt,
        reimbursedByAuthIdentityId: e.reimbursedByAuthIdentityId,
        reimbursementNote: e.reimbursementNote,
        attachmentCount: e._count.attachments,
        createdByAuthIdentityId: e.createdByAuthIdentityId,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
      })),
    };
  },
};

/** One row per expense↔operational-record link. */
const expenseLinksDataset: DatasetDef = {
  key: "expense-links",
  group: "Vendors & expenses",
  label: "Expense links",
  description:
    "One row per expense-to-record context link. `linkType` names the target table; `targetId` joins to that dataset's id.",
  filters: NONE,
  run: async (tx, organizationId) => {
    const org = { organizationId };
    const [incidents, training, assets, maintenance, inventory] =
      await Promise.all([
        tx.expenseIncident.findMany({
          where: org,
          select: {
            id: true,
            expenseId: true,
            incidentId: true,
            note: true,
          },
        }),
        tx.expenseTrainingEvent.findMany({
          where: org,
          select: {
            id: true,
            expenseId: true,
            trainingEventId: true,
            note: true,
          },
        }),
        tx.expenseAsset.findMany({
          where: org,
          select: {
            id: true,
            expenseId: true,
            assetId: true,
            note: true,
          },
        }),
        tx.expenseMaintenanceRecord.findMany({
          where: org,
          select: {
            id: true,
            expenseId: true,
            maintenanceRecordId: true,
            note: true,
          },
        }),
        tx.expenseInventoryItem.findMany({
          where: org,
          select: {
            id: true,
            expenseId: true,
            inventoryItemId: true,
            note: true,
          },
        }),
      ]);
    const rows = [
      ...incidents.map((l) => ({
        linkId: l.id,
        linkType: "INCIDENT",
        expenseId: l.expenseId,
        targetId: l.incidentId,
        note: l.note,
      })),
      ...training.map((l) => ({
        linkId: l.id,
        linkType: "TRAINING_EVENT",
        expenseId: l.expenseId,
        targetId: l.trainingEventId,
        note: l.note,
      })),
      ...assets.map((l) => ({
        linkId: l.id,
        linkType: "ASSET",
        expenseId: l.expenseId,
        targetId: l.assetId,
        note: l.note,
      })),
      ...maintenance.map((l) => ({
        linkId: l.id,
        linkType: "MAINTENANCE_RECORD",
        expenseId: l.expenseId,
        targetId: l.maintenanceRecordId,
        note: l.note,
      })),
      ...inventory.map((l) => ({
        linkId: l.id,
        linkType: "INVENTORY_ITEM",
        expenseId: l.expenseId,
        targetId: l.inventoryItemId,
        note: l.note,
      })),
    ].sort(
      (a, b) =>
        a.linkType.localeCompare(b.linkType) ||
        a.expenseId.localeCompare(b.expenseId) ||
        a.targetId.localeCompare(b.targetId),
    );
    return {
      columns: [
        c.id("linkId"),
        c.en("linkType"),
        c.id("expenseId"),
        c.id("targetId"),
        c.t("note"),
      ],
      rows,
    };
  },
};

const expenseEventsDataset: DatasetDef = {
  key: "expense-events",
  group: "Vendors & expenses",
  label: "Expense events",
  description:
    "Append-only expense lifecycle/audit feed. `from`/`to` filter the occurred-at instant.",
  filters: DATE_ONLY,
  dateField: { name: "occurredAt", kind: "instant" },
  run: async (tx, organizationId, tz, f) => {
    const rows = await tx.expenseEvent.findMany({
      where: {
        organizationId,
        ...instantRange("occurredAt", f, tz),
      },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
    });
    return {
      columns: [
        c.id("id"),
        c.id("organizationId"),
        c.id("expenseId"),
        c.en("type"),
        c.ts("occurredAt"),
        c.id("actorAuthIdentityId"),
        c.t("metadata"),
        c.ts("createdAt"),
      ],
      rows: rows.map((r) => ({
        ...r,
        metadata: r.metadata === null ? null : JSON.stringify(r.metadata),
      })),
    };
  },
};

const expenseChangesDataset: DatasetDef = {
  key: "expense-changes",
  group: "Vendors & expenses",
  label: "Expense changes",
  description:
    "Append-only before/after correction history. `from`/`to` filter the correction instant.",
  filters: DATE_ONLY,
  dateField: { name: "createdAt", kind: "instant" },
  run: async (tx, organizationId, tz, f) => ({
    columns: [
      c.id("id"),
      c.id("organizationId"),
      c.id("expenseId"),
      c.t("reason"),
      c.d("beforeExpenseDate"),
      c.n("beforeAmountMinor"),
      c.id("beforeCurrency"),
      c.id("beforeVendorId"),
      c.t("beforeCategory"),
      c.t("beforeDescription"),
      c.id("beforeSubmittedByMemberId"),
      c.id("beforePaidByMemberId"),
      c.d("afterExpenseDate"),
      c.n("afterAmountMinor"),
      c.id("afterCurrency"),
      c.id("afterVendorId"),
      c.t("afterCategory"),
      c.t("afterDescription"),
      c.id("afterSubmittedByMemberId"),
      c.id("afterPaidByMemberId"),
      c.id("actorAuthIdentityId"),
      c.ts("createdAt"),
    ],
    rows: await tx.expenseChange.findMany({
      where: {
        organizationId,
        ...instantRange("createdAt", f, tz),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
  }),
};

const dataExportEventsDataset: DatasetDef = {
  key: "data-export-events",
  group: "Documents & attachments",
  label: "Export audit history",
  description:
    "The DataExportEvent audit trail itself — who exported which dataset, when, and with which structured filters.",
  filters: DATE_ONLY,
  dateField: { name: "createdAt", kind: "instant" },
  run: async (tx, organizationId, tz, f) => {
    const rows = await tx.dataExportEvent.findMany({
      where: {
        organizationId,
        ...instantRange("createdAt", f, tz),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return {
      columns: [
        c.id("id"),
        c.id("organizationId"),
        c.id("actorAuthIdentityId"),
        c.en("exportType"),
        c.en("format"),
        c.t("filters"),
        c.n("recordCount"),
        c.ts("createdAt"),
      ],
      rows: rows.map((r) => ({
        ...r,
        filters: r.filters === null ? null : JSON.stringify(r.filters),
      })),
    };
  },
};

export const EXPORT_DATASETS: DatasetDef[] = [
  organizationDataset,
  unitsDataset,
  membersDataset,
  memberUnitsDataset,
  memberAvailabilityDataset,
  memberNotificationPreferencesDataset,
  qualificationDefinitionsDataset,
  memberQualificationsDataset,
  trainingEventsDataset,
  trainingTopicsDataset,
  trainingAttendanceDataset,
  storageLocationsDataset,
  assetsDataset,
  inventoryItemsDataset,
  inspectionDefinitionsDataset,
  inspectionRecordsDataset,
  maintenancePlansDataset,
  maintenanceRecordsDataset,
  assetMetersDataset,
  assetMeterReadingsDataset,
  defectsDataset,
  calloutsDataset,
  calloutInvitationsDataset,
  incidentsDataset,
  incidentParticipantsDataset,
  incidentAssetsDataset,
  incidentTimelineDataset,
  incidentNotesDataset,
  incidentNoteCorrectionsDataset,
  incidentChangesDataset,
  organizationDocumentsDataset,
  organizationDocumentVersionsDataset,
  attachmentsDataset,
  attachmentLinksDataset,
  vendorsDataset,
  expensesDataset,
  expenseLinksDataset,
  expenseEventsDataset,
  expenseChangesDataset,
  dataExportEventsDataset,
];

const BY_KEY = new Map(EXPORT_DATASETS.map((d) => [d.key, d]));

export function getExportDataset(key: string): DatasetDef | undefined {
  return BY_KEY.get(key);
}
