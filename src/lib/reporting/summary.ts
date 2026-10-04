/**
 * Annual activity summary (issue #19).
 *
 * Factual, descriptive aggregates for one organization-local calendar
 * year. Nothing here scores, ranks, grades, or recommends — counts and
 * sums of recorded facts only. Formulas are documented in
 * docs/reporting.md:
 *
 * - Training participant-minutes = Σ over COMPLETED events of
 *   (durationMinutes × recorded attendance). Events without a recorded
 *   duration contribute their attendance to `recordedAttendances` but
 *   cannot contribute hours — no duration is ever invented.
 * - CANCELLED events are reported separately and never count as
 *   attended.
 * - Incident counts key off `createdAt` (when the record was made),
 *   grouped by administrative status. Timestamps translate through the
 *   organization's timezone: "2026" means the local calendar year.
 * - Expense money is summed in integer minor units per currency and
 *   never combined across currencies — there is no grand total.
 */

import {
  ExpenseStatus,
  IncidentStatus,
  Prisma,
  ReimbursementStatus,
} from "@prisma/client";

import { instantInZone } from "@/lib/dates";
import { prisma } from "@/lib/prisma";

type Tx = Prisma.TransactionClient;
type Db = typeof prisma | Tx;

export interface AnnualSummary {
  year: number;
  timezone: string;
  /**
   * When a unit filter is applied it scopes the TRAINING section only —
   * every other section is organization-wide (incidents, expenses, and
   * most maintenance records have no single unit assignment and are not
   * arbitrarily attributed).
   */
  unitId: string | null;
  unitName: string | null;
  /** True when a unit filter was requested but matched no unit of this org. */
  unitFilterUnmatched: boolean;
  training: {
    completedEvents: number;
    cancelledEvents: number;
    /** Σ durationMinutes over completed events that recorded one. */
    totalEventMinutes: number;
    eventsWithoutDuration: number;
    /** Attendance rows on completed events. */
    recordedAttendances: number;
    /** Σ durationMinutes × attendance over completed events. */
    participantMinutes: number;
  };
  incidents: {
    total: number;
    byStatus: { status: IncidentStatus; count: number }[];
    participantRecords: number;
    assetRecords: number;
  };
  maintenance: {
    maintenanceRecords: number;
    inspectionRecords: number;
    defectsReported: number;
    defectsResolved: number;
    /** Maintenance-record count per asset, alphabetical by name. */
    byAsset: { assetId: string; assetName: string; count: number }[];
  };
  expenses: {
    total: number;
    byStatus: { status: ExpenseStatus; count: number }[];
    byReimbursement: { status: ReimbursementStatus; count: number }[];
    /** Approved expenses only, grouped by currency — never combined. */
    approvedTotalsByCurrency: {
      currency: string;
      count: number;
      amountMinor: number;
    }[];
    /** All expenses in the year, grouped by category + currency. */
    categoryTotalsByCurrency: {
      category: string | null;
      currency: string;
      count: number;
      amountMinor: number;
    }[];
    /** All expenses in the year, grouped by vendor + currency. */
    vendorTotalsByCurrency: {
      vendorId: string | null;
      vendorName: string | null;
      currency: string;
      count: number;
      amountMinor: number;
    }[];
  };
}

/** Training math over a fetched event set — pure and unit-testable. */
export function summarizeTrainingEvents(
  events: {
    durationMinutes: number | null;
    attendanceCount: number;
  }[],
): AnnualSummary["training"] & { cancelledEvents: number } {
  let completedEvents = 0;
  let totalEventMinutes = 0;
  let eventsWithoutDuration = 0;
  let recordedAttendances = 0;
  let participantMinutes = 0;
  for (const e of events) {
    completedEvents += 1;
    recordedAttendances += e.attendanceCount;
    if (e.durationMinutes === null) {
      eventsWithoutDuration += 1;
    } else {
      totalEventMinutes += e.durationMinutes;
      participantMinutes += e.durationMinutes * e.attendanceCount;
    }
  }
  return {
    completedEvents,
    cancelledEvents: 0,
    totalEventMinutes,
    eventsWithoutDuration,
    recordedAttendances,
    participantMinutes,
  };
}

/** Exact "X.Y hours" label for display — minutes stay canonical. */
export function participantHoursLabel(minutes: number): string {
  const hours = Math.round((minutes / 60) * 100) / 100;
  return `${hours}`;
}

export async function getAnnualSummary(
  organizationId: string,
  year: number,
  unitId?: string | null,
  db: Db = prisma,
): Promise<AnnualSummary | null> {
  const organization = await db.organization.findUnique({
    where: { id: organizationId },
    select: { timezone: true, units: { select: { id: true, name: true } } },
  });
  if (!organization) return null;
  const timezone = organization.timezone;

  // Unit filter: only a real unit of this organization is meaningful.
  // A foreign/fabricated id is treated as "matches nothing" rather than
  // widening to org-wide — same convention as every other filter.
  const unit = unitId
    ? (organization.units.find((u) => u.id === unitId) ?? null)
    : null;
  const effectiveUnitId = unitId ? (unit?.id ?? "__none__") : undefined;

  // Local-calendar-year bounds: [Jan 1, Dec 31] for @db.Date columns,
  // instant bounds through the org timezone for timestamp columns.
  const dateStart = new Date(Date.UTC(year, 0, 1));
  const dateEnd = new Date(Date.UTC(year, 11, 31));
  const instantStart =
    instantInZone(timezone, `${year}-01-01T00:00`) ??
    new Date(Date.UTC(year, 0, 1));
  const instantEnd =
    instantInZone(timezone, `${year + 1}-01-01T00:00`) ??
    new Date(Date.UTC(year + 1, 0, 1));
  const instantRange = { gte: instantStart, lt: instantEnd };

  const unitClause =
    effectiveUnitId === undefined ? {} : { unitId: effectiveUnitId };

  const completedEvents = await db.trainingEvent.findMany({
    where: {
      organizationId,
      status: "COMPLETED",
      date: { gte: dateStart, lte: dateEnd },
      ...unitClause,
    },
    select: {
      durationMinutes: true,
      _count: { select: { attendances: true } },
    },
  });
  const cancelledEvents = await db.trainingEvent.count({
    where: {
      organizationId,
      status: "CANCELLED",
      date: { gte: dateStart, lte: dateEnd },
      ...unitClause,
    },
  });
  const training = {
    ...summarizeTrainingEvents(
      completedEvents.map((e) => ({
        durationMinutes: e.durationMinutes,
        attendanceCount: e._count.attendances,
      })),
    ),
    cancelledEvents,
  };

  const incidentWhere = {
    organizationId,
    createdAt: instantRange,
  };
  const [incidentStatus, participantRecords, assetRecords] = await Promise.all([
    db.incident.groupBy({
      by: ["status"],
      where: incidentWhere,
      _count: { _all: true },
    }),
    db.incidentMember.count({
      where: { incident: incidentWhere },
    }),
    db.incidentAsset.count({
      where: { incident: incidentWhere },
    }),
  ]);
  const incidents = {
    total: incidentStatus.reduce((n, s) => n + s._count._all, 0),
    byStatus: incidentStatus
      .map((s) => ({ status: s.status, count: s._count._all }))
      .sort((a, b) => a.status.localeCompare(b.status)),
    participantRecords,
    assetRecords,
  };

  const [
    maintenanceRecords,
    inspectionRecords,
    defectsReported,
    defectsResolved,
    maintByAsset,
  ] = await Promise.all([
    db.maintenanceRecord.count({
      where: {
        organizationId,
        performedOn: { gte: dateStart, lte: dateEnd },
      },
    }),
    db.inspectionRecord.count({
      where: {
        organizationId,
        performedOn: { gte: dateStart, lte: dateEnd },
      },
    }),
    db.defect.count({
      where: {
        organizationId,
        reportedOn: { gte: dateStart, lte: dateEnd },
      },
    }),
    db.defect.count({
      where: {
        organizationId,
        resolvedOn: { gte: dateStart, lte: dateEnd },
      },
    }),
    db.maintenanceRecord.groupBy({
      by: ["assetId"],
      where: {
        organizationId,
        performedOn: { gte: dateStart, lte: dateEnd },
      },
      _count: { _all: true },
    }),
  ]);
  const maintAssets = await db.asset.findMany({
    where: {
      organizationId,
      id: { in: maintByAsset.map((r) => r.assetId) },
    },
    select: { id: true, name: true },
  });
  const assetName = new Map(maintAssets.map((a) => [a.id, a.name]));
  const maintenance = {
    maintenanceRecords,
    inspectionRecords,
    defectsReported,
    defectsResolved,
    byAsset: maintByAsset
      .map((r) => ({
        assetId: r.assetId,
        assetName: assetName.get(r.assetId) ?? r.assetId,
        count: r._count._all,
      }))
      .sort((a, b) => a.assetName.localeCompare(b.assetName)),
  };

  const expenseWhere = {
    organizationId,
    expenseDate: { gte: dateStart, lte: dateEnd },
  };
  const [byStatus, byReimb, byStatusCurrency, byCategory, byVendor] =
    await Promise.all([
      db.expense.groupBy({
        by: ["status"],
        where: expenseWhere,
        _count: { _all: true },
      }),
      db.expense.groupBy({
        by: ["reimbursementStatus"],
        where: expenseWhere,
        _count: { _all: true },
      }),
      db.expense.groupBy({
        by: ["status", "currency"],
        where: expenseWhere,
        _count: { _all: true },
        _sum: { amountMinor: true },
      }),
      db.expense.groupBy({
        by: ["category", "currency"],
        where: expenseWhere,
        _count: { _all: true },
        _sum: { amountMinor: true },
      }),
      db.expense.groupBy({
        by: ["vendorId", "currency"],
        where: expenseWhere,
        _count: { _all: true },
        _sum: { amountMinor: true },
      }),
    ]);
  const vendorNames = await db.vendor.findMany({
    where: {
      organizationId,
      id: {
        in: byVendor
          .map((r) => r.vendorId)
          .filter((v): v is string => v !== null),
      },
    },
    select: { id: true, name: true },
  });
  const vendorName = new Map(vendorNames.map((v) => [v.id, v.name]));

  const expenses = {
    total: byStatus.reduce((n, s) => n + s._count._all, 0),
    byStatus: byStatus
      .map((s) => ({ status: s.status, count: s._count._all }))
      .sort((a, b) => a.status.localeCompare(b.status)),
    byReimbursement: byReimb
      .map((s) => ({ status: s.reimbursementStatus, count: s._count._all }))
      .sort((a, b) => a.status.localeCompare(b.status)),
    approvedTotalsByCurrency: byStatusCurrency
      .filter((r) => r.status === "APPROVED")
      .map((r) => ({
        currency: r.currency,
        count: r._count._all,
        amountMinor: r._sum.amountMinor ?? 0,
      }))
      .sort((a, b) => a.currency.localeCompare(b.currency)),
    categoryTotalsByCurrency: byCategory
      .map((r) => ({
        category: r.category,
        currency: r.currency,
        count: r._count._all,
        amountMinor: r._sum.amountMinor ?? 0,
      }))
      .sort(
        (a, b) =>
          (a.category ?? "").localeCompare(b.category ?? "") ||
          a.currency.localeCompare(b.currency),
      ),
    vendorTotalsByCurrency: byVendor
      .map((r) => ({
        vendorId: r.vendorId,
        vendorName: r.vendorId ? (vendorName.get(r.vendorId) ?? null) : null,
        currency: r.currency,
        count: r._count._all,
        amountMinor: r._sum.amountMinor ?? 0,
      }))
      .sort(
        (a, b) =>
          (a.vendorName ?? "").localeCompare(b.vendorName ?? "") ||
          a.currency.localeCompare(b.currency),
      ),
  };

  return {
    year,
    timezone,
    unitId: unit?.id ?? null,
    unitName: unit?.name ?? null,
    unitFilterUnmatched: Boolean(unitId && !unit),
    training: {
      completedEvents: training.completedEvents,
      cancelledEvents: training.cancelledEvents,
      totalEventMinutes: training.totalEventMinutes,
      eventsWithoutDuration: training.eventsWithoutDuration,
      recordedAttendances: training.recordedAttendances,
      participantMinutes: training.participantMinutes,
    },
    incidents,
    maintenance,
    expenses,
  };
}
