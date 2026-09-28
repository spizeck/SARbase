import Link from "next/link";
import { notFound } from "next/navigation";

import { getOrganization } from "@/lib/domain/organization";
import {
  listAssets,
  listStorageLocations,
  locationPathMap,
} from "@/lib/domain/assets";
import { requireOrgAdminOrNotFound } from "@/lib/auth/authorize";

import { createAssetAction } from "../../../actions";
import { AssetForm } from "../../../asset-forms";

export const metadata = { title: "Assets" };

export const dynamic = "force-dynamic";

const STATUS_LABELS: Record<string, string> = {
  INACTIVE: "Inactive",
  OUT_OF_SERVICE: "Out of service",
  RETIRED: "Retired",
};

export default async function AssetsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{
    unit?: string;
    location?: string;
    retired?: string;
  }>;
}) {
  const { orgId } = await params;
  // Untrusted URL selector — grant is checked against the real org.
  await requireOrgAdminOrNotFound(orgId);
  const organization = await getOrganization(orgId);
  if (!organization) notFound();

  const {
    unit: unitFilter,
    location: locationFilter,
    retired,
  } = await searchParams;

  // Filter values are untrusted selectors. A unit/location id that is
  // not this organization's simply matches zero rows — the composite
  // FKs make a foreign id impossible on a record, so filtering can
  // never widen scope.
  const filterUnit = unitFilter
    ? organization.units.find((u) => u.id === unitFilter)
    : undefined;
  const unitId =
    unitFilter === "org" ? null : filterUnit ? filterUnit.id : undefined;
  const showRetired = retired === "1";

  const [assets, allAssets, locations, paths] = await Promise.all([
    listAssets(orgId, {
      unitId,
      storageLocationId: locationFilter || undefined,
      includeRetired: showRetired,
    }),
    // Parent options for the create form are the full catalog — the
    // list filters above shouldn't narrow what an asset can be part of.
    listAssets(orgId, { includeRetired: true }),
    listStorageLocations(orgId),
    locationPathMap(orgId),
  ]);

  const base = `/admin/organizations/${orgId}/assets`;
  const pageQuery = (overrides: Record<string, string | undefined>) => {
    const merged: Record<string, string | undefined> = {
      unit: unitFilter,
      location: locationFilter,
      retired: showRetired ? "1" : undefined,
      ...overrides,
    };
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(merged)) if (v) qs.set(k, v);
    const s = qs.toString();
    return s ? `${base}?${s}` : base;
  };

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
          Assets
        </span>
      </nav>

      <section aria-labelledby="assets-heading" className="mt-6">
        <h1
          id="assets-heading"
          className="text-2xl font-semibold tracking-tight"
        >
          Assets
        </h1>
        <p className="mt-1 text-sm text-neutral-600">
          Durable, individually identifiable equipment — boats, engines, radios,
          AEDs. Status and condition are recorded facts; SARbase does not infer
          readiness or safety from them.
        </p>

        {/* Filters — same preserved-params pattern as training. */}
        <nav aria-label="Filter assets by unit" className="mt-3 text-sm">
          <Link
            href={pageQuery({ unit: undefined })}
            className={`mr-3 hover:underline ${!unitFilter ? "font-medium text-neutral-900" : "text-neutral-500"}`}
          >
            All units
          </Link>
          <Link
            href={pageQuery({ unit: "org" })}
            className={`mr-3 hover:underline ${unitFilter === "org" ? "font-medium text-neutral-900" : "text-neutral-500"}`}
          >
            Organization-wide
          </Link>
          {organization.units.map((u) => (
            <Link
              key={u.id}
              href={pageQuery({ unit: u.id })}
              className={`mr-3 hover:underline ${unitFilter === u.id ? "font-medium text-neutral-900" : "text-neutral-500"}`}
            >
              {u.name}
            </Link>
          ))}
        </nav>
        <form method="get" className="mt-3 flex flex-wrap items-end gap-3">
          {unitFilter && <input type="hidden" name="unit" value={unitFilter} />}
          <div>
            <label
              htmlFor="asset-location-filter"
              className="block text-xs font-medium text-neutral-600"
            >
              Location
            </label>
            <select
              id="asset-location-filter"
              name="location"
              defaultValue={locationFilter ?? ""}
              className="mt-1 block rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
            >
              <option value="">All locations</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.path}
                </option>
              ))}
            </select>
          </div>
          <label className="flex items-center gap-2 pb-1.5 text-sm text-neutral-700">
            <input
              type="checkbox"
              name="retired"
              value="1"
              defaultChecked={showRetired}
              className="h-4 w-4 rounded border-neutral-300"
            />
            Include retired
          </label>
          <button
            type="submit"
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-800 hover:bg-neutral-50"
          >
            Apply
          </button>
        </form>

        {assets.length === 0 ? (
          <p className="mt-4 text-sm text-neutral-500">
            No assets match this view.
          </p>
        ) : (
          <ul className="mt-4 space-y-2">
            {assets.map((asset) => (
              <li
                key={asset.id}
                className="rounded-md border border-neutral-200 p-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <Link
                      href={`/admin/assets/${asset.id}`}
                      className="font-medium text-neutral-900 hover:underline"
                    >
                      {asset.name}
                    </Link>
                    <p className="mt-0.5 text-xs text-neutral-500">
                      {[
                        asset.category,
                        asset.assetTag && `tag ${asset.assetTag}`,
                        asset.unit?.name,
                        asset.storageLocationId &&
                          paths.get(asset.storageLocationId),
                        asset.parentAsset &&
                          `part of ${asset.parentAsset.name}`,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </div>
                  {asset.status !== "ACTIVE" && (
                    <span className="inline-block shrink-0 rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-600">
                      {STATUS_LABELS[asset.status]}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        <details className="mt-3 rounded-md border border-neutral-200 p-4">
          <summary className="cursor-pointer text-sm font-medium text-neutral-800">
            Add an asset
          </summary>
          <div className="mt-3">
            <AssetForm
              action={createAssetAction.bind(null, orgId)}
              units={organization.units}
              locationOptions={locations.map((l) => ({
                id: l.id,
                path: l.path,
              }))}
              parentOptions={allAssets.map((a) => ({ id: a.id, name: a.name }))}
              submitLabel="Save asset"
            />
          </div>
        </details>
      </section>
    </main>
  );
}
