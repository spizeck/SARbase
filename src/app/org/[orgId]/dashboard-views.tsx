import Link from "next/link";

import { SetupChecklist } from "@/app/admin/setup-checklist";
import { setSetupChecklistDismissedAction } from "@/app/admin/actions";
import { getAdminDashboard } from "@/lib/domain/dashboard";
import { getOrganizationSetup } from "@/lib/domain/setup";
import { getMemberAvailability } from "@/lib/domain/availability";
import { listMemberCalloutInvitations } from "@/lib/domain/callouts";
import { listMemberTraining } from "@/lib/domain/training";
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

const WORKSPACES = [
  {
    name: "Operations",
    description: "Callouts, incidents, and training events.",
    href: (a: string) => `${a}/callouts`,
  },
  {
    name: "People",
    description: "Member records, units, and qualifications.",
    href: (a: string) => `${a}/members`,
  },
  {
    name: "Equipment",
    description: "Assets, inventory, locations, and maintenance.",
    href: (a: string) => `${a}/assets`,
  },
  {
    name: "Reporting",
    description: "Data exports and annual activity summaries.",
    href: (a: string) => `${a}/reports`,
  },
];

export async function AdminDashboard({
  orgId,
  adminRoot,
  timezone,
  orgToday,
}: {
  orgId: string;
  adminRoot: string;
  timezone: string;
  orgToday: Date;
}) {
  const [data, setup] = await Promise.all([
    getAdminDashboard(orgId, timezone),
    getOrganizationSetup(orgId),
  ]);
  const { counts } = data;

  return (
    <>
      {setup && (
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

      <section aria-labelledby="overview-heading" className="mt-6">
        <h2 id="overview-heading" className="sr-only">
          Organization overview
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <StatCard
            href={`${adminRoot}/members`}
            count={counts.members}
            name="Members"
          />
          <StatCard
            href={`${adminRoot}/units`}
            count={counts.units}
            name="Units"
          />
          <StatCard
            href={`${adminRoot}/assets`}
            count={counts.assets}
            name="Assets"
          />
          <StatCard
            href={`${adminRoot}/inventory`}
            count={counts.inventoryItems}
            name="Inventory items"
          />
          <StatCard
            href={`${adminRoot}/locations`}
            count={counts.storageLocations}
            name="Storage locations"
          />
          <StatCard
            href={`${adminRoot}/qualifications`}
            count={counts.qualificationDefinitions}
            name="Qualification definitions"
          />
        </div>
      </section>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
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
                </li>
              ))}
            </ul>
          )}
        </SectionList>
      </div>

      <section aria-labelledby="workspaces-heading" className="mt-8">
        <h2
          id="workspaces-heading"
          className="text-sm font-semibold text-neutral-900"
        >
          Manage
        </h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {WORKSPACES.map((w) => (
            <Link
              key={w.name}
              href={w.href(adminRoot)}
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

  const [availability, calloutInvitations, qualifications, training] =
    await Promise.all([
      getMemberAvailability(member.id),
      listMemberCalloutInvitations([member.id]),
      listMemberQualifications(member.id),
      listMemberTraining(member.id),
    ]);
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
          <div className="mt-2 flex items-baseline justify-between gap-3">
            <dt className="text-neutral-500">Tracked qualifications</dt>
            <dd className="text-neutral-900">{qualifications.length}</dd>
          </div>
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
