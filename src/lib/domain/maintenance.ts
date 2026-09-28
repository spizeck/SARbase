import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { log } from "@/lib/logging";
import { calendarDateInZone, daysBetween, formatDateOnly } from "@/lib/dates";

import type {
  AssetMeterInput,
  AssetMeterStatusInput,
  DefectInput,
  DefectTransitionInput,
  InspectionDefinitionInput,
  InspectionDefinitionStatusInput,
  InspectionRecordInput,
  InspectionRecordUpdate,
  MaintenancePlanInput,
  MaintenancePlanStatusInput,
  MaintenanceRecordInput,
  MaintenanceRecordUpdate,
  MeterReadingInput,
} from "./schemas";

/**
 * Inspections, maintenance history, defects, and factual due tracking
 * (issue #11).
 *
 * PRODUCT BOUNDARY: every record here is a factual administrative fact —
 * "inspection performed on 2026-09-15", "service done at 812.4 hours",
 * "defect reported", "next due 2026-10-15". NOTHING in this module
 * infers safety, readiness, launch-worthiness, mission suitability, or
 * operational unavailability. An overdue inspection is rendered as
 * "overdue by 12 days", never as "unsafe" or "cannot deploy". Humans
 * decide operational meaning.
 *
 * Target decision: all records attach to Asset only. InventoryItem
 * consumable/expiry tracking is deliberately deferred — a polymorphic
 * (asset-or-item) target would weaken the composite-FK integrity model
 * for no real gain in v1, and items that genuinely need per-unit
 * inspection (a specific flare kit, an oxygen kit) can be modeled as
 * Assets, which is what they are.
 *
 * Same-organization integrity follows the issue #10 pattern: every
 * record carries a denormalized organizationId and composite foreign
 * keys, so a cross-organization asset/definition/plan/meter/member
 * reference is impossible at the database level. Domain checks produce
 * the friendly error first.
 *
 * History is append-only at the row level: inspections, service
 * records, meter readings, and defect lifecycle changes are never
 * destructively deleted through the application surface. Corrections
 * edit factual fields in place (updatedAt); defect OPEN/RESOLVED/
 * REOPENED transitions are audited by DefectChange rows, following the
 * TrainingAttendanceChange pattern — narrow domain history, not a
 * generic audit framework.
 */

export class CrossOrganizationMaintenanceError extends Error {
  constructor() {
    super(
      "Maintenance, inspection, and defect records can only reference same-organization records.",
    );
    this.name = "CrossOrganizationMaintenanceError";
  }
}

export class InactiveInspectionDefinitionError extends Error {
  constructor() {
    super("This inspection type is inactive — it cannot receive new records.");
    this.name = "InactiveInspectionDefinitionError";
  }
}

export class InactiveMaintenancePlanError extends Error {
  constructor() {
    super("This maintenance plan is inactive — it cannot receive new records.");
    this.name = "InactiveMaintenancePlanError";
  }
}

export class ArchivedMeterError extends Error {
  constructor() {
    super("This meter is archived — it cannot receive new readings.");
    this.name = "ArchivedMeterError";
  }
}

export class DefectTransitionError extends Error {
  constructor(message = "That defect is already in the requested state.") {
    super(message);
    this.name = "DefectTransitionError";
  }
}

/* ------------------------------------------------------------------ */
/* Pure due-date / recurrence helpers (deterministic, unit-tested)     */
/* ------------------------------------------------------------------ */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Add calendar months clamping to the target month's last day. */
function addMonthsUtc(date: Date, months: number): Date {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  const d = date.getUTCDate();
  const firstOfTarget = new Date(Date.UTC(y, m + months, 1));
  const lastOfTarget = new Date(
    Date.UTC(
      firstOfTarget.getUTCFullYear(),
      firstOfTarget.getUTCMonth() + 1,
      0,
    ),
  ).getUTCDate();
  return new Date(
    Date.UTC(
      firstOfTarget.getUTCFullYear(),
      firstOfTarget.getUTCMonth(),
      Math.min(d, lastOfTarget),
    ),
  );
}

/**
 * Next calendar due date for a recurring requirement, given the date it
 * was last performed. Returns null for NONE / METER_INTERVAL — meter
 * due thresholds are derived separately from readings.
 */
export function addRecurrence(
  performedOn: Date,
  recurrenceType:
    "NONE" | "CALENDAR_DAYS" | "CALENDAR_MONTHS" | "METER_INTERVAL",
  intervalValue: number | null | undefined,
): Date | null {
  if (recurrenceType === "CALENDAR_DAYS" && intervalValue) {
    return new Date(performedOn.getTime() + intervalValue * DAY_MS);
  }
  if (recurrenceType === "CALENDAR_MONTHS" && intervalValue) {
    return addMonthsUtc(performedOn, intervalValue);
  }
  return null;
}

export type DateDueState =
  | "overdue" // due date strictly before the org-local today
  | "due_today" // due date IS the org-local today — still due all day
  | "due_soon" // due within the presentation window
  | "scheduled"; // due beyond the window

export interface DateDueInfo {
  state: DateDueState;
  /** Days from today until the due date; negative once overdue. */
  daysUntil: number;
}

/**
 * Classify a stored due date against the ORGANIZATION-LOCAL "today".
 * A due date is valid through that day: overdue begins the next local
 * day. `windowDays` is presentation only — it is not policy.
 */
export function classifyDateDue(
  dueOn: Date,
  today: Date,
  windowDays = 30,
): DateDueInfo {
  const daysUntil = daysBetween(today, dueOn);
  if (daysUntil < 0) return { state: "overdue", daysUntil };
  if (daysUntil === 0) return { state: "due_today", daysUntil };
  if (daysUntil <= windowDays) return { state: "due_soon", daysUntil };
  return { state: "scheduled", daysUntil };
}

/** Factual due label — dates and day counts only, never a verdict. */
export function dateDueLabel(
  dueOn: Date | null,
  today: Date,
  windowDays = 30,
): string {
  if (!dueOn) return "No due date recorded";
  const formatted = formatDateOnly(dueOn);
  const { state, daysUntil } = classifyDateDue(dueOn, today, windowDays);
  switch (state) {
    case "overdue":
      return `Overdue by ${-daysUntil} day${daysUntil === -1 ? "" : "s"} (due ${formatted})`;
    case "due_today":
      return `Due today (${formatted})`;
    case "due_soon":
      return `Due in ${daysUntil} day${daysUntil === 1 ? "" : "s"} (${formatted})`;
    case "scheduled":
      return `Due ${formatted}`;
  }
}

export type MeterDueState =
  | "never_performed" // plan exists but no record supplies a baseline
  | "no_reading" // a baseline exists but the meter has no current reading
  | "threshold_reached" // current reading >= due reading (includes exceeded)
  | "below_threshold";

export interface MeterDueInfo {
  state: MeterDueState;
  /** The recorded due threshold, when derivable. */
  dueReading: Prisma.Decimal | null;
  /** Latest meter reading, when one exists. */
  currentReading: Prisma.Decimal | null;
}

/**
 * Meter-based due fact. Positive `remaining` = still under threshold;
 * when the threshold is met or exceeded, `overBy` is the amount past it.
 */
export function classifyMeterDue(
  baselineReading: Prisma.Decimal | null,
  meterInterval: Prisma.Decimal | null,
  currentReading: Prisma.Decimal | null,
): MeterDueInfo & {
  remaining: Prisma.Decimal | null;
  overBy: Prisma.Decimal | null;
} {
  if (!baselineReading || !meterInterval) {
    return {
      state: "never_performed",
      dueReading: null,
      currentReading,
      remaining: null,
      overBy: null,
    };
  }
  const dueReading = baselineReading.plus(meterInterval);
  if (!currentReading) {
    return {
      state: "no_reading",
      dueReading,
      currentReading: null,
      remaining: null,
      overBy: null,
    };
  }
  const overBy = currentReading.minus(dueReading);
  if (overBy.greaterThanOrEqualTo(0)) {
    return {
      state: "threshold_reached",
      dueReading,
      currentReading,
      remaining: new Prisma.Decimal(0),
      overBy,
    };
  }
  return {
    state: "below_threshold",
    dueReading,
    currentReading,
    remaining: overBy.negated(),
    overBy: null,
  };
}

/* ------------------------------------------------------------------ */
/* Internal helpers                                                    */
/* ------------------------------------------------------------------ */

/** Load an asset row or fail opaquely (same contract as authz lookups). */
async function loadAsset(assetId: string) {
  const asset = await prisma.asset.findUnique({ where: { id: assetId } });
  if (!asset) {
    throw new CrossOrganizationMaintenanceError();
  }
  return asset;
}

/**
 * Require that an optional member reference belongs to the same org.
 * The composite FK enforces this at the DB layer; this produces the
 * friendly error.
 */
async function assertSameOrgMember(
  memberId: string | undefined,
  organizationId: string,
) {
  if (!memberId) return;
  const member = await prisma.member.findUnique({ where: { id: memberId } });
  if (!member || member.organizationId !== organizationId) {
    throw new CrossOrganizationMaintenanceError();
  }
}

/**
 * Require that a meter reference belongs to the same org AND the same
 * asset — recording a reading against a different asset's meter is
 * meaningless. ARCHIVED meters refuse new readings.
 */
async function assertUsableMeter(
  meterId: string | undefined,
  organizationId: string,
  assetId: string,
) {
  if (!meterId) return null;
  const meter = await prisma.assetMeter.findUnique({ where: { id: meterId } });
  if (
    !meter ||
    meter.organizationId !== organizationId ||
    meter.assetId !== assetId
  ) {
    throw new CrossOrganizationMaintenanceError();
  }
  if (meter.status !== "ACTIVE") {
    throw new ArchivedMeterError();
  }
  return meter;
}

/** The current factual reading of a meter: latest by date, then entry. */
async function latestMeterReading(
  meterId: string,
  tx: Prisma.TransactionClient | typeof prisma = prisma,
) {
  return tx.assetMeterReading.findFirst({
    where: { meterId },
    orderBy: [{ recordedOn: "desc" }, { createdAt: "desc" }],
  });
}

/* ------------------------------------------------------------------ */
/* Inspection definitions — what the organization tracks               */
/* ------------------------------------------------------------------ */

export function listInspectionDefinitions(
  organizationId: string,
  options: { includeInactive?: boolean } = {},
) {
  return prisma.inspectionDefinition.findMany({
    where: {
      organizationId,
      ...(options.includeInactive ? {} : { status: "ACTIVE" }),
    },
    orderBy: { name: "asc" },
    include: { _count: { select: { records: true } } },
  });
}

export async function createInspectionDefinition(
  organizationId: string,
  input: InspectionDefinitionInput,
) {
  const definition = await prisma.inspectionDefinition.create({
    data: {
      organizationId,
      name: input.name,
      description: input.description ?? null,
      recurrenceType: input.recurrenceType,
      intervalValue:
        input.recurrenceType === "NONE" ? null : (input.intervalValue ?? null),
    },
  });
  log({
    event: "inspection_definition_created",
    subsystem: "domain",
    entityType: "inspection_definition",
    entityId: definition.id,
    organizationId,
  });
  return definition;
}

export async function updateInspectionDefinition(
  definitionId: string,
  input: InspectionDefinitionInput,
) {
  const definition = await prisma.inspectionDefinition.update({
    where: { id: definitionId },
    data: {
      name: input.name,
      description: input.description ?? null,
      recurrenceType: input.recurrenceType,
      intervalValue:
        input.recurrenceType === "NONE" ? null : (input.intervalValue ?? null),
    },
  });
  log({
    event: "inspection_definition_updated",
    subsystem: "domain",
    entityType: "inspection_definition",
    entityId: definition.id,
  });
  return definition;
}

export async function setInspectionDefinitionStatus(
  definitionId: string,
  status: InspectionDefinitionStatusInput,
) {
  const definition = await prisma.inspectionDefinition.update({
    where: { id: definitionId },
    data: { status },
  });
  log({
    event: "inspection_definition_status_changed",
    subsystem: "domain",
    entityType: "inspection_definition",
    entityId: definition.id,
    detail: { status },
  });
  return definition;
}

/* ------------------------------------------------------------------ */
/* Inspection records — factual occurrences                            */
/* ------------------------------------------------------------------ */

export function listAssetInspections(assetId: string) {
  return prisma.inspectionRecord.findMany({
    where: { assetId },
    orderBy: [{ performedOn: "desc" }, { createdAt: "desc" }],
    include: {
      definition: { select: { id: true, name: true } },
      inspectorMember: { select: { id: true, displayName: true } },
      meter: { select: { id: true, name: true, unit: true } },
    },
  });
}

/**
 * Record an inspection. The asset is the entry point; the definition,
 * meter, and inspector member are all validated same-organization
 * (friendly error first, composite FKs second). When the definition
 * carries calendar recurrence and no explicit nextDueOn is supplied,
 * the due date is derived and stored as a fact — a stored fact, not a
 * computed verdict. A meter reading captured here also appends an
 * AssetMeterReading row (provenance-linked) in the same transaction so
 * "current reading" has one append-only source of truth.
 */
export async function recordInspection(
  assetId: string,
  input: InspectionRecordInput,
) {
  const asset = await loadAsset(assetId);

  const definition = await prisma.inspectionDefinition.findUnique({
    where: { id: input.definitionId },
  });
  if (!definition || definition.organizationId !== asset.organizationId) {
    throw new CrossOrganizationMaintenanceError();
  }
  if (definition.status !== "ACTIVE") {
    throw new InactiveInspectionDefinitionError();
  }

  await assertSameOrgMember(input.inspectorMemberId, asset.organizationId);
  await assertUsableMeter(input.meterId, asset.organizationId, asset.id);

  const nextDueOn =
    input.nextDueOn ??
    addRecurrence(
      input.performedOn,
      definition.recurrenceType,
      definition.intervalValue,
    );

  const record = await prisma.$transaction(async (tx) => {
    const created = await tx.inspectionRecord.create({
      data: {
        organizationId: asset.organizationId,
        assetId: asset.id,
        definitionId: definition.id,
        performedOn: input.performedOn,
        inspectorMemberId: input.inspectorMemberId ?? null,
        inspectorName: input.inspectorName ?? null,
        conditionObserved: input.conditionObserved ?? null,
        nextDueOn,
        meterId: input.meterId ?? null,
        meterReading: input.meterReading ?? null,
        notes: input.notes ?? null,
      },
    });
    if (input.meterId && input.meterReading != null) {
      await tx.assetMeterReading.create({
        data: {
          organizationId: asset.organizationId,
          meterId: input.meterId,
          reading: input.meterReading,
          recordedOn: input.performedOn,
          recordedByMemberId: input.inspectorMemberId ?? null,
          inspectionRecordId: created.id,
        },
      });
    }
    return created;
  });

  log({
    event: "inspection_recorded",
    subsystem: "domain",
    entityType: "inspection_record",
    entityId: record.id,
    organizationId: asset.organizationId,
  });
  return record;
}

/**
 * Correct a recorded inspection's factual fields in place (updatedAt
 * marks the correction). Asset, definition, and the captured meter
 * reading are immutable — a wrong reading is corrected by recording a
 * new reading, preserving the append-only meter history.
 */
export async function updateInspectionRecord(
  recordId: string,
  input: InspectionRecordUpdate,
) {
  const existing = await prisma.inspectionRecord.findUnique({
    where: { id: recordId },
    select: { organizationId: true },
  });
  if (!existing) {
    throw new CrossOrganizationMaintenanceError();
  }
  await assertSameOrgMember(input.inspectorMemberId, existing.organizationId);
  const record = await prisma.inspectionRecord.update({
    where: { id: recordId },
    data: {
      performedOn: input.performedOn,
      inspectorMemberId: input.inspectorMemberId ?? null,
      inspectorName: input.inspectorName ?? null,
      conditionObserved: input.conditionObserved ?? null,
      nextDueOn: input.nextDueOn ?? null,
      notes: input.notes ?? null,
    },
  });
  log({
    event: "inspection_record_updated",
    subsystem: "domain",
    entityType: "inspection_record",
    entityId: record.id,
  });
  return record;
}

/* ------------------------------------------------------------------ */
/* Maintenance plans — per-asset recurring requirements                */
/* ------------------------------------------------------------------ */

export function listAssetMaintenancePlans(
  assetId: string,
  options: { includeInactive?: boolean } = {},
) {
  return prisma.maintenancePlan.findMany({
    where: {
      assetId,
      ...(options.includeInactive ? {} : { status: "ACTIVE" }),
    },
    orderBy: { name: "asc" },
    include: {
      meter: { select: { id: true, name: true, unit: true } },
      _count: { select: { records: true } },
    },
  });
}

export async function createMaintenancePlan(
  assetId: string,
  input: MaintenancePlanInput,
) {
  const asset = await loadAsset(assetId);
  if (input.intervalType === "METER_INTERVAL") {
    await assertUsableMeter(input.meterId, asset.organizationId, asset.id);
  }
  const plan = await prisma.maintenancePlan.create({
    data: {
      organizationId: asset.organizationId,
      assetId: asset.id,
      name: input.name,
      description: input.description ?? null,
      intervalType: input.intervalType,
      intervalValue:
        input.intervalType === "CALENDAR_DAYS" ||
        input.intervalType === "CALENDAR_MONTHS"
          ? (input.intervalValue ?? null)
          : null,
      meterId: input.intervalType === "METER_INTERVAL" ? input.meterId! : null,
      meterInterval:
        input.intervalType === "METER_INTERVAL"
          ? (input.meterInterval ?? null)
          : null,
    },
  });
  log({
    event: "maintenance_plan_created",
    subsystem: "domain",
    entityType: "maintenance_plan",
    entityId: plan.id,
    organizationId: asset.organizationId,
  });
  return plan;
}

export async function updateMaintenancePlan(
  planId: string,
  input: MaintenancePlanInput,
) {
  const plan = await prisma.maintenancePlan.findUnique({
    where: { id: planId },
  });
  if (!plan) {
    throw new CrossOrganizationMaintenanceError();
  }
  if (input.intervalType === "METER_INTERVAL") {
    await assertUsableMeter(input.meterId, plan.organizationId, plan.assetId);
  }
  const updated = await prisma.maintenancePlan.update({
    where: { id: planId },
    data: {
      name: input.name,
      description: input.description ?? null,
      intervalType: input.intervalType,
      intervalValue:
        input.intervalType === "CALENDAR_DAYS" ||
        input.intervalType === "CALENDAR_MONTHS"
          ? (input.intervalValue ?? null)
          : null,
      meterId: input.intervalType === "METER_INTERVAL" ? input.meterId! : null,
      meterInterval:
        input.intervalType === "METER_INTERVAL"
          ? (input.meterInterval ?? null)
          : null,
    },
  });
  log({
    event: "maintenance_plan_updated",
    subsystem: "domain",
    entityType: "maintenance_plan",
    entityId: updated.id,
  });
  return updated;
}

export async function setMaintenancePlanStatus(
  planId: string,
  status: MaintenancePlanStatusInput,
) {
  const plan = await prisma.maintenancePlan.update({
    where: { id: planId },
    data: { status },
  });
  log({
    event: "maintenance_plan_status_changed",
    subsystem: "domain",
    entityType: "maintenance_plan",
    entityId: plan.id,
    detail: { status },
  });
  return plan;
}

/* ------------------------------------------------------------------ */
/* Maintenance records — factual service events                        */
/* ------------------------------------------------------------------ */

export function listAssetMaintenanceRecords(assetId: string) {
  return prisma.maintenanceRecord.findMany({
    where: { assetId },
    orderBy: [{ performedOn: "desc" }, { createdAt: "desc" }],
    include: {
      plan: { select: { id: true, name: true } },
      performedByMember: { select: { id: true, displayName: true } },
      meter: { select: { id: true, name: true, unit: true } },
    },
  });
}

/**
 * Record a service/repair event. planId is optional (ad-hoc work); when
 * present the plan must be same-org, same-asset, and ACTIVE. A meter
 * reading captured here writes through to AssetMeterReading in the same
 * transaction (provenance-linked). nextDueOn is an explicit fact, used
 * for plan-less records; for plan-linked records the due follow-up is
 * derived from the plan's recurrence at read time.
 */
export async function recordMaintenance(
  assetId: string,
  input: MaintenanceRecordInput,
) {
  const asset = await loadAsset(assetId);

  let plan = null;
  if (input.planId) {
    plan = await prisma.maintenancePlan.findUnique({
      where: { id: input.planId },
    });
    if (
      !plan ||
      plan.organizationId !== asset.organizationId ||
      plan.assetId !== asset.id
    ) {
      throw new CrossOrganizationMaintenanceError();
    }
    if (plan.status !== "ACTIVE") {
      throw new InactiveMaintenancePlanError();
    }
  }

  await assertSameOrgMember(input.performedByMemberId, asset.organizationId);
  await assertUsableMeter(input.meterId, asset.organizationId, asset.id);

  const record = await prisma.$transaction(async (tx) => {
    const created = await tx.maintenanceRecord.create({
      data: {
        organizationId: asset.organizationId,
        assetId: asset.id,
        planId: plan?.id ?? null,
        performedOn: input.performedOn,
        title: input.title,
        workPerformed: input.workPerformed ?? null,
        providerName: input.providerName ?? null,
        performedByMemberId: input.performedByMemberId ?? null,
        meterId: input.meterId ?? null,
        meterReading: input.meterReading ?? null,
        nextDueOn: input.nextDueOn ?? null,
        notes: input.notes ?? null,
      },
    });
    if (input.meterId && input.meterReading != null) {
      await tx.assetMeterReading.create({
        data: {
          organizationId: asset.organizationId,
          meterId: input.meterId,
          reading: input.meterReading,
          recordedOn: input.performedOn,
          recordedByMemberId: input.performedByMemberId ?? null,
          maintenanceRecordId: created.id,
        },
      });
    }
    return created;
  });

  log({
    event: "maintenance_recorded",
    subsystem: "domain",
    entityType: "maintenance_record",
    entityId: record.id,
    organizationId: asset.organizationId,
  });
  return record;
}

/**
 * Correct a recorded service event's factual fields in place. Asset,
 * plan, and the captured meter reading are immutable — append-only
 * history is preserved by recording a new reading instead of editing.
 */
export async function updateMaintenanceRecord(
  recordId: string,
  input: MaintenanceRecordUpdate,
) {
  const existing = await prisma.maintenanceRecord.findUnique({
    where: { id: recordId },
    select: { organizationId: true },
  });
  if (!existing) {
    throw new CrossOrganizationMaintenanceError();
  }
  await assertSameOrgMember(input.performedByMemberId, existing.organizationId);
  const record = await prisma.maintenanceRecord.update({
    where: { id: recordId },
    data: {
      title: input.title,
      performedOn: input.performedOn,
      workPerformed: input.workPerformed ?? null,
      providerName: input.providerName ?? null,
      performedByMemberId: input.performedByMemberId ?? null,
      nextDueOn: input.nextDueOn ?? null,
      notes: input.notes ?? null,
    },
  });
  log({
    event: "maintenance_record_updated",
    subsystem: "domain",
    entityType: "maintenance_record",
    entityId: record.id,
  });
  return record;
}

/* ------------------------------------------------------------------ */
/* Defects — human-reported factual issues                             */
/* ------------------------------------------------------------------ */

export function listAssetDefects(assetId: string) {
  return prisma.defect.findMany({
    where: { assetId },
    orderBy: [{ status: "asc" }, { reportedOn: "desc" }, { createdAt: "desc" }],
    include: {
      reportedByMember: { select: { id: true, displayName: true } },
      _count: { select: { changes: true } },
    },
  });
}

export function listOpenDefects(organizationId: string) {
  return prisma.defect.findMany({
    where: { organizationId, status: "OPEN" },
    orderBy: [{ reportedOn: "desc" }, { createdAt: "desc" }],
    include: {
      asset: { select: { id: true, name: true } },
      reportedByMember: { select: { id: true, displayName: true } },
    },
  });
}

export function listDefectChanges(defectId: string) {
  return prisma.defectChange.findMany({
    where: { defectId },
    orderBy: { createdAt: "asc" },
    include: {
      actorAuthIdentity: { select: { id: true, email: true } },
    },
  });
}

/**
 * Report a defect. Creates the defect (OPEN) and its REPORTED change
 * row in one transaction. `markOutOfService` is an explicit human
 * choice: it sets Asset.status = OUT_OF_SERVICE via the same
 * transaction — the defect itself never implies it, and resolving the
 * defect never restores ACTIVE.
 */
export async function reportDefect(
  assetId: string,
  input: DefectInput,
  actorAuthIdentityId: string,
  options: { markOutOfService?: boolean } = {},
) {
  const asset = await loadAsset(assetId);
  await assertSameOrgMember(input.reportedByMemberId, asset.organizationId);

  const defect = await prisma.$transaction(async (tx) => {
    const created = await tx.defect.create({
      data: {
        organizationId: asset.organizationId,
        assetId: asset.id,
        reportedOn: input.reportedOn,
        reportedByMemberId: input.reportedByMemberId ?? null,
        reporterName: input.reporterName ?? null,
        title: input.title,
        description: input.description ?? null,
      },
    });
    await tx.defectChange.create({
      data: {
        organizationId: asset.organizationId,
        defectId: created.id,
        action: "REPORTED",
        actorAuthIdentityId,
      },
    });
    if (options.markOutOfService && asset.status !== "OUT_OF_SERVICE") {
      await tx.asset.update({
        where: { id: asset.id },
        data: { status: "OUT_OF_SERVICE" },
      });
    }
    return created;
  });

  log({
    event: "defect_reported",
    subsystem: "domain",
    entityType: "defect",
    entityId: defect.id,
    organizationId: asset.organizationId,
  });
  return defect;
}

/** Correct factual fields of a defect in place (title/description/dates/reporter). */
export async function updateDefect(defectId: string, input: DefectInput) {
  const existing = await prisma.defect.findUnique({ where: { id: defectId } });
  if (!existing) {
    throw new CrossOrganizationMaintenanceError();
  }
  await assertSameOrgMember(input.reportedByMemberId, existing.organizationId);
  if (
    existing.status === "RESOLVED" &&
    input.reportedOn > existing.resolvedOn!
  ) {
    throw new DefectTransitionError(
      "The report date cannot be later than the resolution date.",
    );
  }
  const defect = await prisma.defect.update({
    where: { id: defectId },
    data: {
      title: input.title,
      description: input.description ?? null,
      reportedOn: input.reportedOn,
      reportedByMemberId: input.reportedByMemberId ?? null,
      reporterName: input.reporterName ?? null,
    },
  });
  log({
    event: "defect_updated",
    subsystem: "domain",
    entityType: "defect",
    entityId: defect.id,
  });
  return defect;
}

/**
 * Transition a defect's lifecycle: OPEN -> RESOLVED, RESOLVED -> OPEN
 * (reopened). Every transition appends a DefectChange row naming the
 * acting admin. resolvedOn cannot precede reportedOn. resolvedOn /
 * resolutionNotes persist after a reopen — they remain the record of
 * the most recent resolution while status shows the defect is open
 * again; the full timeline lives in DefectChange.
 */
export async function transitionDefect(
  defectId: string,
  input: DefectTransitionInput,
  actorAuthIdentityId: string,
) {
  const defect = await prisma.defect.findUnique({ where: { id: defectId } });
  if (!defect) {
    throw new CrossOrganizationMaintenanceError();
  }
  if (defect.status === input.status) {
    throw new DefectTransitionError();
  }
  if (input.status === "RESOLVED" && input.resolvedOn! < defect.reportedOn) {
    throw new DefectTransitionError(
      "The resolution date cannot be earlier than the report date.",
    );
  }

  const action = input.status === "RESOLVED" ? "RESOLVED" : "REOPENED";
  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.defect.update({
      where: { id: defect.id },
      data:
        input.status === "RESOLVED"
          ? {
              status: "RESOLVED",
              resolvedOn: input.resolvedOn!,
              resolutionNotes: input.resolutionNotes ?? null,
            }
          : { status: "OPEN" },
    });
    await tx.defectChange.create({
      data: {
        organizationId: defect.organizationId,
        defectId: defect.id,
        action,
        note: input.note ?? null,
        actorAuthIdentityId,
      },
    });
    return row;
  });

  log({
    event: "defect_transitioned",
    subsystem: "domain",
    entityType: "defect",
    entityId: defect.id,
    organizationId: defect.organizationId,
    detail: { action },
  });
  return updated;
}

/* ------------------------------------------------------------------ */
/* Meters — manually recorded counters on assets                       */
/* ------------------------------------------------------------------ */

export function listAssetMeters(assetId: string) {
  return prisma.assetMeter.findMany({
    where: { assetId },
    orderBy: { name: "asc" },
    include: {
      readings: {
        orderBy: [{ recordedOn: "desc" }, { createdAt: "desc" }],
        take: 1,
      },
      _count: { select: { readings: true } },
    },
  });
}

export async function createAssetMeter(
  assetId: string,
  input: AssetMeterInput,
) {
  const asset = await loadAsset(assetId);
  const meter = await prisma.assetMeter.create({
    data: {
      organizationId: asset.organizationId,
      assetId: asset.id,
      name: input.name,
      unit: input.unit,
    },
  });
  log({
    event: "asset_meter_created",
    subsystem: "domain",
    entityType: "asset_meter",
    entityId: meter.id,
    organizationId: asset.organizationId,
  });
  return meter;
}

export async function updateAssetMeter(
  meterId: string,
  input: AssetMeterInput,
) {
  const meter = await prisma.assetMeter.update({
    where: { id: meterId },
    data: { name: input.name, unit: input.unit },
  });
  log({
    event: "asset_meter_updated",
    subsystem: "domain",
    entityType: "asset_meter",
    entityId: meter.id,
  });
  return meter;
}

export async function setAssetMeterStatus(
  meterId: string,
  status: AssetMeterStatusInput,
) {
  const meter = await prisma.assetMeter.update({
    where: { id: meterId },
    data: { status },
  });
  log({
    event: "asset_meter_status_changed",
    subsystem: "domain",
    entityType: "asset_meter",
    entityId: meter.id,
    detail: { status },
  });
  return meter;
}

export function listMeterReadings(meterId: string) {
  return prisma.assetMeterReading.findMany({
    where: { meterId },
    orderBy: [{ recordedOn: "desc" }, { createdAt: "desc" }],
    include: {
      recordedByMember: { select: { id: true, displayName: true } },
    },
  });
}

/**
 * Append a factual meter reading. Readings are never edited — a wrong
 * value is corrected by recording the right one (latest by
 * (recordedOn, createdAt) is "current"). No monotonicity is enforced:
 * meters are reset and replaced in the real world, so a lower reading
 * than a previous one is a legal fact.
 */
export async function recordMeterReading(
  meterId: string,
  input: MeterReadingInput,
) {
  const meter = await prisma.assetMeter.findUnique({ where: { id: meterId } });
  if (!meter) {
    throw new CrossOrganizationMaintenanceError();
  }
  if (meter.status !== "ACTIVE") {
    throw new ArchivedMeterError();
  }
  await assertSameOrgMember(input.recordedByMemberId, meter.organizationId);

  const reading = await prisma.assetMeterReading.create({
    data: {
      organizationId: meter.organizationId,
      meterId: meter.id,
      reading: input.reading,
      recordedOn: input.recordedOn,
      recordedByMemberId: input.recordedByMemberId ?? null,
      notes: input.notes ?? null,
    },
  });
  log({
    event: "meter_reading_recorded",
    subsystem: "domain",
    entityType: "asset_meter_reading",
    entityId: reading.id,
    organizationId: meter.organizationId,
  });
  return reading;
}

/* ------------------------------------------------------------------ */
/* Due lists — deterministic, factual, query-derived                   */
/*                                                                     */
/* These are the "reminders" issue #11 needs: derived facts rendered   */
/* for admins. There are no reminder jobs and no delivery — issue #13  */
/* will consume the same functions when notification delivery lands.   */
/* ------------------------------------------------------------------ */

export interface InspectionDueEntry {
  assetId: string;
  assetName: string;
  definitionId: string;
  definitionName: string;
  nextDueOn: Date;
  due: DateDueInfo;
}

export type MaintenanceDueEntry =
  | {
      kind: "plan";
      planId: string;
      planName: string;
      assetId: string;
      assetName: string;
      due: DateDueInfo | null;
      nextDueOn: Date | null;
      meter:
        | (MeterDueInfo & {
            remaining: Prisma.Decimal | null;
            overBy: Prisma.Decimal | null;
          })
        | null;
      meterName: string | null;
      meterUnit: string | null;
      neverPerformed: boolean;
    }
  | {
      kind: "ad_hoc";
      recordId: string;
      title: string;
      assetId: string;
      assetName: string;
      due: DateDueInfo;
      nextDueOn: Date;
    };

/**
 * Current inspection due facts for an organization: the LATEST record
 * per (asset, definition) that carries a nextDueOn. Rows without a due
 * date are facts without a schedule and don't appear; a definition
 * never performed on an asset has no baseline and also doesn't appear.
 */
export async function listDueInspections(
  organizationId: string,
  today: Date,
  windowDays = 30,
): Promise<InspectionDueEntry[]> {
  const records = await prisma.inspectionRecord.findMany({
    where: { organizationId, nextDueOn: { not: null } },
    orderBy: [{ performedOn: "desc" }, { createdAt: "desc" }],
    include: {
      asset: { select: { id: true, name: true } },
      definition: { select: { id: true, name: true } },
    },
  });
  const seen = new Set<string>();
  const entries: InspectionDueEntry[] = [];
  for (const r of records) {
    const key = `${r.assetId}:${r.definitionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      assetId: r.asset.id,
      assetName: r.asset.name,
      definitionId: r.definition.id,
      definitionName: r.definition.name,
      nextDueOn: r.nextDueOn!,
      due: classifyDateDue(r.nextDueOn!, today, windowDays),
    });
  }
  return entries;
}

/**
 * Maintenance due facts. Two factual sources:
 *
 * - ACTIVE plans derive their due follow-up from the latest linked
 *   record + the plan's recurrence (calendar) or the latest meter
 *   reading + interval (meter). A plan with no records reports
 *   neverPerformed — there is no baseline to compute a date from, and
 *   none is invented.
 * - Plan-less records carrying an explicit nextDueOn appear per their
 *   most recent record per asset (a later ad-hoc record supersedes
 *   earlier ad-hoc due notes).
 */
export async function listDueMaintenance(
  organizationId: string,
  today: Date,
  windowDays = 30,
): Promise<MaintenanceDueEntry[]> {
  const plans = await prisma.maintenancePlan.findMany({
    where: { organizationId, status: "ACTIVE" },
    orderBy: { name: "asc" },
    include: {
      asset: { select: { id: true, name: true } },
      meter: { select: { id: true, name: true, unit: true } },
      records: {
        orderBy: [{ performedOn: "desc" }, { createdAt: "desc" }],
        take: 1,
        select: { performedOn: true, meterReading: true, meterId: true },
      },
    },
  });

  const meterIds = [
    ...new Set(plans.map((p) => p.meterId).filter((x): x is string => !!x)),
  ];
  const latestReadings = new Map<string, Prisma.Decimal>();
  for (const meterId of meterIds) {
    const reading = await latestMeterReading(meterId);
    if (reading) latestReadings.set(meterId, reading.reading);
  }

  const entries: MaintenanceDueEntry[] = [];
  for (const plan of plans) {
    const last = plan.records[0] ?? null;
    if (
      plan.intervalType === "CALENDAR_DAYS" ||
      plan.intervalType === "CALENDAR_MONTHS"
    ) {
      const nextDueOn = last
        ? addRecurrence(last.performedOn, plan.intervalType, plan.intervalValue)
        : null;
      entries.push({
        kind: "plan",
        planId: plan.id,
        planName: plan.name,
        assetId: plan.asset.id,
        assetName: plan.asset.name,
        nextDueOn,
        due: nextDueOn ? classifyDateDue(nextDueOn, today, windowDays) : null,
        meter: null,
        meterName: null,
        meterUnit: null,
        neverPerformed: !last,
      });
    } else if (plan.intervalType === "METER_INTERVAL") {
      const baseline =
        last && last.meterId === plan.meterId ? last.meterReading : null;
      const info = classifyMeterDue(
        baseline,
        plan.meterInterval,
        plan.meterId ? (latestReadings.get(plan.meterId) ?? null) : null,
      );
      entries.push({
        kind: "plan",
        planId: plan.id,
        planName: plan.name,
        assetId: plan.asset.id,
        assetName: plan.asset.name,
        nextDueOn: null,
        due: null,
        meter: info,
        meterName: plan.meter?.name ?? null,
        meterUnit: plan.meter?.unit ?? null,
        neverPerformed: !last,
      });
    } else {
      entries.push({
        kind: "plan",
        planId: plan.id,
        planName: plan.name,
        assetId: plan.asset.id,
        assetName: plan.asset.name,
        nextDueOn: null,
        due: null,
        meter: null,
        meterName: null,
        meterUnit: null,
        neverPerformed: !last,
      });
    }
  }

  // Plan-less records: the most recent ad-hoc record per asset that
  // carries an explicit next-due date.
  const adHoc = await prisma.maintenanceRecord.findMany({
    where: { organizationId, planId: null, nextDueOn: { not: null } },
    orderBy: [{ performedOn: "desc" }, { createdAt: "desc" }],
    include: { asset: { select: { id: true, name: true } } },
  });
  const seenAssets = new Set<string>();
  for (const r of adHoc) {
    if (seenAssets.has(r.assetId)) continue;
    seenAssets.add(r.assetId);
    entries.push({
      kind: "ad_hoc",
      recordId: r.id,
      title: r.title,
      assetId: r.asset.id,
      assetName: r.asset.name,
      nextDueOn: r.nextDueOn!,
      due: classifyDateDue(r.nextDueOn!, today, windowDays),
    });
  }
  return entries;
}

/** Org-local "today" for due computations — the owning org's timezone. */
export async function organizationToday(organizationId: string): Promise<Date> {
  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: { timezone: true },
  });
  return calendarDateInZone(org.timezone);
}
