import Link from "next/link";
import { notFound } from "next/navigation";

import { requireOrgAdminOrNotFound } from "@/lib/auth/authorize";
import {
  getCalloutForAdmin,
  CALLOUT_RESPONSE_LABELS,
  CALLOUT_RESPONSE_SOURCE_LABELS,
  CALLOUT_STATUS_LABELS,
} from "@/lib/domain/callouts";
import {
  NOTIFICATION_STATUS_LABELS,
  SUPPRESSION_REASON_LABELS,
} from "@/lib/domain/notifications";
import { relativeTimeLabel } from "@/lib/dates";

import {
  closeCalloutAction,
  recordCalloutResponseAction,
  createIncidentFromCalloutAction,
} from "../../../../actions";
import {
  AdminResponseForm,
  CloseCalloutButton,
} from "../../../../callout-forms";
import { IncidentFieldsForm } from "../../../../incident-forms";
import { INCIDENT_STATUS_LABELS } from "@/lib/domain/incidents";

export const metadata = { title: "Callout" };

export const dynamic = "force-dynamic";

const statusBadgeClass: Record<string, string> = {
  ACTIVE: "bg-green-100 text-green-800",
  CLOSED: "bg-neutral-100 text-neutral-600",
};

const responseBadgeClass: Record<string, string> = {
  COMING: "bg-green-100 text-green-800",
  UNAVAILABLE: "bg-amber-100 text-amber-800",
};

const notificationBadgeClass: Record<string, string> = {
  PENDING: "bg-amber-100 text-amber-800",
  SUPPRESSED: "bg-neutral-100 text-neutral-600",
  ACCEPTED: "bg-green-100 text-green-800",
  FAILED: "bg-red-100 text-red-800",
};

const AUDIENCE_LABELS: Record<string, string> = {
  ORGANIZATION: "All active members",
  UNIT: "Unit members",
  MEMBERS: "Selected members",
};

function formatInstant(date: Date) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date);
}

export default async function CalloutDetailPage({
  params,
}: {
  params: Promise<{ orgId: string; calloutId: string }>;
}) {
  const { orgId, calloutId } = await params;
  // Both URL ids are untrusted selectors. The callout's own
  // organizationId decides which grant must exist; a callout that does
  // not exist in this organization is indistinguishable from 404.
  const callout = await getCalloutForAdmin(calloutId);
  if (!callout || callout.organizationId !== orgId) {
    notFound();
  }
  await requireOrgAdminOrNotFound(callout.organizationId);

  const coming = callout.invitations.filter(
    (i) => i.response === "COMING",
  ).length;
  const unavailable = callout.invitations.filter(
    (i) => i.response === "UNAVAILABLE",
  ).length;
  const noResponse = callout.invitations.length - coming - unavailable;

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
          {callout.organization.name}
        </Link>
        <span aria-hidden="true"> / </span>
        <Link
          href={`/admin/organizations/${orgId}/callouts`}
          className="hover:underline"
        >
          Callouts
        </Link>
        <span aria-hidden="true"> / </span>
        <span aria-current="page" className="text-neutral-800">
          {callout.title}
        </span>
      </nav>

      <section aria-labelledby="callout-heading" className="mt-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1
              id="callout-heading"
              className="text-2xl font-semibold tracking-tight"
            >
              {callout.title}
            </h1>
            <p className="mt-1 text-sm text-neutral-500">
              {AUDIENCE_LABELS[callout.audience] ?? callout.audience}
              {callout.unit ? ` — ${callout.unit.name}` : ""}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span
              className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${statusBadgeClass[callout.status] ?? "bg-neutral-100 text-neutral-600"}`}
            >
              {CALLOUT_STATUS_LABELS[callout.status] ?? callout.status}
            </span>
            {callout.status === "ACTIVE" && (
              <CloseCalloutButton
                action={closeCalloutAction.bind(null, callout.id)}
              />
            )}
          </div>
        </div>
        {callout.message && (
          <p className="mt-3 whitespace-pre-line rounded-md border border-neutral-200 bg-neutral-50 p-3 text-sm text-neutral-800">
            {callout.message}
          </p>
        )}
        <dl className="mt-4 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-neutral-500">Activated</dt>
            <dd className="text-neutral-800">
              {formatInstant(callout.activatedAt)} UTC
              {callout.createdByDisplay
                ? ` · by ${callout.createdByDisplay}`
                : ""}
            </dd>
          </div>
          {callout.status === "CLOSED" && callout.closedAt && (
            <div>
              <dt className="text-xs text-neutral-500">Closed</dt>
              <dd className="text-neutral-800">
                {formatInstant(callout.closedAt)} UTC
                {callout.closedByDisplay
                  ? ` · by ${callout.closedByDisplay}`
                  : ""}
              </dd>
            </div>
          )}
        </dl>
      </section>

      <section
        aria-labelledby="response-summary-heading"
        className="mt-8 rounded-md border border-neutral-200 p-4"
      >
        <h2
          id="response-summary-heading"
          className="text-sm font-medium text-neutral-800"
        >
          Responses
        </h2>
        <p className="mt-2 text-sm text-neutral-700">
          {callout.invitations.length} invited · {coming} coming · {unavailable}{" "}
          unavailable · {noResponse} no response
        </p>
        <p className="mt-1 text-xs text-neutral-500">
          These are recorded facts about who replied — they do not indicate
          whether the crew is sufficient, qualified, or ready.
        </p>
      </section>

      <section aria-labelledby="invitees-heading" className="mt-8">
        <h2 id="invitees-heading" className="text-lg font-medium">
          Invited members
        </h2>
        <ul className="mt-3 divide-y divide-neutral-200 rounded-md border border-neutral-200">
          {callout.invitations.map((invitation) => {
            const latestAttempt = invitation.notification?.attempts.at(-1);
            return (
              <li key={invitation.id} className="px-4 py-3 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <Link
                    href={`/admin/members/${invitation.member.id}`}
                    className="font-medium text-neutral-900 hover:underline"
                  >
                    {invitation.member.displayName}
                  </Link>
                  <span
                    className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${
                      invitation.response
                        ? (responseBadgeClass[invitation.response] ??
                          "bg-neutral-100 text-neutral-600")
                        : "bg-neutral-100 text-neutral-600"
                    }`}
                  >
                    {invitation.response
                      ? CALLOUT_RESPONSE_LABELS[invitation.response]
                      : "No response"}
                  </span>
                </div>
                <p className="mt-1 text-xs text-neutral-500">
                  Invited {relativeTimeLabel(invitation.invitedAt)}
                  {invitation.respondedAt &&
                    ` · responded ${relativeTimeLabel(invitation.respondedAt)}`}
                </p>
                <p className="mt-1 text-xs text-neutral-600">
                  Notification:{" "}
                  {invitation.notification ? (
                    <>
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${notificationBadgeClass[invitation.notification.status] ?? "bg-neutral-100 text-neutral-600"}`}
                      >
                        {NOTIFICATION_STATUS_LABELS[
                          invitation.notification.status
                        ] ?? invitation.notification.status}
                      </span>
                      {invitation.notification.statusReason && (
                        <span className="ml-1 text-neutral-500">
                          {SUPPRESSION_REASON_LABELS[
                            invitation.notification.statusReason
                          ] ?? invitation.notification.statusReason}
                        </span>
                      )}
                      {latestAttempt?.status === "FAILED" &&
                        latestAttempt.errorSummary && (
                          <span className="ml-1 text-red-700">
                            {latestAttempt.errorSummary}
                          </span>
                        )}
                      {latestAttempt && (
                        <span className="ml-1 text-neutral-500">
                          via {latestAttempt.provider}
                          {latestAttempt.resolvedAt
                            ? ` · ${relativeTimeLabel(latestAttempt.resolvedAt)}`
                            : " · outcome not recorded"}
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="text-neutral-500">
                      No notification recorded
                    </span>
                  )}
                </p>
                {invitation.changes.length > 0 && (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-xs font-medium text-neutral-600 hover:text-neutral-900">
                      Response history ({invitation.changes.length})
                    </summary>
                    <ul className="mt-1 space-y-1">
                      {invitation.changes.map((change) => (
                        <li
                          key={change.id}
                          className="rounded border border-neutral-100 bg-neutral-50 px-3 py-1.5 text-xs text-neutral-700"
                        >
                          <span className="font-medium">
                            {change.previousResponse
                              ? `${CALLOUT_RESPONSE_LABELS[change.previousResponse]} → `
                              : ""}
                            {CALLOUT_RESPONSE_LABELS[change.response]}
                          </span>
                          <span className="text-neutral-500">
                            {" "}
                            · {CALLOUT_RESPONSE_SOURCE_LABELS[change.source]}
                            {change.actorDisplay
                              ? ` · ${change.actorDisplay}`
                              : ""}
                            {" · "}
                            {relativeTimeLabel(change.createdAt)}
                          </span>
                          {change.note && (
                            <span className="block text-neutral-500">
                              {change.note}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {callout.status === "ACTIVE" && (
                  <AdminResponseForm
                    action={recordCalloutResponseAction.bind(
                      null,
                      invitation.id,
                    )}
                    idPrefix={`resp-${invitation.id}`}
                  />
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section
        aria-labelledby="incident-record-heading"
        className="mt-8 rounded-md border border-neutral-200 p-4"
      >
        <h2
          id="incident-record-heading"
          className="text-sm font-medium text-neutral-800"
        >
          Incident record
        </h2>
        {callout.incident ? (
          <p className="mt-2 text-sm text-neutral-700">
            <Link
              href={`/admin/organizations/${orgId}/incidents/${callout.incident.id}`}
              className="font-medium text-neutral-900 hover:underline"
            >
              {callout.incident.reference} — {callout.incident.title}
            </Link>
            <span className="text-neutral-500">
              {" "}
              ·{" "}
              {INCIDENT_STATUS_LABELS[callout.incident.status] ??
                callout.incident.status}
            </span>
          </p>
        ) : (
          <>
            <p className="mt-1 text-xs text-neutral-500">
              Create the durable administrative record linked to this callout.
              Participants and assets are recorded on the incident separately —
              a callout response is never treated as proof of participation.
            </p>
            <div className="mt-3">
              <IncidentFieldsForm
                action={createIncidentFromCalloutAction.bind(null, callout.id)}
                defaults={{ title: callout.title, summary: callout.message }}
                submitLabel="Create incident record"
              />
            </div>
          </>
        )}
      </section>
    </main>
  );
}
