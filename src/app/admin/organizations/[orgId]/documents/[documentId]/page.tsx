import Link from "next/link";
import { notFound } from "next/navigation";

import { isOrgAdmin, requireAuth } from "@/lib/auth/authorize";
import { getOrganizationDocument } from "@/lib/domain/attachments";
import { prisma } from "@/lib/prisma";
import { formatDateOnly, formatInstantInZone } from "@/lib/dates";

import {
  addDocumentVersionAction,
  deleteAttachmentAction,
  setOrganizationDocumentStatusAction,
  updateOrganizationDocumentAction,
} from "../../../../actions";
import {
  DeleteAttachmentForm,
  DocumentStatusButton,
  DocumentVersionUploadForm,
  OrganizationDocumentEditForm,
} from "../../../../attachment-forms";
import { formatBytes } from "../../../../attachment-section";

export const metadata = { title: "Document" };

export const dynamic = "force-dynamic";

/**
 * One organization document: metadata, append-only version history, and
 * per-version file management. Versions are never rewritten — uploading
 * a replacement appends the next versionNumber.
 */
export default async function OrganizationDocumentPage({
  params,
}: {
  params: Promise<{ orgId: string; documentId: string }>;
}) {
  const { orgId, documentId } = await params;
  const ctx = await requireAuth();

  const document = await getOrganizationDocument(documentId);
  // Opaque for foreign-org and fabricated ids alike.
  if (
    !document ||
    document.organizationId !== orgId ||
    !isOrgAdmin(ctx, orgId)
  ) {
    notFound();
  }

  const organization = await prisma.organization.findUniqueOrThrow({
    where: { id: orgId },
  });
  const tz = organization.timezone;

  // Audit labels: resolve uploader names for every version + event.
  const actorIds = [
    ...new Set(document.versions.flatMap((v) => [v.createdByAuthIdentityId])),
  ];
  const [identities, members] = await Promise.all([
    prisma.authIdentity.findMany({
      where: { id: { in: actorIds } },
      select: { id: true, email: true },
    }),
    prisma.member.findMany({
      where: { organizationId: orgId, authIdentityId: { in: actorIds } },
      select: { authIdentityId: true, displayName: true },
    }),
  ]);
  const nameByIdentity = new Map(
    members.map((m) => [m.authIdentityId, m.displayName]),
  );
  const emailByIdentity = new Map(identities.map((i) => [i.id, i.email]));
  const actorName = (id: string | null) =>
    id ? (nameByIdentity.get(id) ?? emailByIdentity.get(id) ?? id) : null;

  const updateAction = updateOrganizationDocumentAction.bind(null, document.id);
  const versionAction = addDocumentVersionAction.bind(null, document.id);
  const statusAction = setOrganizationDocumentStatusAction.bind(
    null,
    document.id,
    document.status === "ARCHIVED" ? "ACTIVE" : "ARCHIVED",
  );

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
        <Link
          href={`/admin/organizations/${orgId}/documents`}
          className="hover:underline"
        >
          Documents
        </Link>
        <span aria-hidden="true"> / </span>
        <span aria-current="page" className="text-neutral-800">
          {document.title}
        </span>
      </nav>

      <section aria-labelledby="document-heading" className="mt-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1
            id="document-heading"
            className="text-2xl font-semibold tracking-tight"
          >
            {document.title}
          </h1>
          <div className="flex items-center gap-2">
            {document.status === "ARCHIVED" && (
              <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600">
                Archived
              </span>
            )}
            <DocumentStatusButton
              action={statusAction}
              label={document.status === "ARCHIVED" ? "Restore" : "Archive"}
            />
          </div>
        </div>
        <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          {document.category && (
            <div>
              <dt className="inline text-neutral-500">Category: </dt>
              <dd className="inline">{document.category}</dd>
            </div>
          )}
          {document.effectiveOn && (
            <div>
              <dt className="inline text-neutral-500">Effective: </dt>
              <dd className="inline">{formatDateOnly(document.effectiveOn)}</dd>
            </div>
          )}
          {document.expiresOn && (
            <div>
              <dt className="inline text-neutral-500">Expires: </dt>
              <dd className="inline">{formatDateOnly(document.expiresOn)}</dd>
            </div>
          )}
          {document.notes && (
            <div className="sm:col-span-2">
              <dt className="inline text-neutral-500">Notes: </dt>
              <dd className="inline whitespace-pre-wrap">{document.notes}</dd>
            </div>
          )}
        </dl>
      </section>

      <section aria-labelledby="edit-heading" className="mt-8">
        <h2 id="edit-heading" className="text-lg font-medium">
          Details
        </h2>
        <div className="mt-3 max-w-lg">
          <OrganizationDocumentEditForm
            action={updateAction}
            defaults={{
              title: document.title,
              category: document.category,
              effectiveOn: formatDateOnly(document.effectiveOn),
              expiresOn: formatDateOnly(document.expiresOn),
              notes: document.notes,
            }}
          />
        </div>
      </section>

      <section aria-labelledby="versions-heading" className="mt-10">
        <h2 id="versions-heading" className="text-lg font-medium">
          Versions
        </h2>
        <p className="mt-1 text-sm text-neutral-600">
          The current file is the newest version. Earlier versions are preserved
          — replacing a document never overwrites history.
        </p>
        <ul className="mt-3 space-y-2">
          {document.versions.map((version) => {
            const attachment = version.attachment;
            const deleted = attachment.status === "DELETED";
            const isCurrent =
              version.versionNumber === document.versions[0]?.versionNumber;
            return (
              <li
                key={version.id}
                className="rounded-md border border-neutral-200 px-3 py-2"
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="text-xs font-medium text-neutral-500">
                    v{version.versionNumber}
                    {isCurrent && (
                      <span className="ml-1 rounded-full bg-green-100 px-2 py-0.5 text-green-800">
                        current
                      </span>
                    )}
                  </span>
                  {deleted ? (
                    <span className="text-sm text-neutral-500 line-through">
                      {attachment.displayFilename}
                    </span>
                  ) : (
                    <a
                      href={`/api/attachments/${attachment.id}/download`}
                      className="text-sm font-medium text-neutral-900 underline"
                    >
                      {attachment.displayFilename}
                    </a>
                  )}
                  <span className="text-xs text-neutral-500">
                    {formatBytes(attachment.sizeBytes)}
                  </span>
                  {deleted && (
                    <span className="text-xs font-medium text-red-700">
                      Deleted
                    </span>
                  )}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-500">
                  <span>
                    {formatInstantInZone(version.createdAt, tz)} ·{" "}
                    {actorName(version.createdByAuthIdentityId)}
                  </span>
                  {version.note && <span>— {version.note}</span>}
                  {!deleted && (
                    <DeleteAttachmentForm
                      action={deleteAttachmentAction.bind(null, attachment.id)}
                    />
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        {document.status === "ACTIVE" && (
          <div className="mt-4 max-w-md">
            <DocumentVersionUploadForm action={versionAction} />
          </div>
        )}
      </section>
    </main>
  );
}
