import Link from "next/link";
import { notFound } from "next/navigation";

import { getOrganization } from "@/lib/domain/organization";
import {
  listInventoryItems,
  listStorageLocations,
  locationPathMap,
} from "@/lib/domain/assets";
import { requireOrgAdminOrNotFound } from "@/lib/auth/authorize";

import {
  createInventoryItemAction,
  updateInventoryItemAction,
} from "../../../actions";
import { InventoryItemForm } from "../../../asset-forms";

export const metadata = { title: "Inventory" };

export const dynamic = "force-dynamic";

const CONDITION_LABELS: Record<string, string> = {
  GOOD: "Good",
  FAIR: "Fair",
  DAMAGED: "Damaged",
};

export default async function InventoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ location?: string; archived?: string }>;
}) {
  const { orgId } = await params;
  // Untrusted URL selector — grant is checked against the real org.
  await requireOrgAdminOrNotFound(orgId);
  const organization = await getOrganization(orgId);
  if (!organization) notFound();

  const { location: locationFilter, archived } = await searchParams;
  // A foreign/fabricated location id simply matches zero rows.
  const showArchived = archived === "1";

  const [items, locations, paths] = await Promise.all([
    listInventoryItems(orgId, {
      storageLocationId: locationFilter || undefined,
      includeArchived: showArchived,
    }),
    listStorageLocations(orgId),
    locationPathMap(orgId),
  ]);

  const base = `/admin/organizations/${orgId}/inventory`;

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
          Inventory
        </span>
      </nav>

      <section aria-labelledby="inventory-heading" className="mt-6">
        <h1
          id="inventory-heading"
          className="text-2xl font-semibold tracking-tight"
        >
          Inventory
        </h1>
        <p className="mt-1 text-sm text-neutral-600">
          Quantity-tracked stock — rope, flares, gloves, batteries, consumables.
          A quantity here is a recorded count, not a judgement that supplies are
          sufficient.
        </p>

        <form method="get" className="mt-3 flex flex-wrap items-end gap-3">
          <div>
            <label
              htmlFor="item-location-filter"
              className="block text-xs font-medium text-neutral-600"
            >
              Location
            </label>
            <select
              id="item-location-filter"
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
              name="archived"
              value="1"
              defaultChecked={showArchived}
              className="h-4 w-4 rounded border-neutral-300"
            />
            Include archived
          </label>
          <button
            type="submit"
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-800 hover:bg-neutral-50"
          >
            Apply
          </button>
          {(locationFilter || showArchived) && (
            <Link
              href={base}
              className="pb-1.5 text-sm text-neutral-500 hover:underline"
            >
              Clear
            </Link>
          )}
        </form>

        {items.length === 0 ? (
          <p className="mt-4 text-sm text-neutral-500">
            No inventory items match this view.
          </p>
        ) : (
          <ul className="mt-4 space-y-2">
            {items.map((item) => (
              <li
                key={item.id}
                className="rounded-md border border-neutral-200 p-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-medium text-neutral-900">{item.name}</p>
                    <p className="mt-0.5 text-xs text-neutral-500">
                      {[
                        `${item.quantity} ${item.unitOfMeasure ?? ""}`.trim(),
                        item.category,
                        item.unit?.name,
                        item.storageLocationId &&
                          paths.get(item.storageLocationId),
                        item.vendor,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1.5">
                    {item.condition !== "UNKNOWN" && (
                      <span className="inline-block rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-600">
                        {CONDITION_LABELS[item.condition]}
                      </span>
                    )}
                    {item.status === "ARCHIVED" && (
                      <span className="inline-block rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-600">
                        Archived
                      </span>
                    )}
                  </div>
                </div>
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs font-medium text-neutral-600 hover:text-neutral-900">
                    Edit item
                  </summary>
                  <div className="mt-2">
                    <InventoryItemForm
                      formId={item.id}
                      action={updateInventoryItemAction.bind(null, item.id)}
                      units={organization.units}
                      locationOptions={locations.map((l) => ({
                        id: l.id,
                        path: l.path,
                      }))}
                      defaults={{
                        name: item.name,
                        category: item.category,
                        quantity: item.quantity.toString(),
                        unitOfMeasure: item.unitOfMeasure,
                        vendor: item.vendor,
                        unitId: item.unitId,
                        storageLocationId: item.storageLocationId,
                        condition: item.condition,
                        status: item.status,
                        notes: item.notes,
                      }}
                      submitLabel="Save item"
                    />
                  </div>
                </details>
              </li>
            ))}
          </ul>
        )}

        <details className="mt-3 rounded-md border border-neutral-200 p-4">
          <summary className="cursor-pointer text-sm font-medium text-neutral-800">
            Add an inventory item
          </summary>
          <div className="mt-3">
            <InventoryItemForm
              formId="new"
              action={createInventoryItemAction.bind(null, orgId)}
              units={organization.units}
              locationOptions={locations.map((l) => ({
                id: l.id,
                path: l.path,
              }))}
              submitLabel="Save item"
            />
          </div>
        </details>
      </section>
    </main>
  );
}
