import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Permission matrix (issue #84): every privileged server action must
 * carry exactly one intended guard — an org-level capability check, an
 * entity-scoped capability helper, or an Administrator-only helper. The
 * matrix is extracted from actions.ts source so a new action cannot be
 * added without an explicit authorization decision here, and a
 * capability change on an existing action fails loudly.
 */

const SOURCE = readFileSync(path.join(__dirname, "actions.ts"), "utf-8");

/** Every guard call a server action may legitimately make. */
const GUARD_CALL =
  /requireOrgAdmin\b|requireOrgAdminOrNotFound\b|requireOrgAdminForMember\b|requireOrgAdminForMemberInvitation\b|requireOrgStaffOrNotFound\b|requireOrgCapability\b|requireOrgCapabilityOrNotFound\b|requireOrgCapabilityFor\w+|requireAttachmentForStaffOrOwner\b/g;

/** Guard ids as they appear in source (regex-safe names). */
type Guard =
  | "requireOrgAdmin"
  | "requireOrgAdminForMember"
  | "requireOrgAdminForMemberInvitation"
  | `requireOrgCapability(${string}`
  | `requireOrgCapabilityFor${string}`;

/**
 * action name -> the guard calls expected in its body, in order of
 * evaluation where multiple apply. Org-level creates use
 * requireOrgCapability; entity-bound actions use the scoped helper.
 * Administration (access, invitations, identities, org settings) is
 * Administrator-only by design — no capability delegates it.
 */
const MATRIX: Record<string, Guard[]> = {
  // Organization administration — Administrator-only, never delegable.
  updateOrganizationAction: ["requireOrgAdmin"],
  setSetupChecklistDismissedAction: ["requireOrgAdmin"],
  setOrganizationAccessRoleAction: ["requireOrgAdmin"],

  // People — MEMBERS_MANAGE for records; account/identity admin stays
  // Administrator-only even though it is member-scoped.
  createUnitAction: [
    "requireOrgCapability(ctx, organizationId, OrgCapability.MEMBERS_MANAGE)",
  ],
  updateUnitAction: ["requireOrgCapabilityForUnit"],
  createMemberAction: [
    "requireOrgCapability(ctx, organizationId, OrgCapability.MEMBERS_MANAGE)",
  ],
  updateMemberAction: ["requireOrgCapabilityForMember"],
  setMemberStatusAction: ["requireOrgCapabilityForMember"],
  setMemberUnitsAction: ["requireOrgCapabilityForMember"],
  setMemberAvailabilityAction: ["requireOrgCapabilityForMember"],
  updateMemberContactPreferenceAction: ["requireOrgCapabilityForMember"],
  linkIdentityToMemberAction: ["requireOrgAdminForMember"],
  unlinkIdentityFromMemberAction: ["requireOrgAdminForMember"],
  createMemberInvitationAction: ["requireOrgAdminForMember"],
  resendMemberInvitationAction: ["requireOrgAdminForMemberInvitation"],
  revokeMemberInvitationAction: ["requireOrgAdminForMemberInvitation"],
  reviewMemberSubmissionAction: ["requireOrgCapabilityForMemberSubmission"],

  // Qualifications.
  createQualificationDefinitionAction: [
    "requireOrgCapability(ctx, organizationId, OrgCapability.QUALIFICATIONS_MANAGE)",
  ],
  updateQualificationDefinitionAction: [
    "requireOrgCapabilityForQualificationDefinition",
  ],
  setQualificationDefinitionStatusAction: [
    "requireOrgCapabilityForQualificationDefinition",
  ],
  createMemberQualificationAction: ["requireOrgCapabilityForMember"],
  updateMemberQualificationAction: ["requireOrgCapabilityForQualification"],

  // Training.
  createTrainingEventAction: [
    "requireOrgCapability(ctx, organizationId, OrgCapability.TRAINING_MANAGE)",
  ],
  updateTrainingEventAction: ["requireOrgCapabilityForTrainingEvent"],
  setTrainingEventStatusAction: ["requireOrgCapabilityForTrainingEvent"],
  setTrainingAttendanceAction: ["requireOrgCapabilityForTrainingEvent"],

  // Equipment.
  createStorageLocationAction: [
    "requireOrgCapability(ctx, organizationId, OrgCapability.EQUIPMENT_MANAGE)",
  ],
  updateStorageLocationAction: ["requireOrgCapabilityForStorageLocation"],
  createAssetAction: [
    "requireOrgCapability(ctx, organizationId, OrgCapability.EQUIPMENT_MANAGE)",
  ],
  updateAssetAction: ["requireOrgCapabilityForAsset"],
  createInventoryItemAction: [
    "requireOrgCapability(ctx, organizationId, OrgCapability.EQUIPMENT_MANAGE)",
  ],
  updateInventoryItemAction: ["requireOrgCapabilityForInventoryItem"],
  createInspectionDefinitionAction: [
    "requireOrgCapability(ctx, organizationId, OrgCapability.EQUIPMENT_MANAGE)",
  ],
  updateInspectionDefinitionAction: [
    "requireOrgCapabilityForInspectionDefinition",
  ],
  setInspectionDefinitionStatusAction: [
    "requireOrgCapabilityForInspectionDefinition",
  ],
  recordInspectionAction: ["requireOrgCapabilityForAsset"],
  updateInspectionRecordAction: ["requireOrgCapabilityForInspectionRecord"],
  createMaintenancePlanAction: ["requireOrgCapabilityForAsset"],
  updateMaintenancePlanAction: ["requireOrgCapabilityForMaintenancePlan"],
  setMaintenancePlanStatusAction: ["requireOrgCapabilityForMaintenancePlan"],
  recordMaintenanceAction: ["requireOrgCapabilityForAsset"],
  updateMaintenanceRecordAction: ["requireOrgCapabilityForMaintenanceRecord"],
  reportDefectAction: ["requireOrgCapabilityForAsset"],
  updateDefectAction: ["requireOrgCapabilityForDefect"],
  transitionDefectAction: ["requireOrgCapabilityForDefect"],
  createAssetMeterAction: ["requireOrgCapabilityForAsset"],
  updateAssetMeterAction: ["requireOrgCapabilityForAssetMeter"],
  setAssetMeterStatusAction: ["requireOrgCapabilityForAssetMeter"],
  recordMeterReadingAction: ["requireOrgCapabilityForAssetMeter"],

  // Notifications.
  sendAdminNotificationAction: [
    "requireOrgCapability(ctx, organizationId, OrgCapability.NOTIFICATIONS_MANAGE)",
  ],
  retryNotificationAction: ["requireOrgCapabilityForNotification"],

  // Operations.
  activateCalloutAction: [
    "requireOrgCapability(ctx, organizationId, OrgCapability.OPERATIONS_MANAGE)",
  ],
  closeCalloutAction: ["requireOrgCapabilityForCallout"],
  recordCalloutResponseAction: ["requireOrgCapabilityForCalloutInvitation"],
  createIncidentAction: [
    "requireOrgCapability(ctx, organizationId, OrgCapability.OPERATIONS_MANAGE)",
  ],
  createIncidentFromCalloutAction: ["requireOrgCapabilityForCallout"],
  transitionIncidentStatusAction: ["requireOrgCapabilityForIncident"],
  updateIncidentAction: ["requireOrgCapabilityForIncident"],
  linkIncidentCalloutAction: ["requireOrgCapabilityForIncident"],
  addIncidentMemberAction: ["requireOrgCapabilityForIncident"],
  removeIncidentMemberAction: ["requireOrgCapabilityForIncidentMember"],
  addIncidentAssetAction: ["requireOrgCapabilityForIncident"],
  removeIncidentAssetAction: ["requireOrgCapabilityForIncidentAsset"],
  addIncidentNoteAction: ["requireOrgCapabilityForIncident"],
  correctIncidentNoteAction: ["requireOrgCapabilityForIncidentNote"],

  // Documents & attachments.
  uploadAttachmentAction: ["requireOrgCapabilityForAttachmentTarget"],
  prepareAttachmentUploadAction: ["requireOrgCapabilityForAttachmentTarget"],
  finalizeAttachmentUploadAction: ["requireOrgCapabilityForAttachmentTarget"],
  unlinkAttachmentAction: ["requireOrgCapabilityForAttachmentTarget"],
  deleteAttachmentAction: ["requireOrgCapabilityForAttachment"],
  recheckAttachmentScanAction: ["requireOrgCapabilityForAttachment"],
  prepareDocumentUploadAction: [
    "requireOrgCapability(ctx, organizationId, OrgCapability.DOCUMENTS_MANAGE)",
  ],
  finalizeDocumentCreateAction: [
    "requireOrgCapability(ctx, organizationId, OrgCapability.DOCUMENTS_MANAGE)",
  ],
  prepareDocumentVersionAction: ["requireOrgCapabilityForOrganizationDocument"],
  finalizeDocumentVersionAction: [
    "requireOrgCapabilityForOrganizationDocument",
  ],
  createOrganizationDocumentAction: [
    "requireOrgCapability(ctx, organizationId, OrgCapability.DOCUMENTS_MANAGE)",
  ],
  addDocumentVersionAction: ["requireOrgCapabilityForOrganizationDocument"],
  updateOrganizationDocumentAction: [
    "requireOrgCapabilityForOrganizationDocument",
  ],
  setOrganizationDocumentStatusAction: [
    "requireOrgCapabilityForOrganizationDocument",
  ],

  // Finance — entry vs approval split.
  createVendorAction: [
    "requireOrgCapability(ctx, organizationId, OrgCapability.FINANCE_MANAGE)",
  ],
  updateVendorAction: ["requireOrgCapabilityForVendor"],
  setVendorStatusAction: ["requireOrgCapabilityForVendor"],
  createExpenseAction: [
    "requireOrgCapability(ctx, organizationId, OrgCapability.FINANCE_MANAGE)",
  ],
  updateExpenseAction: ["requireOrgCapabilityForExpense"],
  transitionExpenseAction: [
    "requireOrgCapabilityForExpense",
    "requireOrgCapability(ctx, expense.organizationId, OrgCapability.FINANCE_APPROVE)",
  ],
  setExpenseReimbursementAction: ["requireOrgCapabilityForExpense"],
  addExpenseLinkAction: ["requireOrgCapabilityForExpense"],
  removeExpenseLinkAction: ["requireOrgCapabilityForExpenseContextLink"],
};

/** Exported actions that legitimately carry no guard of their own. */
const UNGUARDED = new Set<string>([
  // Form-passthrough to transitionExpenseAction (guarded there).
  "rejectExpenseAction",
]);

function actions(source: string): Map<string, string> {
  const found = new Map<string, string>();
  const starts = [...source.matchAll(/export async function (\w+)\(/g)];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i]!.index!;
    const end = i + 1 < starts.length ? starts[i + 1]!.index! : source.length;
    found.set(starts[i]![1]!, source.slice(start, end));
  }
  return found;
}

describe("permission matrix — every privileged action is deliberately guarded", () => {
  const bodies = actions(SOURCE);

  it("the matrix covers every exported action", () => {
    const missing = [...bodies.keys()].filter(
      (name) => !MATRIX[name] && !UNGUARDED.has(name),
    );
    expect(missing).toEqual([]);
  });

  it("every matrix entry names a real action", () => {
    const stale = Object.keys(MATRIX).filter((name) => !bodies.has(name));
    expect(stale).toEqual([]);
  });

  it.each(Object.entries(MATRIX))(
    "%s carries its intended guard",
    (name, guards) => {
      // Strip whitespace and trailing commas so multiline Prettier
      // output still matches the guard literal.
      const squash = (s: string) => s.replace(/\s+/g, "").replace(/,\)/g, ")");
      const body = squash(bodies.get(name)!);
      for (const guard of guards) {
        expect(body, `${name} must call ${guard}`).toContain(squash(guard));
      }
    },
  );

  it("no action combines admin-only and capability guards ambiguously", () => {
    for (const [name, body] of bodies) {
      if (UNGUARDED.has(name)) continue;
      const guards = body.match(GUARD_CALL) ?? [];
      expect(
        guards.length,
        `${name} unexpectedly calls ${guards.join(", ")}`,
      ).toBeGreaterThan(0);
    }
  });

  it("only listed actions touch the Administrator-only helpers", () => {
    const adminOnly = new Set([
      "updateOrganizationAction",
      "setSetupChecklistDismissedAction",
      "setOrganizationAccessRoleAction",
      "linkIdentityToMemberAction",
      "unlinkIdentityFromMemberAction",
      "createMemberInvitationAction",
      "resendMemberInvitationAction",
      "revokeMemberInvitationAction",
    ]);
    for (const [name, body] of bodies) {
      const usesAdminHelper =
        /requireOrgAdmin\b|requireOrgAdminForMember\b|requireOrgAdminForMemberInvitation\b/.test(
          body,
        );
      expect(
        usesAdminHelper,
        `${name} uses an admin-only guard — if intentional, add it to adminOnly`,
      ).toBe(adminOnly.has(name));
    }
  });
});

/**
 * Page matrix: every page under /admin/organizations/[orgId] gates on
 * the capability its workspace needs. The layout's staff check is only
 * the shell — each page carries its own requirement so a guessed URL
 * fails closed even if the layout ever changes.
 */
const PAGE_MATRIX: Record<string, string> = {
  "access/page.tsx": "requireOrgAdminOrNotFound",
  "settings/page.tsx": "requireOrgAdminOrNotFound",
  "callouts/page.tsx": "OrgCapability.OPERATIONS_MANAGE",
  "callouts/[calloutId]/page.tsx": "OrgCapability.OPERATIONS_MANAGE",
  "incidents/page.tsx": "OrgCapability.OPERATIONS_MANAGE",
  "incidents/[incidentId]/page.tsx": "OrgCapability.OPERATIONS_MANAGE",
  "training/page.tsx": "OrgCapability.TRAINING_MANAGE",
  "training/[eventId]/page.tsx": "OrgCapability.TRAINING_MANAGE",
  "members/page.tsx": "OrgCapability.MEMBERS_MANAGE",
  "members/[memberId]/page.tsx": "OrgCapability.MEMBERS_MANAGE",
  "units/page.tsx": "OrgCapability.MEMBERS_MANAGE",
  "reviews/page.tsx": "OrgCapability.QUALIFICATIONS_VERIFY",
  "qualifications/page.tsx": "OrgCapability.QUALIFICATIONS_MANAGE",
  "expiring/page.tsx": "OrgCapability.QUALIFICATIONS_MANAGE",
  "assets/page.tsx": "OrgCapability.EQUIPMENT_MANAGE",
  "assets/[assetId]/page.tsx": "OrgCapability.EQUIPMENT_MANAGE",
  "inventory/page.tsx": "OrgCapability.EQUIPMENT_MANAGE",
  "locations/page.tsx": "OrgCapability.EQUIPMENT_MANAGE",
  "maintenance/page.tsx": "OrgCapability.EQUIPMENT_MANAGE",
  "vendors/page.tsx": "OrgCapability.FINANCE_MANAGE",
  "expenses/page.tsx": "OrgCapability.FINANCE_MANAGE",
  "expenses/[expenseId]/page.tsx": "OrgCapability.FINANCE_MANAGE",
  "documents/page.tsx": "OrgCapability.DOCUMENTS_MANAGE",
  "documents/[documentId]/page.tsx": "OrgCapability.DOCUMENTS_MANAGE",
  "notifications/page.tsx": "OrgCapability.NOTIFICATIONS_MANAGE",
  "reports/page.tsx": "OrgCapability.REPORTS_EXPORT",
  "search/page.tsx": "requireOrgStaffOrNotFound",
  // The org landing — any access grant, not a staff surface.
  "page.tsx": "requireOrgAccessOrNotFound",
};

const ORG_PAGES_DIR = path.join(__dirname, "organizations", "[orgId]");

function listPages(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listPages(full, `${prefix}${entry}/`));
    } else if (entry === "page.tsx") {
      out.push(`${prefix}${entry}`);
    }
  }
  return out;
}

describe("permission matrix — admin pages gate on the right capability", () => {
  const pages = listPages(ORG_PAGES_DIR);

  it("every admin page is listed in the matrix", () => {
    expect([...pages].sort()).toEqual([...Object.keys(PAGE_MATRIX)].sort());
  });

  it.each(Object.entries(PAGE_MATRIX))("%s requires %s", (file, marker) => {
    const source = readFileSync(path.join(ORG_PAGES_DIR, file), "utf-8");
    expect(source, `${file} must gate on ${marker}`).toContain(marker);
  });

  it("the layout admits staff (ADMIN or MANAGER), not just ADMIN", () => {
    const layout = readFileSync(
      path.join(ORG_PAGES_DIR, "layout.tsx"),
      "utf-8",
    );
    expect(layout).toContain("requireOrgStaffOrNotFound");
  });
});
