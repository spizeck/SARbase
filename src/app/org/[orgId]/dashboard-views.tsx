import Link from "next/link";
import type { OrgCapability } from "@prisma/client";

import { SetupChecklist } from "@/app/admin/setup-checklist";
import { setSetupChecklistDismissedAction } from "@/app/admin/actions";
import {
  getAdminDashboard,
  getDashboardAttention,
} from "@/lib/domain/dashboard";
import { getOrganizationSetup } from "@/lib/domain/setup";
import { getMemberAvailability } from "@/lib/domain/availability";
import { listMemberCalloutInvitations } from "@/lib/domain/callouts";
import { listMemberTraining } from "@/lib/domain/training";
import { listOwnMemberSubmissions } from "@/lib/domain/submissions";
import {
  expiryLabel,
  listMemberQualifications,
} from "@/lib/domain/qualification";
import { formatDateOnly, formatInstantInZone } from "@/lib/dates";

/**
 * Presentational dashboard views, separated from the page so the real
 * components can be rendered in the (local-only, uncommitted) preview
 * harness for visual verification.
 */

const STATUS_LABELS: Record<string, string> = {
  ACTIVE: "Active",
  CLOSED: "Closed",
  DRAFT: "Draft",
  OPEN: "Open",
  RESOLVED: "Resolved",
  SCHEDULED: "Scheduled",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  AVAILABLE: "Available",
  UNAVAILABLE: "Unavailable",
  PARTIAL: "Partial",
  UNKNOWN: "Not recorded",
};

function label(status: string) {
  return STATUS_LABELS[status] ?? status.toLowerCase().replace(/_/g, " ");
}

function StatCard({
  href,
  count,
  name,
}: {
  href: string;
  count: number;
  name: string;
}) {
  return (
    <Link
      href={href}
      className="rounded-lg border border-neutral-200 px-4 py-3 hover:border-neutral-300 hover:bg-neutral-50 focus:outline-none focus:ring-2 focus:ring-neutral-900 focus:ring-offset-2"
    >
      <span className="block text-2xl font-semibold text-neutral-900">
        {count}
      </span>
      <span className="mt-0.5 block text-sm text-neutral-600">{name}</span>
    </Link>
  );
}

function SectionList({
  id,
  title,
  viewAllHref,
  empty,
  children,
}: {
  id: string;
  title: string;
  viewAllHref: string;
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className="rounded-lg border border-neutral-200"
    >
      <div className="flex items-baseline justify-between gap-3 border-b border-neutral-200 px-4 py-2.5">
        <h2 id={id} className="text-sm font-semibold text-neutral-900">
          {title}
        </h2>
        <Link
          href={viewAllHref}
          className="text-xs font-medium text-neutral-500 hover:text-neutral-900 hover:underline"
        >
          View all
        </Link>
      </div>
      {children || (
        <p className="px-4 py-3 text-sm text-neutral-500">{empty}</p>
      )}
    </section>
  );
}

const WORKSPACES: {
  name: string;
  description: string;
  /** Destinations in preference order — the card links the first one
   *  the caller can actually open. */
  destinations: { capability: OrgCapability; path: string }[];
}[] = [
  {
    name: "Operations",
    description: "Callouts, incidents, and training events.",
    destinations: [
      { capability: "OPERATIONS_MANAGE", path: "/callouts" },
      { capability: "TRAINING_MANAGE", path: "/training" },
    ],
  },
  {
    name: "People",
    description: "Member records, units, and qualifications.",
    destinations: [
      { capability: "MEMBERS_MANAGE", path: "/members" },
      { capability: "QUALIFICATIONS_MANAGE", path: "/qualifications" },
    ],
  },
  {
    name: "Equipment",
    description: "Assets, inventory, locations, and maintenance.",
    destinations: [{ capability: "EQUIPMENT_MANAGE", path: "/assets" }],
  },
  {
    name: "Reporting",
    description: "Data exports and annual activity summaries.",
    destinations: [{ capability: "REPORTS_EXPORT", path: "/reports" }],
  },
];

/**
 * Staff dashboard — capability-filtered: an ADMIN sees everything,
 * a MANAGER sees only the sections their grants cover. Visibility is
 * UX only; every destination page enforces the same requirement.
 */
export async function AdminDashboard({
  orgId,
  adminRoot,
  timezone,
  orgToday,
  capabilities,
  isAdmin,
}: {
  orgId: string;
  adminRoot: string;
  timezone: string;
  orgToday: Date;
  capabilities: OrgCapability[];
  isAdmin: boolean;
}) {
  const [data, setup, attention] = await Promise.all([
    getAdminDashboard(orgId, timezone),
    isAdmin ? getOrganizationSetup(orgId) : null,
    getDashboardAttention(orgId, capabilities, isAdmin, orgToday),
  ]);
  const { counts } = data;
  const can = (cap: OrgCapability) => capabilities.includes(cap);
  const workspaces = WORKSPACES.map((w) => ({
    name: w.name,
    description: w.description,
    href: w.destinations.find((d) => can(d.capability))?.path,
  })).filter((w): w is typeof w & { href: string } => Boolean(w.href));
  // Member record pages are their own capability — dashboard links to
  // them must degrade to text for callers without MEMBERS_MANAGE.
  const canViewMembers = can("MEMBERS_MANAGE");
  const stats = [
    {
      href: `${adminRoot}/members`,
      count: counts.members,
      name: "Members",
      cap: "MEMBERS_MANAGE" as OrgCapability,
    },
    {
      href: `${adminRoot}/units`,
      count: counts.units,
      name: "Units",
      cap: "MEMBERS_MANAGE" as OrgCapability,
    },
    {
      href: `${adminRoot}/assets`,
      count: counts.assets,
      name: "Assets",
      cap: "EQUIPMENT_MANAGE" as OrgCapability,
    },
    {
      href: `${adminRoot}/inventory`,
      count: counts.inventoryItems,
      name: "Inventory items",
      cap: "EQUIPMENT_MANAGE" as OrgCapability,
    },
    {
      href: `${adminRoot}/locations`,
      count: counts.storageLocations,
      name: "Storage locations",
      cap: "EQUIPMENT_MANAGE" as OrgCapability,
    },
    {
      href: `${adminRoot}/qualifications`,
      count: counts.qualificationDefinitions,
      name: "Qualification definitions",
      cap: "QUALIFICATIONS_MANAGE" as OrgCapability,
    },
  ].filter((s) => can(s.cap));

  return (
    <>
      {isAdmin && setup && (
        <SetupChecklist
          setup={setup}
          dismissAction={setSetupChecklistDismissedAction.bind(
            null,
            orgId,
            true,
          )}
          restoreAction={setSetupChecklistDismissedAction.bind(
            null,
            orgId,
            false,
          )}
        />
      )}

      {stats.length > 0 && (
        <section aria-labelledby="overview-heading" className="mt-6">
          <h2 id="overview-heading" className="sr-only">
            Organization overview
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {stats.map((s) => (
              <StatCard
                key={s.href}
                href={s.href}
                count={s.count}
                name={s.name}
              />
            ))}
          </div>
        </section>
      )}

      {attention.availability && (
        <section
          aria-labelledby="availability-heading"
          className="mt-6 rounded-lg border border-neutral-200 px-4 py-3"
        >
          <div className="flex items-baseline justify-between gap-3">
            <h2
              id="availability-heading"
              className="text-sm font-semibold text-neutral-900"
            >
              Stated availability now
            </h2>
            {canViewMembers && (
              <Link
                href={`${adminRoot}/members`}
                className="text-xs font-medium text-neutral-500 hover:text-neutral-900 hover:underline"
              >
                Members
              </Link>
            )}
          </div>
          <p className="mt-2 text-sm text-neutral-700">
            <span className="font-medium text-green-800">
              {attention.availability.available} available
            </span>
            {" · "}
            {attention.availability.unavailable +
              attention.availability.offIsland >
            0 ? (
              <span className="font-medium text-amber-800">
                {attention.availability.unavailable +
                  attention.availability.offIsland}{" "}
                unavailable
                {attention.availability.offIsland > 0 &&
                  ` (${attention.availability.offIsland} off island)`}
              </span>
            ) : (
              <span>0 unavailable</span>
            )}
            {" · "}
            <span className="font-medium text-neutral-600">
              {attention.availability.unknownNoStatement +
                attention.availability.unknownExpired}{" "}
              unknown
            </span>
          </p>
          <p className="mt-1 text-xs text-neutral-500">
            Of {attention.availability.totalActive} active members. Unknown
            means no current statement
            {attention.availability.unknownExpired > 0 &&
              ` — ${attention.availability.unknownExpired} statement${
                attention.availability.unknownExpired === 1 ? " has" : "s have"
              } expired`}
            . Members&apos; stated availability is not a qualification,
            competence, or readiness assessment.
          </p>
        </section>
      )}

      {(attention.activeCallouts !== undefined ||
        attention.failedNotifications !== undefined ||
        attention.equipment !== undefined ||
        attention.pendingSubmissions !== undefined ||
        attention.pendingInvitations !== undefined) && (
        <section aria-labelledby="attention-heading" className="mt-6">
          <h2
            id="attention-heading"
            className="text-sm font-semibold text-neutral-900"
          >
            Needs attention
          </h2>
          <ul className="mt-3 space-y-2">
            {attention.activeCallouts?.map((callout) => (
              <li
                key={callout.id}
                className="rounded-lg border border-neutral-200 px-4 py-3"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <Link
                    href={`${adminRoot}/callouts/${callout.id}`}
                    className="min-w-0 truncate text-sm font-medium text-neutral-900 hover:underline"
                  >
                    {callout.title}
                  </Link>
                  <span className="shrink-0 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">
                    Active
                  </span>
                </div>
                <p className="mt-1 text-xs text-neutral-600">
                  Activated {formatInstantInZone(callout.activatedAt, timezone)}{" "}
                  · {callout.counts.total} invited · {callout.counts.coming}{" "}
                  coming · {callout.counts.unavailable} unavailable
                  {callout.counts.noResponse > 0 && (
                    <span className="font-medium text-amber-800">
                      {" "}
                      · {callout.counts.noResponse} no response
                    </span>
                  )}
                </p>
              </li>
            ))}

            {attention.failedNotifications !== undefined &&
              attention.failedNotifications > 0 && (
                <li className="rounded-lg border border-neutral-200 px-4 py-3">
                  {can("NOTIFICATIONS_MANAGE") ? (
                    <Link
                      href={`${adminRoot}/notifications`}
                      className="text-sm font-medium text-red-800 hover:underline"
                    >
                      {attention.failedNotifications} notification
                      {attention.failedNotifications === 1 ? "" : "s"} failed in
                      the last 14 days
                    </Link>
                  ) : (
                    <span className="text-sm font-medium text-red-800">
                      {attention.failedNotifications} notification
                      {attention.failedNotifications === 1 ? "" : "s"} failed in
                      the last 14 days
                    </span>
                  )}
                  <p className="mt-1 text-xs text-neutral-500">
                    Delivery failure is a provider-reported fact — members may
                    not have received these alerts.
                  </p>
                </li>
              )}

            {attention.equipment &&
              (attention.equipment.openDefects > 0 ||
                attention.equipment.overdueInspections > 0 ||
                attention.equipment.dueSoonInspections > 0 ||
                attention.equipment.dueMaintenance > 0) && (
                <li className="rounded-lg border border-neutral-200 px-4 py-3">
                  <Link
                    href={`${adminRoot}/maintenance`}
                    className="text-sm font-medium text-neutral-900 hover:underline"
                  >
                    Equipment
                  </Link>
                  <p className="mt-1 text-xs text-neutral-600">
                    {[
                      attention.equipment.openDefects > 0 &&
                        `${attention.equipment.openDefects} open defect${
                          attention.equipment.openDefects === 1 ? "" : "s"
                        }`,
                      attention.equipment.overdueInspections > 0 &&
                        `${attention.equipment.overdueInspections} overdue inspection${
                          attention.equipment.overdueInspections === 1
                            ? ""
                            : "s"
                        }`,
                      attention.equipment.dueSoonInspections > 0 &&
                        `${attention.equipment.dueSoonInspections} inspection${
                          attention.equipment.dueSoonInspections === 1
                            ? ""
                            : "s"
                        } due soon`,
                      attention.equipment.dueMaintenance > 0 &&
                        `${attention.equipment.dueMaintenance} maintenance item${
                          attention.equipment.dueMaintenance === 1 ? "" : "s"
                        } due`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </li>
              )}

            {attention.pendingSubmissions !== undefined &&
              attention.pendingSubmissions > 0 && (
                <li className="rounded-lg border border-neutral-200 px-4 py-3">
                  <Link
                    href={`${adminRoot}/reviews`}
                    className="text-sm font-medium text-neutral-900 hover:underline"
                  >
                    {attention.pendingSubmissions} member submission
                    {attention.pendingSubmissions === 1 ? "" : "s"} awaiting
                    review
                  </Link>
                </li>
              )}

            {attention.pendingInvitations !== undefined &&
              attention.pendingInvitations > 0 && (
                <li className="rounded-lg border border-neutral-200 px-4 py-3">
                  <Link
                    href={`${adminRoot}/access`}
                    className="text-sm font-medium text-neutral-900 hover:underline"
                  >
                    {attention.pendingInvitations} member invitation
                    {attention.pendingInvitations === 1 ? "" : "s"} pending
                  </Link>
                </li>
              )}
          </ul>
          {(!attention.activeCallouts ||
            attention.activeCallouts.length === 0) &&
            !attention.failedNotifications &&
            !attention.pendingSubmissions &&
            !attention.pendingInvitations &&
            (!attention.equipment ||
              (attention.equipment.openDefects === 0 &&
                attention.equipment.overdueInspections === 0 &&
                attention.equipment.dueSoonInspections === 0 &&
                attention.equipment.dueMaintenance === 0)) && (
              <p className="mt-3 text-sm text-neutral-500">
                No outstanding items recorded.
              </p>
            )}
        </section>
      )}

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        {can("OPERATIONS_MANAGE") && (
          <SectionList
            id="dash-callouts"
            title="Recent callouts"
            viewAllHref={`${adminRoot}/callouts`}
            empty="No callouts recorded."
          >
            {data.recentCallouts.length > 0 && (
              <ul className="divide-y divide-neutral-100">
                {data.recentCallouts.map((c) => (
                  <li key={c.id}>
                    <Link
                      href={`${adminRoot}/callouts/${c.id}`}
                      className="flex items-baseline justify-between gap-3 px-4 py-2.5 hover:bg-neutral-50"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-neutral-900">
                          {c.title}
                        </span>
                        <span className="text-xs text-neutral-500">
                          {formatInstantInZone(c.activatedAt, timezone)}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs text-neutral-500">
                        {label(c.status)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </SectionList>
        )}

        {can("OPERATIONS_MANAGE") && (
          <SectionList
            id="dash-incidents"
            title="Recent incidents"
            viewAllHref={`${adminRoot}/incidents`}
            empty="No incidents recorded."
          >
            {data.recentIncidents.length > 0 && (
              <ul className="divide-y divide-neutral-100">
                {data.recentIncidents.map((i) => (
                  <li key={i.id}>
                    <Link
                      href={`${adminRoot}/incidents/${i.id}`}
                      className="flex items-baseline justify-between gap-3 px-4 py-2.5 hover:bg-neutral-50"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-neutral-900">
                          {i.reference} — {i.title}
                        </span>
                        <span className="text-xs text-neutral-500">
                          {i.reportedAt
                            ? formatInstantInZone(i.reportedAt, timezone)
                            : "No report time recorded"}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs text-neutral-500">
                        {label(i.status)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </SectionList>
        )}

        {can("TRAINING_MANAGE") && (
          <SectionList
            id="dash-training"
            title="Upcoming training events"
            viewAllHref={`${adminRoot}/training`}
            empty="No scheduled training events."
          >
            {data.upcomingTraining.length > 0 && (
              <ul className="divide-y divide-neutral-100">
                {data.upcomingTraining.map((e) => (
                  <li key={e.id}>
                    <Link
                      href={`${adminRoot}/training/${e.id}`}
                      className="flex items-baseline justify-between gap-3 px-4 py-2.5 hover:bg-neutral-50"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-neutral-900">
                          {e.title}
                        </span>
                        <span className="text-xs text-neutral-500">
                          {formatDateOnly(e.date)}
                          {e.unit ? ` · ${e.unit.name}` : ""}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs text-neutral-500">
                        {e.attendeeCount} recorded
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </SectionList>
        )}

        {can("QUALIFICATIONS_MANAGE") && (
          <SectionList
            id="dash-expiring"
            title="Certifications expiring within 30 days"
            viewAllHref={`${adminRoot}/expiring`}
            empty="No tracked certifications expire within 30 days."
          >
            {data.expiringQualifications.length > 0 && (
              <ul className="divide-y divide-neutral-100">
                {data.expiringQualifications.slice(0, 5).map((q) => (
                  <li key={q.id}>
                    {canViewMembers ? (
                      <Link
                        href={`${adminRoot}/members/${q.member.id}`}
                        className="flex items-baseline justify-between gap-3 px-4 py-2.5 hover:bg-neutral-50"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-neutral-900">
                            {q.member.displayName}
                          </span>
                          <span className="text-xs text-neutral-500">
                            {q.definition.name}
                          </span>
                        </span>
                        <span className="shrink-0 text-xs text-neutral-500">
                          {expiryLabel(q.expiresOn, orgToday)}
                        </span>
                      </Link>
                    ) : (
                      <span className="flex items-baseline justify-between gap-3 px-4 py-2.5">
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-neutral-900">
                            {q.member.displayName}
                          </span>
                          <span className="text-xs text-neutral-500">
                            {q.definition.name}
                          </span>
                        </span>
                        <span className="shrink-0 text-xs text-neutral-500">
                          {expiryLabel(q.expiresOn, orgToday)}
                        </span>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </SectionList>
        )}
      </div>

      {workspaces.length > 0 ? (
        <section aria-labelledby="workspaces-heading" className="mt-8">
          <h2
            id="workspaces-heading"
            className="text-sm font-semibold text-neutral-900"
          >
            Manage
          </h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {workspaces.map((w) => (
              <Link
                key={w.name}
                href={`${adminRoot}${w.href}`}
                className="rounded-lg border border-neutral-200 px-4 py-3 hover:border-neutral-300 hover:bg-neutral-50 focus:outline-none focus:ring-2 focus:ring-neutral-900 focus:ring-offset-2"
              >
                <span className="block text-sm font-medium text-neutral-900">
                  {w.name}
                </span>
                <span className="mt-1 block text-xs text-neutral-500">
                  {w.description}
                </span>
              </Link>
            ))}
          </div>
        </section>
      ) : (
        <section className="mt-8 rounded-lg border border-neutral-200 p-5">
          <p className="text-sm text-neutral-600">
            {isAdmin
              ? "This organization has no staff workspaces yet."
              : "You are a manager with no assigned permissions yet — an administrator can grant them on the Access & roles page. Until then, your member self-service lives on your account page."}
          </p>
          <p className="mt-3 text-sm">
            <Link
              href="/account"
              className="font-medium text-neutral-900 underline underline-offset-2 hover:text-neutral-600"
            >
              Go to your account
            </Link>
          </p>
        </section>
      )}
    </>
  );
}

/**
 * The member variant shows only the member's own server-resolved
 * record — their availability statement, active callout invitations,
 * their qualification expiries and recorded training. No org-wide data
 * is fetched for members at all.
 */
export async function MemberDashboard({
  member,
  timezone,
  orgToday,
}: {
  member: { id: string; displayName: string; status: string } | undefined;
  timezone: string;
  orgToday: Date;
}) {
  if (!member) {
    return (
      <div className="mt-6 rounded-lg border border-neutral-200 p-5">
        <p className="text-sm text-neutral-600">
          This account is not linked to a member record in this organization
          yet. An administrator can link it, after which your callout
          invitations, availability, and qualifications appear here.
        </p>
        <p className="mt-4 text-sm">
          <Link
            href="/account"
            className="font-medium text-neutral-900 underline underline-offset-2 hover:text-neutral-600"
          >
            Go to your account
          </Link>
        </p>
      </div>
    );
  }

  const [
    availability,
    calloutInvitations,
    qualifications,
    training,
    submissions,
  ] = await Promise.all([
    getMemberAvailability(member.id),
    listMemberCalloutInvitations([member.id]),
    listMemberQualifications(member.id),
    listMemberTraining(member.id),
    listOwnMemberSubmissions(member.id),
  ]);
  const pendingSubmissions = submissions.filter(
    (s) => s.status === "PENDING",
  ).length;
  const expiringSoon = qualifications.filter(
    (q) =>
      q.expiresOn != null &&
      q.expiresOn <= new Date(orgToday.getTime() + 30 * 24 * 60 * 60 * 1000),
  );

  return (
    <div className="mt-6 grid gap-4 lg:grid-cols-2">
      <section
        aria-labelledby="dash-my-status"
        className="rounded-lg border border-neutral-200"
      >
        <h2
          id="dash-my-status"
          className="border-b border-neutral-200 px-4 py-2.5 text-sm font-semibold text-neutral-900"
        >
          {member.displayName}
        </h2>
        <dl className="px-4 py-3 text-sm">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-neutral-500">Availability</dt>
            <dd className="text-neutral-900">
              {availability.latest
                ? label(availability.status)
                : "Not recorded"}
            </dd>
          </div>
          {availability.expired && (
            <p className="mt-1 text-xs text-amber-800">
              Your last availability statement has expired — coordinators see
              your status as unknown until you update it.
            </p>
          )}
          <div className="mt-2 flex items-baseline justify-between gap-3">
            <dt className="text-neutral-500">Tracked qualifications</dt>
            <dd className="text-neutral-900">{qualifications.length}</dd>
          </div>
          {pendingSubmissions > 0 && (
            <div className="mt-2 flex items-baseline justify-between gap-3">
              <dt className="text-neutral-500">Submissions awaiting review</dt>
              <dd className="text-neutral-900">{pendingSubmissions}</dd>
            </div>
          )}
        </dl>
        <p className="border-t border-neutral-100 px-4 py-2.5 text-xs text-neutral-500">
          <Link
            href="/account"
            className="font-medium text-neutral-900 underline underline-offset-2 hover:text-neutral-600"
          >
            Update availability and details on your account page
          </Link>
        </p>
      </section>

      <section
        aria-labelledby="dash-my-callouts"
        className="rounded-lg border border-neutral-200"
      >
        <h2
          id="dash-my-callouts"
          className="border-b border-neutral-200 px-4 py-2.5 text-sm font-semibold text-neutral-900"
        >
          Active callout invitations
        </h2>
        {calloutInvitations.length === 0 ? (
          <p className="px-4 py-3 text-sm text-neutral-500">
            No active callout invitations.
          </p>
        ) : (
          <ul className="divide-y divide-neutral-100">
            {calloutInvitations.map((inv) => (
              <li key={inv.id} className="px-4 py-2.5">
                <span className="block truncate text-sm font-medium text-neutral-900">
                  {inv.callout.title}
                </span>
                <span className="text-xs text-neutral-500">
                  Activated{" "}
                  {formatInstantInZone(inv.callout.activatedAt, timezone)} ·
                  response: {inv.response ? label(inv.response) : "none yet"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section
        aria-labelledby="dash-my-quals"
        className="rounded-lg border border-neutral-200"
      >
        <h2
          id="dash-my-quals"
          className="border-b border-neutral-200 px-4 py-2.5 text-sm font-semibold text-neutral-900"
        >
          Certifications expiring within 30 days
        </h2>
        {expiringSoon.length === 0 ? (
          <p className="px-4 py-3 text-sm text-neutral-500">
            {qualifications.length === 0
              ? "No qualifications recorded for you."
              : "None of your recorded qualifications expire within 30 days."}
          </p>
        ) : (
          <ul className="divide-y divide-neutral-100">
            {expiringSoon.map((q) => (
              <li
                key={q.id}
                className="flex items-baseline justify-between gap-3 px-4 py-2.5"
              >
                <span className="truncate text-sm font-medium text-neutral-900">
                  {q.definition.name}
                </span>
                <span className="shrink-0 text-xs text-neutral-500">
                  {expiryLabel(q.expiresOn, orgToday)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section
        aria-labelledby="dash-my-training"
        className="rounded-lg border border-neutral-200"
      >
        <h2
          id="dash-my-training"
          className="border-b border-neutral-200 px-4 py-2.5 text-sm font-semibold text-neutral-900"
        >
          Recorded training
        </h2>
        {training.length === 0 ? (
          <p className="px-4 py-3 text-sm text-neutral-500">
            No training attendance recorded.
          </p>
        ) : (
          <ul className="divide-y divide-neutral-100">
            {training.slice(0, 5).map((a) => (
              <li
                key={a.id}
                className="flex items-baseline justify-between gap-3 px-4 py-2.5"
              >
                <span className="truncate text-sm font-medium text-neutral-900">
                  {a.event.title}
                </span>
                <span className="shrink-0 text-xs text-neutral-500">
                  {formatDateOnly(a.event.date)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
