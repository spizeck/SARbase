import { describe, expect, it } from "vitest";

/**
 * Registry invariants for the export catalog (issues #19/#73).
 *
 * #73 rewrote every label/description in plain language for
 * non-technical coordinators; technical semantics moved behind the
 * progressive-disclosure `help` field. These tests lock the contract
 * in both directions:
 *
 * - Presentation: labels/descriptions stay jargon-free and non-empty.
 * - Contract: dataset keys, groups, and supported filter sets are
 *   snapshotted — a casual rename or filter change fails loudly here
 *   before it can surprise a downstream integration.
 */

import { EXPORT_DATASETS } from "./datasets";

/** Terms that must never appear in coordinator-facing copy. */
const JARGON = [
  /append-?only/i,
  /tombston/i,
  /materialized/i,
  /\binstant\b/i,
  /\blinkType\b/,
  /\btargetId\b/,
  /\bamountMinor\b/,
  /\bid\b/i, // "id"/"ids" — say "record id" in help, not in one-liners
  /`[^`]+`/, // backticked code/params belong in `help`, not one-liners
];

describe("EXPORT_DATASETS registry", () => {
  it("declares every dataset with plain-language presentation fields", () => {
    for (const d of EXPORT_DATASETS) {
      expect(d.key, "key").toMatch(/^[a-z-]+$/);
      expect(d.label.trim().length, `label of ${d.key}`).toBeGreaterThan(0);
      expect(
        d.description.trim().length,
        `description of ${d.key}`,
      ).toBeGreaterThan(0);
      for (const pattern of JARGON) {
        expect(d.label, `label of ${d.key} contains ${pattern}`).not.toMatch(
          pattern,
        );
        expect(
          d.description,
          `description of ${d.key} contains ${pattern}`,
        ).not.toMatch(pattern);
      }
    }
  });

  it("keeps the dataset key set and grouping stable", () => {
    const keys = EXPORT_DATASETS.map((d) => `${d.group}/${d.key}`);
    expect(keys).toMatchInlineSnapshot(`
      [
        "Organization & people/organization",
        "Organization & people/units",
        "Organization & people/members",
        "Organization & people/member-units",
        "Organization & people/member-availability",
        "Organization & people/member-notification-preferences",
        "Organization & people/member-invitations",
        "Organization & people/member-invitation-events",
        "Qualifications & training/qualification-definitions",
        "Qualifications & training/member-qualifications",
        "Qualifications & training/training-events",
        "Qualifications & training/training-topics",
        "Qualifications & training/training-attendance",
        "Assets & maintenance/storage-locations",
        "Assets & maintenance/assets",
        "Assets & maintenance/inventory-items",
        "Assets & maintenance/inspection-definitions",
        "Assets & maintenance/inspection-records",
        "Assets & maintenance/maintenance-plans",
        "Assets & maintenance/maintenance-records",
        "Assets & maintenance/asset-meters",
        "Assets & maintenance/asset-meter-readings",
        "Assets & maintenance/defects",
        "Incidents & callouts/callouts",
        "Incidents & callouts/callout-invitations",
        "Incidents & callouts/incidents",
        "Incidents & callouts/incident-participants",
        "Incidents & callouts/incident-assets",
        "Incidents & callouts/incident-timeline",
        "Incidents & callouts/incident-notes",
        "Incidents & callouts/incident-note-corrections",
        "Incidents & callouts/incident-changes",
        "Documents & attachments/organization-documents",
        "Documents & attachments/organization-document-versions",
        "Documents & attachments/attachments",
        "Documents & attachments/attachment-links",
        "Vendors & expenses/vendors",
        "Vendors & expenses/expenses",
        "Vendors & expenses/expense-links",
        "Vendors & expenses/expense-events",
        "Vendors & expenses/expense-changes",
        "Documents & attachments/data-export-events",
      ]
    `);
  });

  it("keeps each dataset's supported filter set stable", () => {
    const filters = Object.fromEntries(
      EXPORT_DATASETS.map((d) => [d.key, [...d.filters].sort()]),
    );
    expect(filters).toMatchInlineSnapshot(`
      {
        "asset-meter-readings": [
          "date",
        ],
        "asset-meters": [],
        "assets": [
          "unit",
        ],
        "attachment-links": [],
        "attachments": [
          "date",
        ],
        "callout-invitations": [
          "date",
        ],
        "callouts": [
          "date",
          "unit",
        ],
        "data-export-events": [
          "date",
        ],
        "defects": [
          "date",
        ],
        "expense-changes": [
          "date",
        ],
        "expense-events": [
          "date",
        ],
        "expense-links": [],
        "expenses": [
          "category",
          "currency",
          "date",
          "reimbursementStatus",
          "status",
          "vendor",
        ],
        "incident-assets": [
          "date",
        ],
        "incident-changes": [
          "date",
        ],
        "incident-note-corrections": [
          "date",
        ],
        "incident-notes": [
          "date",
        ],
        "incident-participants": [
          "date",
        ],
        "incident-timeline": [
          "date",
        ],
        "incidents": [
          "date",
        ],
        "inspection-definitions": [],
        "inspection-records": [
          "date",
        ],
        "inventory-items": [
          "unit",
        ],
        "maintenance-plans": [],
        "maintenance-records": [
          "date",
        ],
        "member-availability": [
          "date",
        ],
        "member-invitation-events": [
          "date",
        ],
        "member-invitations": [
          "date",
        ],
        "member-notification-preferences": [],
        "member-qualifications": [],
        "member-units": [],
        "members": [
          "unit",
        ],
        "organization": [],
        "organization-document-versions": [],
        "organization-documents": [],
        "qualification-definitions": [],
        "storage-locations": [],
        "training-attendance": [],
        "training-events": [
          "date",
          "unit",
        ],
        "training-topics": [],
        "units": [],
        "vendors": [],
      }
    `);
  });
});
