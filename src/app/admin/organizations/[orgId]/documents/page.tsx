import Link from "next/link";

import { prisma } from "@/lib/prisma";
import { requireOrgAdminOrNotFound } from "@/lib/auth/authorize";
import { listOrganizationDocuments } from "@/lib/domain/attachments";
import { formatDateOnly } from "@/lib/dates";

import { createOrganizationDocumentAction } from "../../../actions";
import { OrganizationDocumentCreateForm } from "../../../attachment-forms";
import { formatBytes } from "../../../attachment-section";

export const metadata = { title: "Documents" };

export const dynamic = "force-dynamic";

/**
 * Organization-level documents (issue #16): SOPs, manuals, insurance,
 * registrations, policies — records owned by the organization rather
 * than one operational record. ADMIN-only like the rest of this
 * surface; each entry links to its detail page for version history.
 */
export default async function OrganizationDocumentsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  // orgId from the URL is an untrusted selector — the grant comes from
  // the caller's OrganizationAccess rows.
  await requireOrgAdminOrNotFound(orgId);

  const [organization, documents] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: orgId } }),
    listOrganizationDocuments(orgId),
  ]);

  const active = documents.filter((d) => d.status === "ACTIVE");
  const archived = documents.filter((d) => d.status === "ARCHIVED");

  const createAction = createOrganizationDocumentAction.bind(null, orgId);

  const renderRow = (document: (typeof documents)[number], dimmed: boolean) => {
    const current = document.versions[0];
    return (
      <li key={document.id} className="px-4 py-3 text-sm">
        <div className="flex items-center justify-between gap-3">
          <Link
            href={`/admin/organizations/${orgId}/documents/${document.id}`}
            className={`font-medium hover:underline ${
              dimmed ? "text-neutral-500" : "text-neutral-900"
            }`}
          >
            {document.title}
          </Link>
          {document.category && (
            <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600">
              {document.category}
            </span>
          )}
        </div>
        <div className="mt-1 flex flex-wrap gap-x-4 text-xs text-neutral-500">
          {current && (
            <span>
              v{current.versionNumber} · {current.attachment.displayFilename} (
              {formatBytes(current.attachment.sizeBytes)})
            </span>
          )}
          <span>
            {document._count.versions} version
            {document._count.versions === 1 ? "" : "s"}
          </span>
          {document.expiresOn && (
            <span>Expires {formatDateOnly(document.expiresOn)}</span>
          )}
          {dimmed && <span className="text-neutral-500">Archived</span>}
        </div>
      </li>
    );
  };

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
          Documents
        </span>
      </nav>

      <section aria-labelledby="documents-heading" className="mt-6">
        <h1
          id="documents-heading"
          className="text-2xl font-semibold tracking-tight"
        >
          Documents
        </h1>
        <p className="mt-1 text-sm text-neutral-600">
          Organizational records — policies, SOPs, manuals, registrations,
          insurance. Files are documentary records; SARbase stores and serves
          them but does not interpret their contents.
        </p>
      </section>

      {documents.length === 0 ? (
        <p className="mt-6 text-sm text-neutral-500">
          No documents recorded yet.
        </p>
      ) : (
        <>
          <ul className="mt-6 divide-y divide-neutral-200 rounded-md border border-neutral-200">
            {active.map((d) => renderRow(d, false))}
          </ul>
          {archived.length > 0 && (
            <section aria-labelledby="archived-heading" className="mt-8">
              <h2
                id="archived-heading"
                className="text-sm font-medium text-neutral-600"
              >
                Archived
              </h2>
              <ul className="mt-2 divide-y divide-neutral-200 rounded-md border border-neutral-200">
                {archived.map((d) => renderRow(d, true))}
              </ul>
            </section>
          )}
        </>
      )}

      <section aria-labelledby="add-document-heading" className="mt-10">
        <h2 id="add-document-heading" className="text-lg font-medium">
          Add a document
        </h2>
        <div className="mt-3 max-w-lg">
          <OrganizationDocumentCreateForm action={createAction} />
        </div>
      </section>
    </main>
  );
}
