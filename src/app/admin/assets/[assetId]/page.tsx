import Link from "next/link";
import { notFound } from "next/navigation";

import {
  getAsset,
  listStorageLocations,
  listAssets,
} from "@/lib/domain/assets";
import { getOrganization } from "@/lib/domain/organization";
import { listUnits } from "@/lib/domain/unit";
import { formatDateOnly } from "@/lib/dates";
import { requireAuth, isOrgAdmin } from "@/lib/auth/authorize";

import { updateAssetAction } from "../../actions";
import { AssetForm } from "../../asset-forms";

export const metadata = { title: "Asset" };

export const dynamic = "force-dynamic";

const STATUS_LABELS: Record<string, string> = {
  INACTIVE: "Inactive",
  OUT_OF_SERVICE: "Out of service",
  RETIRED: "Retired",
};
const CONDITION_LABELS: Record<string, string> = {
  UNKNOWN: "Unknown",
  GOOD: "Good",
  FAIR: "Fair",
  DAMAGED: "Damaged",
};

export default async function AssetPage({
  params,
}: {
  params: Promise<{ assetId: string }>;
}) {
  const ctx = await requireAuth();
  const { assetId } = await params;
  // assetId is an untrusted selector — resolve the record, then check
  // ADMIN access to the asset's REAL organizationId.
  const asset = await getAsset(assetId);
  if (!asset || !isOrgAdmin(ctx, asset.organizationId)) notFound();

  const orgId = asset.organizationId;
  const [organization, units, locations, siblings] = await Promise.all([
    getOrganization(orgId),
    listUnits(orgId),
    listStorageLocations(orgId),
    listAssets(orgId, { includeRetired: true }),
  ]);
  if (!organization) notFound();

  const locationPath = asset.storageLocationId
    ? locations.find((l) => l.id === asset.storageLocationId)?.path
    : undefined;

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
        <Link
          href={`/admin/organizations/${orgId}/assets`}
          className="hover:underline"
        >
          Assets
        </Link>
        <span aria-hidden="true"> / </span>
        <span aria-current="page" className="text-neutral-800">
          {asset.name}
        </span>
      </nav>

      <section aria-labelledby="asset-heading" className="mt-6">
        <div className="flex items-center justify-between gap-4">
          <h1
            id="asset-heading"
            className="text-2xl font-semibold tracking-tight"
          >
            {asset.name}
          </h1>
          {asset.status !== "ACTIVE" && (
            <span className="inline-block rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-600">
              {STATUS_LABELS[asset.status]}
            </span>
          )}
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm text-neutral-700 sm:grid-cols-3">
          <div>
            <dt className="text-xs text-neutral-500">Category</dt>
            <dd>{asset.category ?? "Not recorded"}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">Manufacturer</dt>
            <dd>{asset.manufacturer ?? "Not recorded"}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">Model</dt>
            <dd>{asset.model ?? "Not recorded"}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">Serial number</dt>
            <dd>{asset.serialNumber ?? "Not recorded"}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">Asset tag</dt>
            <dd>{asset.assetTag ?? "Not recorded"}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">Purchased</dt>
            <dd>
              {asset.purchaseDate
                ? formatDateOnly(asset.purchaseDate)
                : "Not recorded"}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">Vendor</dt>
            <dd>{asset.vendor ?? "Not recorded"}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">Unit</dt>
            <dd>{asset.unit?.name ?? "Organization-wide"}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">Stored in</dt>
            <dd>{locationPath ?? "No recorded location"}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">Part of</dt>
            <dd>
              {asset.parentAsset ? (
                <Link
                  href={`/admin/assets/${asset.parentAsset.id}`}
                  className="hover:underline"
                >
                  {asset.parentAsset.name}
                </Link>
              ) : (
                "Standalone"
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">Recorded condition</dt>
            <dd>{CONDITION_LABELS[asset.condition]}</dd>
          </div>
        </dl>
        {asset.notes && (
          <p className="mt-3 text-sm text-neutral-600">
            <span className="font-medium">Notes: </span>
            {asset.notes}
          </p>
        )}
      </section>

      {(asset.childAssets.length > 0 ||
        asset.containedLocations.length > 0) && (
        <section aria-labelledby="contains-heading" className="mt-8">
          <h2 id="contains-heading" className="text-lg font-medium">
            What this asset contains
          </h2>
          {asset.childAssets.length > 0 && (
            <ul className="mt-2 space-y-1 text-sm">
              {asset.childAssets.map((child) => (
                <li key={child.id}>
                  <Link
                    href={`/admin/assets/${child.id}`}
                    className="text-neutral-800 hover:underline"
                  >
                    {child.name}
                  </Link>
                  <span className="text-neutral-500">
                    {[
                      child.category && ` — ${child.category}`,
                      child.status !== "ACTIVE" &&
                        ` (${(STATUS_LABELS[child.status] ?? child.status).toLowerCase()})`,
                    ]
                      .filter(Boolean)
                      .join("")}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {asset.containedLocations.length > 0 && (
            <p className="mt-2 text-sm text-neutral-600">
              Storage locations inside:{" "}
              {asset.containedLocations.map((l) => l.name).join(", ")}
            </p>
          )}
        </section>
      )}

      <section aria-labelledby="edit-heading" className="mt-8">
        <details className="rounded-md border border-neutral-200 p-4">
          <summary
            id="edit-heading"
            className="cursor-pointer text-sm font-medium text-neutral-800"
          >
            Edit asset
          </summary>
          <div className="mt-3">
            <AssetForm
              action={updateAssetAction.bind(null, asset.id)}
              units={units}
              locationOptions={locations.map((l) => ({
                id: l.id,
                path: l.path,
              }))}
              parentOptions={siblings
                .filter((a) => a.id !== asset.id)
                .map((a) => ({ id: a.id, name: a.name }))}
              defaults={{
                name: asset.name,
                category: asset.category,
                manufacturer: asset.manufacturer,
                model: asset.model,
                serialNumber: asset.serialNumber,
                assetTag: asset.assetTag,
                purchaseDate: formatDateOnly(asset.purchaseDate),
                vendor: asset.vendor,
                unitId: asset.unitId,
                parentAssetId: asset.parentAssetId,
                storageLocationId: asset.storageLocationId,
                condition: asset.condition,
                status: asset.status,
                notes: asset.notes,
              }}
              submitLabel="Save asset"
            />
          </div>
        </details>
      </section>
    </main>
  );
}
