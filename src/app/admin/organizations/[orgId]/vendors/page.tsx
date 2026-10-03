import Link from "next/link";

import { prisma } from "@/lib/prisma";
import { requireOrgAdminOrNotFound } from "@/lib/auth/authorize";
import {
  listOrganizationVendors,
  VENDOR_STATUS_LABELS,
} from "@/lib/domain/expenses";

import {
  createVendorAction,
  updateVendorAction,
  setVendorStatusAction,
} from "../../../actions";
import { VendorForm, VendorStatusButton } from "../../../vendor-forms";

export const metadata = { title: "Vendors" };

export const dynamic = "force-dynamic";

export default async function OrganizationVendorsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  // orgId from the URL is an untrusted selector — the grant comes from
  // the caller's OrganizationAccess rows. Vendor and expense data is
  // financial recordkeeping; the entire surface is ADMIN-only by design.
  await requireOrgAdminOrNotFound(orgId);

  const organization = await prisma.organization.findUniqueOrThrow({
    where: { id: orgId },
  });
  const vendors = await listOrganizationVendors(orgId);

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
          Vendors
        </span>
      </nav>

      <section aria-labelledby="vendors-heading" className="mt-6">
        <h1
          id="vendors-heading"
          className="text-2xl font-semibold tracking-tight"
        >
          Vendors
        </h1>
        <p className="mt-1 text-sm text-neutral-600">
          Where the organization buys things — a simple reference record, not a
          CRM or a purchasing workflow. Deactivating a vendor stops new spending
          from being recorded against it; its existing expenses are unchanged.
        </p>
      </section>

      {vendors.length === 0 ? (
        <p className="mt-6 text-sm text-neutral-500">
          No vendors recorded yet.
        </p>
      ) : (
        <ul className="mt-6 divide-y divide-neutral-200 rounded-md border border-neutral-200">
          {vendors.map((vendor) => (
            <li key={vendor.id} className="px-4 py-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <span className="font-medium text-neutral-900">
                    {vendor.name}
                  </span>
                  {vendor.status === "INACTIVE" && (
                    <span className="ml-2 inline-block rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-600">
                      {VENDOR_STATUS_LABELS.INACTIVE}
                    </span>
                  )}
                </div>
                <VendorStatusButton
                  action={setVendorStatusAction.bind(
                    null,
                    vendor.id,
                    vendor.status === "ACTIVE" ? "INACTIVE" : "ACTIVE",
                  )}
                  label={
                    vendor.status === "ACTIVE" ? "Deactivate" : "Reactivate"
                  }
                />
              </div>
              <p className="mt-1 text-xs text-neutral-500">
                {[
                  vendor.contactName,
                  vendor.email,
                  vendor.phone,
                  vendor.accountReference
                    ? `acct ${vendor.accountReference}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || "No contact details recorded."}
                {` · ${vendor._count.expenses} expense${vendor._count.expenses === 1 ? "" : "s"}`}
                {vendor._count.expenses > 0 && (
                  <>
                    {" — "}
                    <Link
                      href={`/admin/organizations/${orgId}/expenses?vendor=${vendor.id}`}
                      className="underline"
                    >
                      view
                    </Link>
                  </>
                )}
              </p>
              {vendor.website && (
                <p className="mt-0.5 text-xs text-neutral-500">
                  <a
                    href={vendor.website}
                    rel="noreferrer"
                    className="underline"
                  >
                    {vendor.website}
                  </a>
                </p>
              )}
              {vendor.notes && (
                <p className="mt-1 text-xs text-neutral-600">{vendor.notes}</p>
              )}
              <details className="mt-2">
                <summary className="cursor-pointer text-xs font-medium text-neutral-600 hover:text-neutral-900">
                  Edit
                </summary>
                <div className="mt-2">
                  <VendorForm
                    action={updateVendorAction.bind(null, vendor.id)}
                    defaults={vendor}
                    idPrefix={`vendor-${vendor.id}`}
                    submitLabel="Save changes"
                  />
                </div>
              </details>
            </li>
          ))}
        </ul>
      )}

      <section
        aria-labelledby="create-vendor-heading"
        className="mt-10 rounded-md border border-neutral-200 p-4"
      >
        <h2
          id="create-vendor-heading"
          className="text-sm font-medium text-neutral-800"
        >
          New vendor
        </h2>
        <p className="mt-1 text-xs text-neutral-500">
          Do not record bank details or payment credentials here — a vendor is a
          contact reference, not an account.
        </p>
        <div className="mt-3">
          <VendorForm
            action={createVendorAction.bind(null, orgId)}
            submitLabel="Add vendor"
          />
        </div>
      </section>
    </main>
  );
}
