import { prisma } from "@/lib/prisma";
import { calendarDateInZone } from "@/lib/dates";
import { listExpiringQualifications } from "@/lib/domain/qualification";

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
