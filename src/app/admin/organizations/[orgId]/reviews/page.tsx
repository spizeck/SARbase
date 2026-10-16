import Link from "next/link";
import { notFound } from "next/navigation";

import { getOrganization } from "@/lib/domain/organization";
import {
  listOrganizationSubmissions,
  MEMBER_SUBMISSION_KIND_LABELS,
  MEMBER_SUBMISSION_STATUS_LABELS,
} from "@/lib/domain/submissions";
import { resolveActorLabels } from "@/lib/domain/actors";
import { requireOrgAdminOrNotFound } from "@/lib/auth/authorize";
import { formatDateOnly, relativeTimeLabel } from "@/lib/dates";
import { formatBytes } from "@/app/admin/attachment-section";

import { reviewMemberSubmissionAction } from "../../../actions";
import { SubmissionReviewForm } from "../../../submission-forms";

export const metadata = { title: "Submissions" };

export const dynamic = "force-dynamic";

/**
 * Member submission review queue (issue #71). Members file
 * qualification claims and record corrections from /account; nothing
 * they submit touches a verified record until an org ADMIN approves it
 * here. Rejections must carry a note — the member sees it verbatim.
 */
export default async function ReviewsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  await requireOrgAdminOrNotFound(orgId);
  const organization = await getOrganization(orgId);
  if (!organization) notFound();

  const { pending, reviewed } = await listOrganizationSubmissions(orgId);

  const submitterLabels = await resolveActorLabels(
    orgId,
    [...pending, ...reviewed].flatMap((s) => [
      s.submittedByAuthIdentityId,
      s.reviewedByAuthIdentityId,
    ]),
  );
  const actorName = (id: string | null) =>
    id ? (submitterLabels.get(id) ?? id) : null;

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
          Submissions
        </span>
      </nav>

      <h1 className="mt-4 text-lg font-semibold text-neutral-900">
        Member submissions
      </h1>
      <p className="mt-1 text-sm text-neutral-600">
        Qualification evidence and record corrections filed by members.
        Approving a qualification claim creates the verified record; nothing a
        member submits changes records until you accept it.
      </p>

      <section aria-labelledby="pending-heading" className="mt-6">
        <h2
          id="pending-heading"
          className="text-sm font-medium text-neutral-800"
        >
          Awaiting review ({pending.length})
        </h2>
        {pending.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-600">
            No submissions are waiting for review.
          </p>
        ) : (
          <ul className="mt-3 space-y-4">
            {pending.map((submission) => (
              <li
                key={submission.id}
                className="rounded-md border border-neutral-200 p-4"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <h3 className="text-sm font-medium text-neutral-900">
                    {MEMBER_SUBMISSION_KIND_LABELS[submission.kind]}
                    {submission.qualificationDefinition
                      ? ` — ${submission.qualificationDefinition.name}`
                      : ""}
                  </h3>
                  <span className="text-xs text-neutral-500">
                    {relativeTimeLabel(submission.createdAt)}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-neutral-500">
                  From{" "}
                  <Link
                    href={`/admin/organizations/${orgId}/members/${submission.member.id}`}
                    className="font-medium text-neutral-700 underline"
                  >
                    {submission.member.displayName}
                  </Link>
                  {" · "}
                  {actorName(submission.submittedByAuthIdentityId)
                    ? `signed in as ${actorName(submission.submittedByAuthIdentityId)}`
                    : "self-reported"}
                </p>
                <p className="mt-2 whitespace-pre-line text-sm text-neutral-800">
                  {submission.details}
                </p>
                {submission.kind === "QUALIFICATION_CLAIM" && (
                  <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-xs text-neutral-600 sm:grid-cols-2">
                    {submission.issuedOn && (
                      <div>
                        <dt className="inline font-medium">Issued: </dt>
                        <dd className="inline">
                          {formatDateOnly(submission.issuedOn)}
                        </dd>
                      </div>
                    )}
                    {submission.expiresOn && (
                      <div>
                        <dt className="inline font-medium">Expires: </dt>
                        <dd className="inline">
                          {formatDateOnly(submission.expiresOn)}
                        </dd>
                      </div>
                    )}
                    {submission.issuer && (
                      <div>
                        <dt className="inline font-medium">Issuer: </dt>
                        <dd className="inline">{submission.issuer}</dd>
                      </div>
                    )}
                    {submission.reference && (
                      <div>
                        <dt className="inline font-medium">Reference: </dt>
                        <dd className="inline">{submission.reference}</dd>
                      </div>
                    )}
                  </dl>
                )}
                {submission.targetMemberQualification && (
                  <p className="mt-2 text-xs text-neutral-600">
                    Concerns record:{" "}
                    <span className="font-medium">
                      {submission.targetMemberQualification.definition.name}
                    </span>
                  </p>
                )}
                {submission.attachments.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {submission.attachments.map((link) => {
                      const attachment = link.attachment;
                      const cleared =
                        attachment.status === "ACTIVE" &&
                        (attachment.storageProvider !== "s3" ||
                          attachment.scanStatus === "CLEAN");
                      return (
                        <li key={link.id} className="text-xs">
                          {cleared ? (
                            <a
                              href={`/api/attachments/${attachment.id}/download`}
                              className="font-medium text-neutral-900 underline"
                            >
                              {attachment.displayFilename}
                            </a>
                          ) : (
                            <span className="text-neutral-600">
                              {attachment.displayFilename}
                              {attachment.status === "ACTIVE"
                                ? " (scan pending)"
                                : " (deleted)"}
                            </span>
                          )}
                          <span className="text-neutral-500">
                            {" "}
                            · {formatBytes(attachment.sizeBytes)}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
                <div className="mt-3 border-t border-neutral-200 pt-3">
                  <SubmissionReviewForm
                    action={reviewMemberSubmissionAction.bind(
                      null,
                      submission.id,
                    )}
                    idPrefix={`review-${submission.id}`}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="reviewed-heading" className="mt-8">
        <h2
          id="reviewed-heading"
          className="text-sm font-medium text-neutral-800"
        >
          Recently reviewed
        </h2>
        {reviewed.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-600">
            No reviewed submissions yet.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-neutral-200 rounded-md border border-neutral-200">
            {reviewed.map((submission) => (
              <li key={submission.id} className="px-4 py-3 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span className="font-medium text-neutral-900">
                    {MEMBER_SUBMISSION_KIND_LABELS[submission.kind]}
                    {submission.qualificationDefinition
                      ? ` — ${submission.qualificationDefinition.name}`
                      : ""}
                    <span className="font-normal text-neutral-500">
                      {" "}
                      · {submission.member.displayName}
                    </span>
                  </span>
                  <span
                    className={`text-xs font-medium ${
                      submission.status === "APPROVED"
                        ? "text-green-800"
                        : "text-red-700"
                    }`}
                  >
                    {MEMBER_SUBMISSION_STATUS_LABELS[submission.status]}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-neutral-500">
                  Reviewed{" "}
                  {submission.reviewedAt
                    ? relativeTimeLabel(submission.reviewedAt)
                    : ""}
                  {actorName(submission.reviewedByAuthIdentityId)
                    ? ` by ${actorName(submission.reviewedByAuthIdentityId)}`
                    : ""}
                  {submission.reviewNote ? ` — “${submission.reviewNote}”` : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
