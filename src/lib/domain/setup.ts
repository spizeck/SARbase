import { prisma } from "@/lib/prisma";
import { log } from "@/lib/logging";

/**
 * New-organization setup checklist (operational onboarding).
 *
 * A dismissible, advisory list of the records most organizations want
 * before they start using SARbase operationally. It is guidance, never
 * a gate: every item links to where the work happens, nothing blocks on
 * completing the list, and optional structure (units, vendors,
 * qualifications) is labelled optional rather than demanded.
 *
 * Done-state is computed from record counts and timestamps — there is
 * no "marked done" state to maintain. An item completed retroactively
 * (e.g. a vendor added months later) simply flips on next render.
 * Dismissal is per-organization (setupChecklistDismissedAt): it is a
 * property of the organization's onboarding, not one admin's browser.
 */

export interface SetupChecklistItem {
  id: string;
  label: string;
  /** Where the work happens — an admin route or an anchor on this page. */
  href: string;
  done: boolean;
  /** Optional structure — the org may legitimately never create these. */
  optional: boolean;
}

export interface OrganizationSetup {
  dismissed: boolean;
  doneCount: number;
  totalCount: number;
  complete: boolean;
  items: SetupChecklistItem[];
}

/**
 * "Settings reviewed" is not a field — the honest signal available is
 * that an admin saved the settings form at least once after the row was
 * provisioned. Provisioning writes createdAt/updatedAt in the same
 * insert, so a later update leaves a real gap; a small epsilon absorbs
 * clock precision differences between the two generated timestamps.
 */
const SETTINGS_REVIEWED_EPSILON_MS = 1_000;

export function computeSetupChecklist(input: {
  organizationId: string;
  createdAt: Date;
  updatedAt: Date;
  dismissedAt: Date | null;
  units: number;
  members: number;
  storageLocations: number;
  vendors: number;
  assets: number;
  qualificationDefinitions: number;
}): OrganizationSetup {
  const org = `/admin/organizations/${input.organizationId}`;
  const items: SetupChecklistItem[] = [
    {
      id: "settings",
      label: "Review organization settings — name and timezone",
      href: `${org}#details-heading`,
      done:
        input.updatedAt.getTime() - input.createdAt.getTime() >
        SETTINGS_REVIEWED_EPSILON_MS,
      optional: false,
    },
    {
      id: "members",
      label: "Add member records",
      href: `${org}#members-heading`,
      done: input.members > 0,
      optional: false,
    },
    {
      id: "assets",
      label: "Record the first assets",
      href: `${org}/assets`,
      done: input.assets > 0,
      optional: false,
    },
    {
      id: "locations",
      label: "Name storage locations",
      href: `${org}/locations`,
      done: input.storageLocations > 0,
      optional: false,
    },
    {
      id: "units",
      label: "Create units or teams",
      href: `${org}#units-heading`,
      done: input.units > 0,
      optional: true,
    },
    {
      id: "vendors",
      label: "Record vendors",
      href: `${org}/vendors`,
      done: input.vendors > 0,
      optional: true,
    },
    {
      id: "qualifications",
      label: "Define tracked qualifications",
      href: `${org}#qualifications-heading`,
      done: input.qualificationDefinitions > 0,
      optional: true,
    },
  ];
  const doneCount = items.filter((i) => i.done).length;
  return {
    dismissed: input.dismissedAt !== null,
    doneCount,
    totalCount: items.length,
    complete: doneCount === items.length,
    items,
  };
}

export async function getOrganizationSetup(
  organizationId: string,
): Promise<OrganizationSetup | null> {
  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: {
      createdAt: true,
      updatedAt: true,
      setupChecklistDismissedAt: true,
      _count: {
        select: {
          units: true,
          members: true,
          storageLocations: true,
          vendors: true,
          assets: true,
          qualificationDefinitions: true,
        },
      },
    },
  });
  if (!organization) return null;
  return computeSetupChecklist({
    organizationId,
    createdAt: organization.createdAt,
    updatedAt: organization.updatedAt,
    dismissedAt: organization.setupChecklistDismissedAt,
    units: organization._count.units,
    members: organization._count.members,
    storageLocations: organization._count.storageLocations,
    vendors: organization._count.vendors,
    assets: organization._count.assets,
    qualificationDefinitions: organization._count.qualificationDefinitions,
  });
}

export async function setSetupChecklistDismissed(
  organizationId: string,
  dismissed: boolean,
) {
  const organization = await prisma.organization.update({
    where: { id: organizationId },
    data: { setupChecklistDismissedAt: dismissed ? new Date() : null },
  });
  log({
    event: dismissed
      ? "organization.setup_checklist_dismissed"
      : "organization.setup_checklist_restored",
    subsystem: "domain",
    entityType: "Organization",
    entityId: organization.id,
    organizationId,
  });
  return organization;
}
