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
  /** Where the work happens — the admin workspace that owns the records. */
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

export function computeSetupChecklist(input: {
  organizationId: string;
  /** Stamped by an actual settings save — see Organization.settingsReviewedAt. */
  settingsReviewedAt: Date | null;
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
      href: `${org}/settings`,
      done: input.settingsReviewedAt !== null,
      optional: false,
    },
    {
      id: "members",
      label: "Add member records",
      href: `${org}/members`,
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
      href: `${org}/units`,
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
      href: `${org}/qualifications`,
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
      settingsReviewedAt: true,
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
    settingsReviewedAt: organization.settingsReviewedAt,
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
