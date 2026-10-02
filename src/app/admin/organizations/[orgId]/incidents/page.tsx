import Link from "next/link";

import { prisma } from "@/lib/prisma";
import { requireOrgAdminOrNotFound } from "@/lib/auth/authorize";
import {
  listOrganizationIncidents,
  INCIDENT_STATUS_LABELS,
} from "@/lib/domain/incidents";
import { formatInstantInZone } from "@/lib/dates";

import { createIncidentAction } from "../../../actions";
import { IncidentFieldsForm } from "../../../incident-forms";

export const metadata = { title: "Incidents" };

export const dynamic = "force-dynamic";

const statusBadgeClass: Record<string, string> = {
  DRAFT: "bg-amber-100 text-amber-800",
  OPEN: "bg-green-100 text-green-800",
  CLOSED: "bg-neutral-100 text-neutral-600",
};

export default async function OrganizationIncidentsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  // orgId from the URL is an untrusted selector — the grant comes from
  // the caller's OrganizationAccess rows. Incidents may carry sensitive
  // data; the entire surface is ADMIN-only by design.
  await requireOrgAdminOrNotFound(orgId);

  const organization = await prisma.organization.findUniqueOrThrow({
    where: { id: orgId },
  });
  const incidents = await listOrganizationIncidents(orgId);
  const tz = organization.timezone;

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
          Incidents
        </span>
      </nav>

      <section aria-labelledby="incidents-heading" className="mt-6">
        <h1
          id="incidents-heading"
          className="text-2xl font-semibold tracking-tight"
        >
          Incidents
        </h1>
        <p className="mt-1 text-sm text-neutral-600">
          The durable administrative record: what was reported, who was recorded
          as participating, and what was later corrected. SARbase records
          incident facts and human-authored notes — it does not provide search
          planning, navigation, tactics, readiness judgments, or operational
          recommendations.
        </p>
      </section>

      {incidents.length === 0 ? (
        <p className="mt-6 text-sm text-neutral-500">
          No incidents recorded yet.
        </p>
      ) : (
        <ul className="mt-6 divide-y divide-neutral-200 rounded-md border border-neutral-200">
          {incidents.map((incident) => (
            <li key={incident.id} className="px-4 py-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <Link
                  href={`/admin/organizations/${orgId}/incidents/${incident.id}`}
                  className="font-medium text-neutral-900 hover:underline"
                >
                  <span className="mr-2 font-mono text-xs text-neutral-500">
                    {incident.reference}
                  </span>
                  {incident.title}
                </Link>
                <span
                  className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${statusBadgeClass[incident.status] ?? "bg-neutral-100 text-neutral-600"}`}
                >
                  {INCIDENT_STATUS_LABELS[incident.status] ?? incident.status}
                </span>
              </div>
              <p className="mt-1 text-xs text-neutral-500">
                {incident.reportedAt
                  ? `Reported ${formatInstantInZone(incident.reportedAt, tz)}`
                  : `Recorded ${formatInstantInZone(incident.createdAt, tz)}`}
                {incident.closedAt
                  ? ` · closed ${formatInstantInZone(incident.closedAt, tz)}`
                  : ""}
                {incident.callout ? " · callout linked" : ""}
                {` · ${incident._count.members} participant${incident._count.members === 1 ? "" : "s"} · ${incident._count.notes} note${incident._count.notes === 1 ? "" : "s"}`}
              </p>
            </li>
          ))}
        </ul>
      )}

      <section
        aria-labelledby="create-incident-heading"
        className="mt-10 rounded-md border border-neutral-200 p-4"
      >
        <h2
          id="create-incident-heading"
          className="text-sm font-medium text-neutral-800"
        >
          New incident record
        </h2>
        <p className="mt-1 text-xs text-neutral-500">
          A record may also be created from a callout&rsquo;s detail page.
        </p>
        <div className="mt-3">
          <IncidentFieldsForm
            action={createIncidentAction.bind(null, orgId)}
            submitLabel="Create incident record"
          />
        </div>
      </section>
    </main>
  );
}
