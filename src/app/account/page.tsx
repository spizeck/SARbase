import Link from "next/link";

import { prisma } from "@/lib/prisma";
import { requireAuth, linkedMembersWithAccess } from "@/lib/auth/authorize";
import { signOutAction } from "@/app/login/actions";
import {
  listMemberQualifications,
  expiryLabel,
} from "@/lib/domain/qualification";
import { listMemberTraining } from "@/lib/domain/training";
import {
  getMemberAvailability,
  getMemberContactPreference,
  AVAILABILITY_STATUS_LABELS,
} from "@/lib/domain/availability";
import {
  listMemberCalloutInvitations,
  CALLOUT_RESPONSE_LABELS,
} from "@/lib/domain/callouts";
import {
  calendarDateInZone,
  formatDateOnly,
  relativeTimeLabel,
} from "@/lib/dates";

import {
  updateMyAvailabilityAction,
  updateMyContactPreferencesAction,
  respondToMyInvitationAction,
} from "./actions";
import {
  AvailabilityForm,
  CalloutResponseForm,
  ContactPreferencesForm,
} from "./forms";

export const metadata = { title: "Account" };

export const dynamic = "force-dynamic";

/**
 * Minimal authenticated landing page: proves the identity, linked Member
 * context, organization scope, and role — no member self-service yet.
 */
export default async function AccountPage() {
  const ctx = await requireAuth();

  // A Member link alone grants nothing: member-derived data is exposed
  // only where the identity also holds a current OrganizationAccess row.
  const linkedMembers = linkedMembersWithAccess(ctx);

  const orgIds = [
    ...new Set([
      ...ctx.access.map((a) => a.organizationId),
      ...linkedMembers.map((m) => m.organizationId),
    ]),
  ];
  const orgs = orgIds.length
    ? await prisma.organization.findMany({ where: { id: { in: orgIds } } })
    : [];
  const orgName = (id: string) =>
    orgs.find((o) => o.id === id)?.name ?? "Unknown organization";
  // "Today" for expiry labels is the organization's own calendar date.
  const orgToday = (id: string) =>
    calendarDateInZone(orgs.find((o) => o.id === id)?.timezone ?? "UTC");

  const adminOrgs = ctx.access.filter((a) => a.role === "ADMIN");

  // Qualification + training records for the caller's own linked member
  // records only — member ids come from the server-resolved context and
  // the access boundary above, never from the client.
  const ownQualifications = await Promise.all(
    linkedMembers.map(async (member) => ({
      member,
      records: await listMemberQualifications(member.id),
    })),
  );
  const ownTraining = await Promise.all(
    linkedMembers.map(async (member) => ({
      member,
      records: await listMemberTraining(member.id),
    })),
  );

  // Active callout invitations for the caller's own linked, accessible
  // member records (issue #14) — the same two factual response options
  // as the emailed token link.
  const calloutInvitations = await listMemberCalloutInvitations(
    linkedMembers.map((m) => m.id),
  );

  // Self-service availability + contact preferences for each linked,
  // accessible member record — one block per (member, organization) so a
  // person volunteering across orgs is always explicit about which
  // record they are updating. Facts only: no sufficiency or readiness.
  const ownAvailability = await Promise.all(
    linkedMembers.map(async (member) => ({
      member,
      availability: await getMemberAvailability(member.id),
      preference: await getMemberContactPreference(member.id),
    })),
  );

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Account</h1>
        <form action={signOutAction}>
          <button
            type="submit"
            className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-800 hover:bg-neutral-50"
          >
            Sign out
          </button>
        </form>
      </div>

      <section aria-labelledby="identity-heading" className="mt-6">
        <h2
          id="identity-heading"
          className="text-sm font-medium text-neutral-500"
        >
          Signed in as
        </h2>
        <p className="mt-1 text-sm text-neutral-900">
          {ctx.identity.email ?? "Account without email"}
        </p>
      </section>

      <section aria-labelledby="memberships-heading" className="mt-8">
        <h2 id="memberships-heading" className="text-lg font-medium">
          Member records
        </h2>
        {linkedMembers.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-600">
            This sign-in is not linked to an accessible member record yet. An
            organization administrator can link it.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-neutral-200 rounded-md border border-neutral-200">
            {linkedMembers.map((member) => (
              <li key={member.id} className="px-4 py-3 text-sm">
                <span className="font-medium text-neutral-900">
                  {member.displayName}
                </span>
                <span className="text-neutral-500">
                  {" "}
                  — {orgName(member.organizationId)} (
                  {member.status === "ACTIVE" ? "active" : "inactive"})
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {calloutInvitations.length > 0 && (
        <section aria-labelledby="callouts-heading" className="mt-8">
          <h2 id="callouts-heading" className="text-lg font-medium">
            Active callouts
          </h2>
          <p className="mt-1 text-sm text-neutral-600">
            Your organization has invited you to respond. These are recorded
            facts — your coordinator decides what they mean.
          </p>
          <ul className="mt-2 divide-y divide-neutral-200 rounded-md border border-neutral-200">
            {calloutInvitations.map((invitation) => (
              <li key={invitation.id} className="px-4 py-3 text-sm">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-medium text-neutral-900">
                    {invitation.callout.title}
                  </span>
                  <span className="text-xs text-neutral-600">
                    {invitation.response
                      ? CALLOUT_RESPONSE_LABELS[invitation.response]
                      : "No response yet"}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-neutral-500">
                  {invitation.callout.organization.name} · invited{" "}
                  {relativeTimeLabel(invitation.invitedAt)}
                  {" · "}as {invitation.member.displayName}
                </p>
                {invitation.callout.message && (
                  <p className="mt-1 whitespace-pre-line text-xs text-neutral-600">
                    {invitation.callout.message}
                  </p>
                )}
                <CalloutResponseForm
                  action={respondToMyInvitationAction.bind(null, invitation.id)}
                  currentResponse={invitation.response}
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      {linkedMembers.length > 0 && (
        <section aria-labelledby="availability-heading" className="mt-8">
          <h2 id="availability-heading" className="text-lg font-medium">
            Availability
          </h2>
          <p className="mt-1 text-sm text-neutral-600">
            Record your current availability for each organization you volunteer
            with. These are factual statements — your organization decides what
            they mean.
          </p>
          {ownAvailability.map(({ member, availability, preference }) => (
            <div
              key={member.id}
              className="mt-3 rounded-md border border-neutral-200 p-4"
            >
              <h3 className="text-sm font-medium text-neutral-500">
                {member.displayName} — {orgName(member.organizationId)}
              </h3>
              <div className="mt-2 text-sm">
                <span
                  className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${
                    availability.status === "AVAILABLE"
                      ? "bg-green-100 text-green-800"
                      : availability.status === "UNKNOWN"
                        ? "bg-neutral-100 text-neutral-600"
                        : "bg-amber-100 text-amber-800"
                  }`}
                >
                  {AVAILABILITY_STATUS_LABELS[availability.status]}
                </span>
                {availability.latest?.until &&
                  !availability.expired &&
                  availability.status !== "UNKNOWN" && (
                    <span className="ml-2 text-neutral-600">
                      Until{" "}
                      {new Intl.DateTimeFormat("en-US", {
                        dateStyle: "medium",
                        timeZone: "UTC",
                      }).format(availability.latest.until)}
                    </span>
                  )}
              </div>
              <p className="mt-1 text-xs text-neutral-500">
                {availability.latest
                  ? `Last updated ${relativeTimeLabel(availability.latest.createdAt)}`
                  : "Not recorded yet"}
                {availability.expired && availability.latest
                  ? ` — last recorded as ${
                      AVAILABILITY_STATUS_LABELS[availability.latest.status]
                    }${
                      availability.latest.until
                        ? ` until ${formatDateOnly(availability.latest.until)}`
                        : ""
                    }, which has passed`
                  : ""}
              </p>
              <details className="mt-3">
                <summary className="cursor-pointer text-sm font-medium text-neutral-700 hover:text-neutral-900">
                  Update availability
                </summary>
                <div className="mt-2">
                  <AvailabilityForm
                    action={updateMyAvailabilityAction.bind(null, member.id)}
                    defaultStatus={availability.status}
                    defaultUntil={formatDateOnly(availability.latest?.until)}
                    defaultNote={availability.latest?.note}
                    idPrefix={`availability-${member.id}`}
                  />
                </div>
              </details>
              <details className="mt-3">
                <summary className="cursor-pointer text-sm font-medium text-neutral-700 hover:text-neutral-900">
                  Contact preferences
                </summary>
                <div className="mt-2">
                  <ContactPreferencesForm
                    action={updateMyContactPreferencesAction.bind(
                      null,
                      member.id,
                    )}
                    email={member.email}
                    phone={member.phone}
                    defaults={preference}
                    idPrefix={`contact-${member.id}`}
                  />
                </div>
              </details>
            </div>
          ))}
        </section>
      )}

      {ownQualifications.some((g) => g.records.length > 0) && (
        <section aria-labelledby="qualifications-heading" className="mt-8">
          <h2 id="qualifications-heading" className="text-lg font-medium">
            My qualifications &amp; certifications
          </h2>
          {ownQualifications.map(({ member, records }) =>
            records.length === 0 ? null : (
              <div key={member.id} className="mt-3">
                <h3 className="text-sm font-medium text-neutral-500">
                  {orgName(member.organizationId)}
                </h3>
                <ul className="mt-1 divide-y divide-neutral-200 rounded-md border border-neutral-200">
                  {records.map((record) => (
                    <li key={record.id} className="px-4 py-3 text-sm">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="font-medium text-neutral-900">
                          {record.definition.name}
                        </span>
                        <span className="text-xs text-neutral-600">
                          {expiryLabel(
                            record.expiresOn,
                            orgToday(member.organizationId),
                          )}
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs text-neutral-500">
                        Issued{" "}
                        {formatDateOnly(record.issuedOn) ?? "not recorded"}
                        {record.issuer ? ` · ${record.issuer}` : ""}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            ),
          )}
        </section>
      )}

      {ownTraining.some((g) => g.records.length > 0) && (
        <section aria-labelledby="training-heading" className="mt-8">
          <h2 id="training-heading" className="text-lg font-medium">
            My training
          </h2>
          {ownTraining.map(({ member, records }) =>
            records.length === 0 ? null : (
              <div key={member.id} className="mt-3">
                <h3 className="text-sm font-medium text-neutral-500">
                  {orgName(member.organizationId)}
                </h3>
                <ul className="mt-1 divide-y divide-neutral-200 rounded-md border border-neutral-200">
                  {records.map((attendance) => (
                    <li key={attendance.id} className="px-4 py-3 text-sm">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="font-medium text-neutral-900">
                          {attendance.event.title}
                        </span>
                        <span className="text-xs text-neutral-600">
                          {formatDateOnly(attendance.event.date)}
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs text-neutral-500">
                        {attendance.event.status === "CANCELLED"
                          ? "Cancelled — did not occur"
                          : attendance.event.durationMinutes != null
                            ? `${attendance.event.durationMinutes} minutes`
                            : ""}
                        {attendance.event.location
                          ? ` ${attendance.event.location}`
                          : ""}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            ),
          )}
        </section>
      )}

      <section aria-labelledby="access-heading" className="mt-8">
        <h2 id="access-heading" className="text-lg font-medium">
          Organization access
        </h2>
        {ctx.access.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-600">
            No organization access has been granted to this account.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-neutral-200 rounded-md border border-neutral-200">
            {ctx.access.map((a) => (
              <li
                key={a.id}
                className="flex items-center justify-between px-4 py-3 text-sm"
              >
                <span className="font-medium text-neutral-900">
                  {orgName(a.organizationId)}
                </span>
                <span className="text-neutral-500">
                  {a.role === "ADMIN" ? "Administrator" : "Member"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {adminOrgs.length > 0 && (
        <p className="mt-8">
          <Link
            href="/admin"
            className="text-sm font-medium text-neutral-900 underline underline-offset-4 hover:text-neutral-600"
          >
            Go to administration
          </Link>
        </p>
      )}
    </main>
  );
}
