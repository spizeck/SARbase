import { OrgCapability } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { calendarDateInZone } from "@/lib/dates";
import { listExpiringQualifications } from "@/lib/domain/qualification";
import { listOrganizationAvailability } from "@/lib/domain/availability";
import {
  listDueInspections,
  listDueMaintenance,
} from "@/lib/domain/maintenance";

/**
 * Data for the shared organization dashboard. Every query is scoped by
 * organizationId taken from the verified URL/params after an access
 * check — the dashboard never widens scope; admin and member variants
 * are assembled by separate functions so a member page can never
 * receive admin data even by accident.
 */

export interface AdminDashboardData {
  counts: {
    members: number;
    units: number;
    assets: number;
    storageLocations: number;
    inventoryItems: number;
    qualificationDefinitions: number;
  };
  recentCallouts: {
    id: string;
    title: string;
    status: string;
    activatedAt: Date;
    closedAt: Date | null;
  }[];
  recentIncidents: {
    id: string;
    reference: string;
    title: string;
    status: string;
    reportedAt: Date | null;
  }[];
  upcomingTraining: {
    id: string;
    title: string;
    date: Date;
    status: string;
    unit: { id: string; name: string } | null;
    attendeeCount: number;
  }[];
  expiringQualifications: Awaited<
    ReturnType<typeof listExpiringQualifications>
  >;
}

export async function getAdminDashboard(
  organizationId: string,
  timezone: string,
): Promise<AdminDashboardData> {
  // TrainingEvent.date is a @db.Date calendar day; "upcoming" means the
  // organization's local today onward, matching listExpiringQualifications.
  const orgToday = calendarDateInZone(timezone);
  const [
    members,
    units,
    assets,
    storageLocations,
    inventoryItems,
    qualificationDefinitions,
    recentCallouts,
    recentIncidents,
    upcomingTraining,
    expiringQualifications,
  ] = await Promise.all([
    prisma.member.count({ where: { organizationId } }),
    prisma.unit.count({ where: { organizationId } }),
    prisma.asset.count({ where: { organizationId } }),
    prisma.storageLocation.count({ where: { organizationId } }),
    prisma.inventoryItem.count({ where: { organizationId } }),
    prisma.qualificationDefinition.count({ where: { organizationId } }),
    prisma.callout.findMany({
      where: { organizationId },
      orderBy: [{ activatedAt: "desc" }, { id: "desc" }],
      take: 5,
      select: {
        id: true,
        title: true,
        status: true,
        activatedAt: true,
        closedAt: true,
      },
    }),
    prisma.incident.findMany({
      where: { organizationId },
      orderBy: [
        { reportedAt: { sort: "desc", nulls: "last" } },
        { createdAt: "desc" },
        { id: "desc" },
      ],
      take: 5,
      select: {
        id: true,
        reference: true,
        title: true,
        status: true,
        reportedAt: true,
      },
    }),
    prisma.trainingEvent.findMany({
      where: {
        organizationId,
        // No SCHEDULED status exists — events are recorded COMPLETED by
        // default; "upcoming" means dated today or later, not cancelled.
        status: { not: "CANCELLED" },
        date: { gte: orgToday },
      },
      orderBy: [{ date: "asc" }, { id: "asc" }],
      take: 5,
      select: {
        id: true,
        title: true,
        date: true,
        status: true,
        unit: { select: { id: true, name: true } },
        _count: { select: { attendances: true } },
      },
    }),
    listExpiringQualifications(organizationId, { withinDays: 30 }),
  ]);

  return {
    counts: {
      members,
      units,
      assets,
      storageLocations,
      inventoryItems,
      qualificationDefinitions,
    },
    recentCallouts,
    recentIncidents,
    upcomingTraining: upcomingTraining.map((event) => ({
      id: event.id,
      title: event.title,
      date: event.date,
      status: event.status,
      unit: event.unit,
      attendeeCount: event._count.attendances,
    })),
    expiringQualifications,
  };
}

/* ------------------------------------------------------------------ */
/* Attention sections — "what needs a human's eyes right now"          */
/* ------------------------------------------------------------------ */

export interface DashboardAttention {
  /**
   * Stated-availability rollup for people/ops managers. UNKNOWN is
   * split honestly: never recorded vs a statement that has expired —
   * an elapsed `until` is not a current declaration.
   */
  availability?: {
    totalActive: number;
    available: number;
    unavailable: number;
    offIsland: number;
    unknownNoStatement: number;
    unknownExpired: number;
  };
  /** Active callouts with their raw response tallies. */
  activeCallouts?: {
    id: string;
    title: string;
    activatedAt: Date;
    counts: {
      total: number;
      coming: number;
      unavailable: number;
      noResponse: number;
    };
  }[];
  /** Notifications that FAILED in the last 14 days — a factual window. */
  failedNotifications?: number;
  /** Equipment attention facts for equipment managers. */
  equipment?: {
    openDefects: number;
    overdueInspections: number;
    dueSoonInspections: number;
    dueMaintenance: number;
  };
  /** Pending member submissions awaiting review (verify grant only). */
  pendingSubmissions?: number;
  /** Pending member invitations (org admin only). */
  pendingInvitations?: number;
}

const FAILED_NOTIFICATION_WINDOW_DAYS = 14;

/**
 * Attention items, queried only for capabilities the caller actually
 * holds — an ops-only manager never triggers a submissions query, and
 * the caller's capability list is the server-resolved one from the
 * session context, not anything client-supplied.
 *
 * Everything returned is a recorded fact or an honest absence — no
 * aggregation here ever answers "is the crew ready".
 */
export async function getDashboardAttention(
  organizationId: string,
  capabilities: OrgCapability[],
  isAdmin: boolean,
  orgToday: Date,
): Promise<DashboardAttention> {
  const can = (cap: OrgCapability) => capabilities.includes(cap);
  const canSeeAvailability =
    can(OrgCapability.MEMBERS_MANAGE) || can(OrgCapability.OPERATIONS_MANAGE);
  const canSeeFailedNotifications =
    can(OrgCapability.NOTIFICATIONS_MANAGE) ||
    can(OrgCapability.OPERATIONS_MANAGE);

  const [
    availabilityRows,
    activeMemberCount,
    activeCallouts,
    failedNotifications,
    equipment,
    pendingSubmissions,
    pendingInvitations,
  ] = await Promise.all([
    canSeeAvailability
      ? listOrganizationAvailability(organizationId, orgToday)
      : null,
    canSeeAvailability
      ? prisma.member.count({
          where: { organizationId, status: "ACTIVE" },
        })
      : null,
    can(OrgCapability.OPERATIONS_MANAGE)
      ? prisma.callout.findMany({
          where: { organizationId, status: "ACTIVE" },
          orderBy: [{ activatedAt: "desc" }, { id: "desc" }],
          select: {
            id: true,
            title: true,
            activatedAt: true,
            invitations: { select: { response: true } },
          },
        })
      : null,
    canSeeFailedNotifications
      ? prisma.notification.count({
          where: {
            organizationId,
            status: "FAILED",
            createdAt: {
              gte: new Date(
                Date.now() -
                  FAILED_NOTIFICATION_WINDOW_DAYS * 24 * 60 * 60 * 1000,
              ),
            },
          },
        })
      : null,
    can(OrgCapability.EQUIPMENT_MANAGE)
      ? Promise.all([
          prisma.defect.count({ where: { organizationId, status: "OPEN" } }),
          listDueInspections(organizationId, orgToday),
          listDueMaintenance(organizationId, orgToday),
        ])
      : null,
    can(OrgCapability.QUALIFICATIONS_VERIFY)
      ? prisma.memberSubmission.count({
          where: { organizationId, status: "PENDING" },
        })
      : null,
    isAdmin
      ? prisma.memberInvitation.count({
          where: { organizationId, status: "PENDING" },
        })
      : null,
  ]);

  const attention: DashboardAttention = {};

  if (availabilityRows && activeMemberCount != null) {
    let available = 0;
    let unavailable = 0;
    let offIsland = 0;
    let unknownExpired = 0;
    for (const current of availabilityRows.values()) {
      if (current.status === "AVAILABLE") available += 1;
      else if (current.status === "UNAVAILABLE") unavailable += 1;
      else if (current.status === "OFF_ISLAND") offIsland += 1;
      else if (current.expired) unknownExpired += 1;
    }
    attention.availability = {
      totalActive: activeMemberCount,
      available,
      unavailable,
      offIsland,
      unknownNoStatement: activeMemberCount - availabilityRows.size,
      unknownExpired,
    };
  }

  if (activeCallouts) {
    attention.activeCallouts = activeCallouts.map((callout) => {
      const coming = callout.invitations.filter(
        (i) => i.response === "COMING",
      ).length;
      const unavailable = callout.invitations.filter(
        (i) => i.response === "UNAVAILABLE",
      ).length;
      return {
        id: callout.id,
        title: callout.title,
        activatedAt: callout.activatedAt,
        counts: {
          total: callout.invitations.length,
          coming,
          unavailable,
          noResponse: callout.invitations.length - coming - unavailable,
        },
      };
    });
  }

  if (failedNotifications != null) {
    attention.failedNotifications = failedNotifications;
  }

  if (equipment) {
    const [openDefects, dueInspections, dueMaintenance] = equipment;
    attention.equipment = {
      openDefects,
      overdueInspections: dueInspections.filter(
        (e) => e.due.state === "overdue",
      ).length,
      dueSoonInspections: dueInspections.filter(
        (e) => e.due.state === "due_today" || e.due.state === "due_soon",
      ).length,
      dueMaintenance: dueMaintenance.filter(
        (e) =>
          (e.due &&
            (e.due.state === "overdue" ||
              e.due.state === "due_today" ||
              e.due.state === "due_soon")) ||
          (e.kind === "plan" && e.meter?.state === "threshold_reached"),
      ).length,
    };
  }

  if (pendingSubmissions != null) {
    attention.pendingSubmissions = pendingSubmissions;
  }
  if (pendingInvitations != null) {
    attention.pendingInvitations = pendingInvitations;
  }

  return attention;
}
