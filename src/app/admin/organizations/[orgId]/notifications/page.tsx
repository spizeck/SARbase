import Link from "next/link";

import { prisma } from "@/lib/prisma";
import { OrgCapability } from "@prisma/client";

import {
  hasOrgCapability,
  requireOrgCapabilityOrNotFound,
} from "@/lib/auth/authorize";
import {
  isRetryableNotification,
  listOrganizationNotifications,
  NOTIFICATION_ATTEMPT_STATUS_LABELS,
  NOTIFICATION_DELIVERY_STATUS_LABELS,
  NOTIFICATION_STATUS_LABELS,
  SUPPRESSION_REASON_LABELS,
} from "@/lib/domain/notifications";
import { CALLOUT_RESPONSE_LABELS } from "@/lib/domain/callouts";
import { relativeTimeLabel } from "@/lib/dates";

import {
  retryNotificationAction,
  sendAdminNotificationAction,
} from "../../../actions";
import {
  NotificationRetryButton,
  NotificationTestSendForm,
} from "../../../notification-forms";

export const metadata = { title: "Notifications" };

export const dynamic = "force-dynamic";

const statusBadgeClass: Record<string, string> = {
  PENDING: "bg-amber-100 text-amber-800",
  SUPPRESSED: "bg-neutral-100 text-neutral-600",
  ACCEPTED: "bg-green-100 text-green-800",
  FAILED: "bg-red-100 text-red-800",
};

const deliveryBadgeClass: Record<string, string> = {
  SENT: "bg-neutral-100 text-neutral-600",
  DELIVERED: "bg-green-100 text-green-800",
  READ: "bg-green-100 text-green-800",
  FAILED: "bg-red-100 text-red-800",
};

/**
 * WhatsApp destinations are phone numbers — higher-risk PII than the
 * member-record email admins already see. Show enough to disambiguate
 * (last 4 digits), not the dialable number.
 */
function destinationLabel(channel: string, destination: string | null) {
  if (!destination) return "no destination";
  if (channel === "WHATSAPP" && destination.length > 4) {
    return `WhatsApp ••••${destination.slice(-4)}`;
  }
  return destination;
}

export default async function OrganizationNotificationsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  // orgId from the URL is an untrusted selector — the grant comes from
  // the caller's OrganizationAccess rows.
  const ctx = await requireOrgCapabilityOrNotFound(
    orgId,
    OrgCapability.NOTIFICATIONS_MANAGE,
  );
  // Member pages need MEMBERS_MANAGE — degrade names to text for
  // notification-only managers (issue #90).
  const canViewMembers = hasOrgCapability(
    ctx,
    orgId,
    OrgCapability.MEMBERS_MANAGE,
  );
  // Callout titles and member responses are operational data gated by
  // OPERATIONS_MANAGE — a notification-only manager sees the delivery
  // facts without the linked callout detail.
  const canViewCallouts = hasOrgCapability(
    ctx,
    orgId,
    OrgCapability.OPERATIONS_MANAGE,
  );

  // The org exists — the admin grant already resolved it — so a missing
  // row here would be a genuine inconsistency.
  const [organization, notifications, members] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: orgId } }),
    listOrganizationNotifications(orgId),
    prisma.member.findMany({
      where: { organizationId: orgId, status: "ACTIVE" },
      orderBy: { displayName: "asc" },
      select: { id: true, displayName: true, email: true },
    }),
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
          Notifications
        </span>
      </nav>

      <section aria-labelledby="notifications-heading" className="mt-6">
        <h1
          id="notifications-heading"
          className="text-2xl font-semibold tracking-tight"
        >
          Notification delivery
        </h1>
        <p className="mt-1 text-sm text-neutral-600">
          A factual record of what SARbase was asked to send and what the
          provider reported. &quot;Accepted by provider&quot; means the provider
          took the message — it is not proof of delivery, and delivery state is
          never an operational-readiness conclusion.
        </p>
      </section>

      <section
        aria-labelledby="test-send-heading"
        className="mt-6 rounded-md border border-neutral-200 p-4"
      >
        <h2
          id="test-send-heading"
          className="text-sm font-medium text-neutral-800"
        >
          Send a test notification
        </h2>
        <p className="mt-1 text-sm text-neutral-600">
          Administrative testing only — verifies the delivery path. This is not
          a callout or operational alert.
        </p>
        <div className="mt-3">
          <NotificationTestSendForm
            action={sendAdminNotificationAction.bind(null, orgId)}
            members={members}
            idempotencyKey={crypto.randomUUID()}
          />
        </div>
      </section>

      <section aria-labelledby="history-heading" className="mt-8">
        <h2 id="history-heading" className="text-lg font-medium">
          History
        </h2>
        {notifications.length === 0 ? (
          <p className="mt-3 text-sm text-neutral-500">
            No notifications recorded yet.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-neutral-200 rounded-md border border-neutral-200">
            {notifications.map((notification) => {
              const latestAttempt = notification.attempts.at(-1);
              const retryable = isRetryableNotification(notification);
              const linkedInvitation = canViewCallouts
                ? notification.calloutInvitations[0]
                : undefined;
              const isAdminTest =
                notification.template === "admin_test" ||
                (notification.metadata as { source?: string } | null)
                  ?.source === "admin_test_send";
              return (
                <li key={notification.id} className="px-4 py-3 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium text-neutral-900">
                      {notification.member ? (
                        canViewMembers ? (
                          <Link
                            href={`/admin/organizations/${orgId}/members/${notification.member.id}`}
                            className="hover:underline"
                          >
                            {notification.member.displayName}
                          </Link>
                        ) : (
                          notification.member.displayName
                        )
                      ) : (
                        "Direct destination"
                      )}
                      <span className="ml-2 font-normal text-neutral-500">
                        {notification.channel.toLowerCase()}
                        {isAdminTest
                          ? " · admin test"
                          : ` · ${notification.template}`}
                      </span>
                    </span>
                    <span
                      className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${statusBadgeClass[notification.status] ?? "bg-neutral-100 text-neutral-600"}`}
                    >
                      {NOTIFICATION_STATUS_LABELS[notification.status] ??
                        notification.status}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-neutral-600">
                    <span>
                      {destinationLabel(
                        notification.channel,
                        notification.destination,
                      )}
                    </span>
                    <span className="text-neutral-400">
                      {" "}
                      · {notification.subject ?? "—"} ·{" "}
                      {relativeTimeLabel(notification.createdAt)}
                    </span>
                  </div>
                  {linkedInvitation && (
                    <p className="mt-1 text-xs text-neutral-600">
                      Callout:{" "}
                      <Link
                        href={`/admin/organizations/${orgId}/callouts/${linkedInvitation.callout.id}`}
                        className="font-medium text-neutral-800 hover:underline"
                      >
                        {linkedInvitation.callout.title}
                      </Link>
                      <span className="text-neutral-500">
                        {" "}
                        · member response:{" "}
                        {linkedInvitation.response
                          ? CALLOUT_RESPONSE_LABELS[linkedInvitation.response]
                          : "none"}
                      </span>
                    </p>
                  )}
                  {notification.statusReason && (
                    <p className="mt-1 text-xs text-neutral-600">
                      {SUPPRESSION_REASON_LABELS[notification.statusReason] ??
                        notification.statusReason}
                    </p>
                  )}
                  {latestAttempt?.status === "FAILED" &&
                    latestAttempt.errorSummary && (
                      <p className="mt-1 text-xs text-red-700">
                        {latestAttempt.errorSummary}
                      </p>
                    )}
                  <details className="mt-1">
                    <summary className="cursor-pointer text-xs font-medium text-neutral-600 hover:text-neutral-900">
                      {notification.attempts.length} attempt
                      {notification.attempts.length === 1 ? "" : "s"}
                    </summary>
                    <ul className="mt-1 space-y-1">
                      {notification.attempts.map((attempt) => (
                        <li
                          key={attempt.id}
                          className="rounded border border-neutral-100 bg-neutral-50 px-3 py-1.5 text-xs text-neutral-700"
                        >
                          <span className="font-medium">
                            #{attempt.attemptNumber}{" "}
                            {NOTIFICATION_ATTEMPT_STATUS_LABELS[
                              attempt.status
                            ] ?? attempt.status}
                          </span>
                          {attempt.deliveryStatus &&
                            NOTIFICATION_DELIVERY_STATUS_LABELS[
                              attempt.deliveryStatus
                            ] && (
                              <span
                                className={`ml-1 inline-block rounded-full px-2 py-0.5 font-medium ${deliveryBadgeClass[attempt.deliveryStatus] ?? "bg-neutral-100 text-neutral-600"}`}
                              >
                                {
                                  NOTIFICATION_DELIVERY_STATUS_LABELS[
                                    attempt.deliveryStatus
                                  ]
                                }
                              </span>
                            )}
                          <span className="text-neutral-500">
                            {" "}
                            · {attempt.provider} · attempted{" "}
                            {relativeTimeLabel(attempt.attemptedAt)}
                            {attempt.resolvedAt
                              ? ` · resolved ${relativeTimeLabel(attempt.resolvedAt)}`
                              : " · outcome not recorded"}
                          </span>
                          {attempt.providerMessageId && (
                            <span className="block text-neutral-500">
                              provider id {attempt.providerMessageId}
                            </span>
                          )}
                          {attempt.errorCode && (
                            <span className="block text-neutral-500">
                              {attempt.errorCode}
                              {attempt.retryable ? " · retryable" : ""}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </details>
                  {retryable && (
                    <div className="mt-2">
                      <NotificationRetryButton
                        action={retryNotificationAction.bind(
                          null,
                          notification.id,
                        )}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {notifications.length > 0 && (
          <p className="mt-2 text-xs text-neutral-500">
            Showing the {notifications.length} most recent notifications.
          </p>
        )}
      </section>
    </div>
  );
}
