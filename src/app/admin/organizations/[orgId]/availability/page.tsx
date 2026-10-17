import Link from "next/link";
import { notFound } from "next/navigation";

import { OrgCapability, type AvailabilityStatus } from "@prisma/client";

import {
  hasOrgCapability,
  requireOrgStaffOrNotFound,
} from "@/lib/auth/authorize";
import { getOrganization } from "@/lib/domain/organization";
import { listMembers } from "@/lib/domain/member";
import {
  listOrganizationAvailability,
  AVAILABILITY_STATUS_LABELS,
} from "@/lib/domain/availability";
import {
  calendarDateInZone,
  formatDateOnly,
  relativeTimeLabel,
} from "@/lib/dates";

export const metadata = { title: "Availability" };

export const dynamic = "force-dynamic";

const BADGE_AVAILABLE = "bg-green-100 text-green-800";
const BADGE_UNAVAILABLE = "bg-amber-100 text-amber-800";
const BADGE_UNKNOWN = "bg-neutral-100 text-neutral-600";

interface BoardMember {
  id: string;
  displayName: string;
  memberUnits: { unit: { name: string } }[];
}

interface Row {
  member: BoardMember;
  status: AvailabilityStatus;
  until: Date | null;
  updatedAt: Date | null;
  expiredStatement: boolean;
}

const unitNames = (member: BoardMember) =>
  member.memberUnits.map((mu) => mu.unit.name).join(", ");

function MemberName({
  orgId,
  member,
  canLink,
}: {
  orgId: string;
  member: { id: string; displayName: string };
  canLink: boolean;
}) {
  return canLink ? (
    <Link
      href={`/admin/organizations/${orgId}/members/${member.id}`}
      className="font-medium text-neutral-900 hover:underline"
    >
      {member.displayName}
    </Link>
  ) : (
    <span className="font-medium text-neutral-900">{member.displayName}</span>
  );
}

function RowList({
  rows,
  orgId,
  canViewMembers,
}: {
  rows: Row[];
  orgId: string;
  canViewMembers: boolean;
}) {
  return (
    <ul className="divide-y divide-neutral-100">
      {rows.map((row) => (
        <li key={row.member.id} className="px-4 py-2.5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="min-w-0">
              <MemberName
                orgId={orgId}
                member={row.member}
                canLink={canViewMembers}
              />
              {unitNames(row.member) && (
                <span className="text-xs text-neutral-500">
                  {" "}
                  — {unitNames(row.member)}
                </span>
              )}
            </span>
            <span className="shrink-0 text-xs text-neutral-500">
              {AVAILABILITY_STATUS_LABELS[row.status]}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-neutral-500">
            {row.until && row.status !== "UNKNOWN" && (
              <>until {formatDateOnly(row.until)} · </>
            )}
            {row.updatedAt ? (
              <>
                {row.expiredStatement ? "expired — " : ""}updated{" "}
                {relativeTimeLabel(row.updatedAt)}
              </>
            ) : (
              "no statement recorded"
            )}
          </p>
        </li>
      ))}
    </ul>
  );
}

function Group({
  id,
  title,
  badge,
  rows,
  empty,
  orgId,
  canViewMembers,
}: {
  id: string;
  title: string;
  badge: string;
  rows: Row[];
  empty: string;
  orgId: string;
  canViewMembers: boolean;
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
        <span
          className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${badge}`}
        >
          {rows.length}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-3 text-sm text-neutral-500">{empty}</p>
      ) : (
        <RowList rows={rows} orgId={orgId} canViewMembers={canViewMembers} />
      )}
    </section>
  );
}

/**
 * Coordinator availability board — the factual roster answer to "who
 * has said they can respond right now". Visible to members managers and
 * operations coordinators alike; member-record links still require
 * MEMBERS_MANAGE, degrading to plain text otherwise.
 *
 * Stated availability is a member's own declaration at a point in time.
 * It is not a qualification, competence, or readiness assessment, and
 * UNKNOWN means "no current statement" — never "unavailable".
 */
export default async function AvailabilityBoardPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const ctx = await requireOrgStaffOrNotFound(orgId);
  const canManage =
    hasOrgCapability(ctx, orgId, OrgCapability.MEMBERS_MANAGE) ||
    hasOrgCapability(ctx, orgId, OrgCapability.OPERATIONS_MANAGE);
  if (!canManage) notFound();
  const canViewMembers = hasOrgCapability(
    ctx,
    orgId,
    OrgCapability.MEMBERS_MANAGE,
  );

  const organization = await getOrganization(orgId);
  if (!organization) notFound();
  const today = calendarDateInZone(organization.timezone);

  const [members, availability] = await Promise.all([
    listMembers(orgId),
    listOrganizationAvailability(orgId, today),
  ]);
  const active = members.filter((m) => m.status === "ACTIVE");

  const available: Row[] = [];
  const unavailable: Row[] = [];
  const unknown: Row[] = [];
  for (const member of active) {
    const current = availability.get(member.id);
    const row: Row = {
      member,
      status: current?.status ?? "UNKNOWN",
      until: current?.latest?.until ?? null,
      updatedAt: current?.latest?.createdAt ?? null,
      // Distinguish "statement elapsed" from "never recorded" — an
      // expired statement is not a current declaration either way.
      expiredStatement: Boolean(current?.latest && current.expired),
    };
    if (row.status === "AVAILABLE") available.push(row);
    else if (row.status === "UNAVAILABLE" || row.status === "OFF_ISLAND")
      unavailable.push(row);
    else unknown.push(row);
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <nav aria-label="Breadcrumb" className="text-sm text-neutral-500">
        <Link href="/org" className="hover:underline">
          Organizations
        </Link>
        <span aria-hidden="true"> / </span>
        <Link href={`/org/${orgId}`} className="hover:underline">
          {organization.name}
        </Link>
        <span aria-hidden="true"> / </span>
        <span aria-current="page" className="text-neutral-800">
          Availability
        </span>
      </nav>

      <section aria-labelledby="availability-heading" className="mt-6">
        <h1
          id="availability-heading"
          className="text-2xl font-semibold tracking-tight"
        >
          Member availability
        </h1>
        <p className="mt-1 text-sm text-neutral-600">
          Each member&rsquo;s most recent stated availability, using the
          organization&rsquo;s local calendar (today: {formatDateOnly(today)}).
          A statement whose end date has passed no longer describes the present.
          Availability is what members say — it is not a qualification,
          competence, or readiness assessment.
        </p>
      </section>

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <Group
          id="group-available"
          title="Available"
          badge={BADGE_AVAILABLE}
          rows={available}
          empty="No member currently reports available."
          orgId={orgId}
          canViewMembers={canViewMembers}
        />
        <Group
          id="group-unavailable"
          title="Unavailable / off island"
          badge={BADGE_UNAVAILABLE}
          rows={unavailable}
          empty="No member currently reports unavailable."
          orgId={orgId}
          canViewMembers={canViewMembers}
        />
        <Group
          id="group-unknown"
          title="Unknown"
          badge={BADGE_UNKNOWN}
          rows={unknown}
          empty="Every active member has a current statement."
          orgId={orgId}
          canViewMembers={canViewMembers}
        />
      </div>
      <p className="mt-3 text-xs text-neutral-500">
        Unknown means no current statement — never recorded, or the last
        statement expired. It does not mean unavailable.
      </p>
    </div>
  );
}
