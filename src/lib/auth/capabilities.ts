import { OrgCapability } from "@prisma/client";

/**
 * Delegated organization capabilities (issue #84) — the single typed
 * registry every enforcement point, navigation map, and admin UI reads
 * from. A MANAGER may do exactly what their OrganizationAccess row
 * grants; ADMIN implies every capability implicitly.
 *
 * There is deliberately no capability for account administration:
 * inviting accounts, linking identities, changing roles, editing
 * capability grants, and organization security settings stay
 * ADMIN-only forever. Do not add a delegable capability for them.
 *
 * Role names and capabilities describe SARbase records access only —
 * they imply nothing about SAR incident-command authority,
 * operational qualifications, or rescue readiness.
 */

export type CapabilityGroup =
  "Operations" | "People" | "Equipment" | "Finance" | "Documents" | "Reporting";

export interface CapabilityDefinition {
  key: OrgCapability;
  group: CapabilityGroup;
  /** Short plain-language label for admin UI. */
  label: string;
  /** One-sentence scope description for admin UI and docs. */
  description: string;
}

export const CAPABILITY_REGISTRY: readonly CapabilityDefinition[] = [
  {
    key: OrgCapability.OPERATIONS_MANAGE,
    group: "Operations",
    label: "Manage callouts and incidents",
    description:
      "Create, edit, and close callouts and incidents, record responses, and manage participants, assets, and notes.",
  },
  {
    key: OrgCapability.TRAINING_MANAGE,
    group: "Operations",
    label: "Manage training",
    description: "Schedule training events and record member attendance.",
  },
  {
    key: OrgCapability.QUALIFICATIONS_MANAGE,
    group: "People",
    label: "Manage qualifications",
    description:
      "Maintain qualification definitions and record member qualification evidence.",
  },
  {
    key: OrgCapability.QUALIFICATIONS_VERIFY,
    group: "People",
    label: "Verify member submissions",
    description:
      "Approve or reject member-filed qualification claims and record corrections — the official verification step.",
  },
  {
    key: OrgCapability.MEMBERS_MANAGE,
    group: "People",
    label: "Manage member records",
    description:
      "Edit member operational fields, statuses, and unit assignments. Does not include invitations, sign-in access, or emergency contacts.",
  },
  {
    key: OrgCapability.EQUIPMENT_MANAGE,
    group: "Equipment",
    label: "Manage equipment",
    description:
      "Maintain assets, storage locations, inventory, inspections, maintenance, defects, and meter readings.",
  },
  {
    key: OrgCapability.FINANCE_MANAGE,
    group: "Finance",
    label: "Manage financial records",
    description: "Maintain vendors and enter or edit expense records.",
  },
  {
    key: OrgCapability.FINANCE_APPROVE,
    group: "Finance",
    label: "Approve expenses",
    description:
      "Approve or reject submitted expenses and mark reimbursements — money-movement decisions.",
  },
  {
    key: OrgCapability.DOCUMENTS_MANAGE,
    group: "Documents",
    label: "Manage documents",
    description:
      "Maintain organization documents and administer attachments, including deletion.",
  },
  {
    key: OrgCapability.NOTIFICATIONS_MANAGE,
    group: "Operations",
    label: "Manage notifications",
    description:
      "Send operational notifications to members and retry failed deliveries.",
  },
  {
    key: OrgCapability.REPORTS_EXPORT,
    group: "Reporting",
    label: "Export reports",
    description: "Generate and download organization reports and CSV exports.",
  },
];

export const ORG_CAPABILITIES = CAPABILITY_REGISTRY.map(
  (d) => d.key,
) as OrgCapability[];

/**
 * The standard Manager set applied when a grant's role becomes
 * MANAGER: routine operational work, deliberately excluding the two
 * authority capabilities (qualification verification, expense
 * approval) and all finance. Administrators can still tailor grants
 * per manager afterward.
 */
export const STANDARD_MANAGER_CAPABILITIES: readonly OrgCapability[] = [
  OrgCapability.OPERATIONS_MANAGE,
  OrgCapability.TRAINING_MANAGE,
  OrgCapability.QUALIFICATIONS_MANAGE,
  OrgCapability.MEMBERS_MANAGE,
  OrgCapability.EQUIPMENT_MANAGE,
  OrgCapability.DOCUMENTS_MANAGE,
  OrgCapability.NOTIFICATIONS_MANAGE,
  OrgCapability.REPORTS_EXPORT,
];

/** Narrow an untrusted string to a known capability. */
export function isOrgCapability(value: unknown): value is OrgCapability {
  return (
    typeof value === "string" &&
    ORG_CAPABILITIES.includes(value as OrgCapability)
  );
}
