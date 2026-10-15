import Link from "next/link";
import { notFound } from "next/navigation";

import { requireOrgAdminOrNotFound } from "@/lib/auth/authorize";
import { resolveActorLabels } from "@/lib/domain/actors";
import {
  listOrganizationAccess,
  listOrganizationAccessEvents,
} from "@/lib/domain/access";
import {
  invitationDisplayState,
  listPendingMemberInvitations,
  MEMBER_INVITATION_STATE_LABELS,
} from "@/lib/domain/invitations";
import { getOrganization } from "@/lib/domain/organization";
import { instantExpiryLabel, relativeTimeLabel } from "@/lib/dates";

import { setOrganizationAccessRoleAction } from "../../../actions";
import { AccessRoleForm } from "../../../forms";

export const metadata = { title: "Access & roles" };

export const dynamic = "force-dynamic";

const ROLE_LABELS = { ADMIN: "Administrator", MEMBER: "Member" } as const;

/**
 * Organization access administration (issue #74): who can sign in to
 * this organization, with which application role, and the audited
 * history of role changes.
 *
 * Access rows are keyed to sign-in identities, not member records — a
 * grant with no linked member still holds real access, so the table is
 * built from OrganizationAccess, never from the member roster.
 */
export default async function OrganizationAccessPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const ctx = await requireOrgAdminOrNotFound(orgId);
  const organization = await getOrganization(orgId);
  if (!organization) notFound();

  const [accessRows, pendingInvitations, events] = await Promise.all([
    listOrganizationAccess(orgId),
    listPendingMemberInvitations(orgId),
    listOrganizationAccessEvents(orgId),
  ]);

  const actorLabels = await resolveActorLabels(orgId, [
    ...events.map((e) => e.actorAuthIdentityId),
    ...events.map((e) => e.targetAuthIdentityId),
  ]);

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
          Access &amp; roles
        </span>
      </nav>

      <h1 className="mt-4 text-lg font-semibold text-neutral-900">
        Access &amp; roles
      </h1>
      <p className="mt-1 text-sm text-neutral-600">
        Who can sign in to {organization.name} on SARbase, and what they can do
        here. An <strong>administrator</strong> manages records, members,
        invitations, and other accounts&apos; roles — this is application access
        only and says nothing about SAR operational or command authority. Role
        changes apply immediately and are recorded below.
      </p>

      <section aria-labelledby="accounts-heading" className="mt-6">
        <h2
          id="accounts-heading"
          className="text-sm font-medium text-neutral-800"
        >
          Sign-in accounts
        </h2>
        <div className="mt-2 overflow-x-auto rounded-md border border-neutral-200">
          <table className="min-w-full divide-y divide-neutral-200 text-sm">
            <thead className="bg-neutral-50">
              <tr>
                <th
                  scope="col"
                  className="px-4 py-2 text-left font-medium text-neutral-700"
                >
                  Account
                </th>
                <th
                  scope="col"
                  className="px-4 py-2 text-left font-medium text-neutral-700"
                >
                  Role
                </th>
                <th
                  scope="col"
                  className="px-4 py-2 text-left font-medium text-neutral-700"
                >
                  Change role
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-200">
              {accessRows.map((row) => {
                const isSelf = row.authIdentityId === ctx.identity.id;
                const label =
                  row.memberDisplayName ??
                  row.identityEmail ??
                  "Unnamed account";
                return (
                  <tr key={row.authIdentityId}>
                    <td className="px-4 py-2">
                      <span className="font-medium text-neutral-900">
                        {label}
                        {isSelf ? " (you)" : ""}
                      </span>
                      <span className="block text-xs text-neutral-500">
                        {row.identityEmail ?? "No sign-in email recorded"}
                        {row.identityStatus === "DISABLED"
                          ? " · account disabled"
                          : ""}
                      </span>
                      {row.memberId ? (
                        <Link
                          href={`/admin/organizations/${orgId}/members/${row.memberId}`}
                          className="text-xs text-neutral-500 hover:underline"
                        >
                          Member record
                        </Link>
                      ) : (
                        <span className="text-xs text-neutral-500">
                          No linked member record
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                          row.role === "ADMIN"
                            ? "bg-amber-100 text-amber-800"
                            : "bg-neutral-100 text-neutral-600"
                        }`}
                      >
                        {ROLE_LABELS[row.role]}
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      <AccessRoleForm
                        action={setOrganizationAccessRoleAction.bind(
                          null,
                          orgId,
                          row.authIdentityId,
                        )}
                        currentRole={row.role}
                        targetLabel={label}
                        isSelf={isSelf}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-neutral-500">
          Accounts are granted access by accepting a member invitation or by
          linking from a member record. An organization always keeps at least
          one active administrator.
        </p>
      </section>

      {pendingInvitations.length > 0 && (
        <section aria-labelledby="pending-heading" className="mt-8">
          <h2
            id="pending-heading"
            className="text-sm font-medium text-neutral-800"
          >
            Pending invitations
          </h2>
          <p className="mt-1 text-sm text-neutral-600">
            The invited role applies only when the recipient accepts. To change
            it, revoke the invitation and send a new one from the member&apos;s
            page — an outstanding invitation is never edited in place.
          </p>
          <ul className="mt-2 divide-y divide-neutral-200 rounded-md border border-neutral-200">
            {pendingInvitations.map((invitation) => (
              <li key={invitation.id} className="px-4 py-3 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <Link
                    href={`/admin/organizations/${orgId}/members/${invitation.member.id}`}
                    className="font-medium text-neutral-900 hover:underline"
                  >
                    {invitation.member.displayName}
                  </Link>
                  <span className="text-xs text-neutral-600">
                    Invited as{" "}
                    {invitation.role === "ADMIN" ? "administrator" : "member"} ·{" "}
                    {
                      MEMBER_INVITATION_STATE_LABELS[
                        invitationDisplayState(invitation)
                      ]
                    }{" "}
                    ·{" "}
                    {instantExpiryLabel(
                      invitation.expiresAt,
                      organization.timezone,
                    )}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-neutral-500">
                  Sent to {invitation.email} ·{" "}
                  {relativeTimeLabel(invitation.createdAt)}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="history-heading" className="mt-8">
        <h2
          id="history-heading"
          className="text-sm font-medium text-neutral-800"
        >
          Access change history
        </h2>
        {events.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-500">
            No role changes recorded yet.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-neutral-200 rounded-md border border-neutral-200">
            {events.map((event) => (
              <li key={event.id} className="px-4 py-2 text-xs">
                <span className="font-medium text-neutral-900">
                  {actorLabels.get(event.targetAuthIdentityId) ??
                    event.targetAuthIdentityId}
                </span>
                <span className="text-neutral-600">
                  {" "}
                  changed from{" "}
                  {event.previousRole === "ADMIN"
                    ? "administrator"
                    : "member"}{" "}
                  to {event.role === "ADMIN" ? "administrator" : "member"}
                </span>
                <span className="text-neutral-500">
                  {" "}
                  · {relativeTimeLabel(event.createdAt)} · by{" "}
                  {event.actorAuthIdentityId
                    ? (actorLabels.get(event.actorAuthIdentityId) ??
                      "unknown account")
                    : "system"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
