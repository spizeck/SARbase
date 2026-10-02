import Link from "next/link";

import { prisma } from "@/lib/prisma";
import { requireOrgAdminOrNotFound } from "@/lib/auth/authorize";
import {
  listOrganizationCallouts,
  CALLOUT_STATUS_LABELS,
} from "@/lib/domain/callouts";
import {
  listOrganizationAvailability,
  AVAILABILITY_STATUS_LABELS,
} from "@/lib/domain/availability";
import { calendarDateInZone, relativeTimeLabel } from "@/lib/dates";

import { activateCalloutAction } from "../../../actions";
import { CalloutActivationForm } from "../../../callout-forms";

export const metadata = { title: "Callouts" };

export const dynamic = "force-dynamic";

const statusBadgeClass: Record<string, string> = {
  ACTIVE: "bg-green-100 text-green-800",
  CLOSED: "bg-neutral-100 text-neutral-600",
};

const AUDIENCE_LABELS: Record<string, string> = {
  ORGANIZATION: "Organization-wide",
  UNIT: "Unit",
  MEMBERS: "Selected members",
};

export default async function OrganizationCalloutsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  // orgId from the URL is an untrusted selector — the grant comes from
  // the caller's OrganizationAccess rows.
  await requireOrgAdminOrNotFound(orgId);

  const organization = await prisma.organization.findUniqueOrThrow({
    where: { id: orgId },
  });
  const today = calendarDateInZone(organization.timezone);
  const [callouts, units, members, availability] = await Promise.all([
    listOrganizationCallouts(orgId),
    prisma.unit.findMany({
      where: { organizationId: orgId },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    prisma.member.findMany({
      where: { organizationId: orgId, status: "ACTIVE" },
      orderBy: { displayName: "asc" },
      select: { id: true, displayName: true, email: true },
    }),
    // Shown only as factual context next to member names in the
    // selection list — it never filters who may be invited.
    listOrganizationAvailability(orgId, today),
  ]);

  const memberOptions = members.map((member) => ({
    id: member.id,
    displayName: member.displayName,
    context:
      [
        member.email ? null : "no email on record",
        AVAILABILITY_STATUS_LABELS[
          availability.get(member.id)?.status ?? "UNKNOWN"
        ],
      ]
        .filter(Boolean)
        .join(" · ") || undefined,
  }));

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <nav aria-label="Breadcrumb" className="text-sm text-neutral-500">
        <Link href="/admin" className="hover:underline">
          Administration
        </Link>
        <span aria-hidden="true"> / </span>
        <Link
          href={`/admin/organizations/${orgId}`}
          className="hover:underline"
        >
          {organization.name}
        </Link>
        <span aria-hidden="true"> / </span>
        <span aria-current="page" className="text-neutral-800">
          Callouts
        </span>
      </nav>

      <section aria-labelledby="callouts-heading" className="mt-6">
        <h1
          id="callouts-heading"
          className="text-2xl font-semibold tracking-tight"
        >
          Callouts
        </h1>
        <p className="mt-1 text-sm text-neutral-600">
          A factual record of who was invited and how they responded. SARbase
          does not determine whether the resulting crew is sufficient,
          qualified, ready, or appropriate for an operation.
        </p>
      </section>

      <section
        aria-labelledby="activate-heading"
        className="mt-6 rounded-md border border-neutral-200 p-4"
      >
        <h2
          id="activate-heading"
          className="text-sm font-medium text-neutral-800"
        >
          New callout
        </h2>
        <p className="mt-1 text-sm text-neutral-600">
          Emails every invited member a secure personal response link. Members
          who have not enabled email notifications — or have no email on record
          — are still invited; their notification is recorded as suppressed.
        </p>
        <div className="mt-3">
          <CalloutActivationForm
            action={activateCalloutAction.bind(null, orgId)}
            units={units}
            members={memberOptions}
            activationKey={crypto.randomUUID()}
          />
        </div>
      </section>

      <section aria-labelledby="history-heading" className="mt-8">
        <h2 id="history-heading" className="text-lg font-medium">
          Callout history
        </h2>
        {callouts.length === 0 ? (
          <p className="mt-3 text-sm text-neutral-500">
            No callouts recorded yet.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-neutral-200 rounded-md border border-neutral-200">
            {callouts.map((callout) => (
              <li key={callout.id} className="px-4 py-3 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <Link
                    href={`/admin/organizations/${orgId}/callouts/${callout.id}`}
                    className="font-medium text-neutral-900 hover:underline"
                  >
                    {callout.title}
                  </Link>
                  <span
                    className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${statusBadgeClass[callout.status] ?? "bg-neutral-100 text-neutral-600"}`}
                  >
                    {CALLOUT_STATUS_LABELS[callout.status] ?? callout.status}
                  </span>
                </div>
                <p className="mt-1 text-xs text-neutral-500">
                  {AUDIENCE_LABELS[callout.audience] ?? callout.audience}
                  {callout.unit ? ` — ${callout.unit.name}` : ""}
                  {" · "}
                  {relativeTimeLabel(callout.activatedAt)}
                </p>
                <p className="mt-1 text-xs text-neutral-600">
                  {callout.counts.total} invited · {callout.counts.coming}{" "}
                  coming · {callout.counts.unavailable} unavailable ·{" "}
                  {callout.counts.noResponse} no response
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
