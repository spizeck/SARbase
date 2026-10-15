import Link from "next/link";
import { notFound } from "next/navigation";

import { getOrganization } from "@/lib/domain/organization";
import { listQualificationDefinitions } from "@/lib/domain/qualification";
import { requireOrgAdminOrNotFound } from "@/lib/auth/authorize";

import {
  createQualificationDefinitionAction,
  updateQualificationDefinitionAction,
  setQualificationDefinitionStatusAction,
} from "../../../actions";
import { QualificationDefinitionForm } from "../../../forms";

export const metadata = { title: "Qualifications" };

export const dynamic = "force-dynamic";

export default async function QualificationsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  await requireOrgAdminOrNotFound(orgId);
  const organization = await getOrganization(orgId);
  if (!organization) notFound();

  const definitions = await listQualificationDefinitions(orgId, {
    includeInactive: true,
  });

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
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
          Qualifications
        </span>
      </nav>

      <h1 className="mt-4 text-lg font-semibold text-neutral-900">
        Qualifications
      </h1>
      <p className="mt-1 text-sm text-neutral-600">
        The qualifications and certifications this organization tracks.
        Deactivating stops new assignments; existing member records are
        preserved.
      </p>

      {definitions.length === 0 ? (
        <p className="mt-4 text-sm text-neutral-500">
          No qualifications defined yet.
        </p>
      ) : (
        <ul className="mt-4 space-y-2">
          {definitions.map((def) => (
            <li
              key={def.id}
              className="rounded-md border border-neutral-200 p-3"
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <span className="text-sm font-medium text-neutral-900">
                    {def.name}
                  </span>
                  <span className="ml-2 text-xs text-neutral-500">
                    {def._count.memberQualifications} record
                    {def._count.memberQualifications === 1 ? "" : "s"}
                  </span>
                  {def.status === "INACTIVE" && (
                    <span className="ml-2 inline-block rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-600">
                      Inactive
                    </span>
                  )}
                </div>
                <form
                  action={setQualificationDefinitionStatusAction.bind(
                    null,
                    def.id,
                    def.status === "ACTIVE" ? "INACTIVE" : "ACTIVE",
                  )}
                >
                  <button
                    type="submit"
                    className="rounded-md border border-neutral-300 px-3 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
                  >
                    {def.status === "ACTIVE" ? "Deactivate" : "Reactivate"}
                  </button>
                </form>
              </div>
              {def.description && (
                <p className="mt-1 text-sm text-neutral-600">
                  {def.description}
                </p>
              )}
              <details className="mt-2">
                <summary className="cursor-pointer text-xs font-medium text-neutral-600 hover:text-neutral-900">
                  Edit
                </summary>
                <div className="mt-2">
                  <QualificationDefinitionForm
                    action={updateQualificationDefinitionAction.bind(
                      null,
                      def.id,
                    )}
                    defaults={{
                      name: def.name,
                      description: def.description,
                    }}
                    submitLabel="Save changes"
                  />
                </div>
              </details>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 rounded-md border border-neutral-200 p-4">
        <h2 className="text-sm font-medium text-neutral-800">
          New qualification
        </h2>
        <div className="mt-2">
          <QualificationDefinitionForm
            action={createQualificationDefinitionAction.bind(null, orgId)}
            submitLabel="Add qualification"
          />
        </div>
      </div>
    </div>
  );
}
