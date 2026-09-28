import Link from "next/link";
import { notFound } from "next/navigation";

import { getOrganization } from "@/lib/domain/organization";
import { listStorageLocations, listAssets } from "@/lib/domain/assets";
import { requireOrgAdminOrNotFound } from "@/lib/auth/authorize";

import {
  createStorageLocationAction,
  updateStorageLocationAction,
} from "../../../actions";
import { StorageLocationForm } from "../../../asset-forms";

export const metadata = { title: "Storage locations" };

export const dynamic = "force-dynamic";

export default async function StorageLocationsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  // Untrusted URL selector — grant is checked against the real org.
  await requireOrgAdminOrNotFound(orgId);
  const organization = await getOrganization(orgId);
  if (!organization) notFound();

  const locations = await listStorageLocations(orgId);
  const assets = await listAssets(orgId, { includeRetired: true });
  const assetOptions = assets.map((a) => ({ id: a.id, name: a.name }));

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
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
          Storage locations
        </span>
      </nav>

      <section aria-labelledby="locations-heading" className="mt-6">
        <h1
          id="locations-heading"
          className="text-2xl font-semibold tracking-tight"
        >
          Storage locations
        </h1>
        <p className="mt-1 text-sm text-neutral-600">
          Places equipment is stored — buildings, rooms, shelves, or lockers
          inside a vessel. A location can sit inside another location or inside
          an asset such as a boat. Archiving a location keeps it on the record;
          nothing is deleted.
        </p>

        {locations.length === 0 ? (
          <p className="mt-4 text-sm text-neutral-500">
            No storage locations recorded yet.
          </p>
        ) : (
          <ul className="mt-4 space-y-2">
            {locations.map((loc) => (
              <li
                key={loc.id}
                className="rounded-md border border-neutral-200 p-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-medium text-neutral-900">{loc.path}</p>
                    <p className="mt-0.5 text-xs text-neutral-500">
                      {loc._count.storedAssets} asset
                      {loc._count.storedAssets === 1 ? "" : "s"},{" "}
                      {loc._count.inventoryItems} item
                      {loc._count.inventoryItems === 1 ? "" : "s"}
                      {loc._count.childLocations > 0 &&
                        `, ${loc._count.childLocations} sub-location${loc._count.childLocations === 1 ? "" : "s"}`}
                      {loc.description && ` — ${loc.description}`}
                    </p>
                  </div>
                  {loc.status === "ARCHIVED" && (
                    <span className="inline-block shrink-0 rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-600">
                      Archived
                    </span>
                  )}
                </div>
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs font-medium text-neutral-600 hover:text-neutral-900">
                    Edit location
                  </summary>
                  <div className="mt-2">
                    <StorageLocationForm
                      formId={loc.id}
                      action={updateStorageLocationAction.bind(null, loc.id)}
                      locationOptions={locations
                        .filter((l) => l.id !== loc.id)
                        .map((l) => ({ id: l.id, path: l.path }))}
                      assetOptions={assetOptions}
                      defaults={{
                        name: loc.name,
                        description: loc.description,
                        container: loc.parentLocationId
                          ? `location:${loc.parentLocationId}`
                          : loc.containingAssetId
                            ? `asset:${loc.containingAssetId}`
                            : "",
                        status: loc.status,
                      }}
                      submitLabel="Save location"
                    />
                  </div>
                </details>
              </li>
            ))}
          </ul>
        )}

        <details className="mt-3 rounded-md border border-neutral-200 p-4">
          <summary className="cursor-pointer text-sm font-medium text-neutral-800">
            Add a storage location
          </summary>
          <div className="mt-3">
            <StorageLocationForm
              formId="new"
              action={createStorageLocationAction.bind(null, orgId)}
              locationOptions={locations.map((l) => ({
                id: l.id,
                path: l.path,
              }))}
              assetOptions={assetOptions}
              submitLabel="Save location"
            />
          </div>
        </details>
      </section>
    </main>
  );
}
