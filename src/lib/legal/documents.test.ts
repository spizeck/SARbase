import { describe, expect, it } from "vitest";

import {
  LEGAL_DOCUMENTS,
  PRIVACY_POLICY,
  TERMS_OF_SERVICE,
  SAR_DISCLAIMER,
  getLegalDocument,
  legalDocumentHash,
  type LegalDocument,
} from "./documents";

/**
 * Legal document integrity — the acceptance framework records the
 * content hash, so these tests fail if the structure that defines the
 * hash drifts (missing sections, empty blocks, duplicate anchors).
 */
function* blocks(doc: LegalDocument) {
  for (const section of doc.sections) {
    for (const block of section.blocks) {
      yield { section, block };
    }
  }
}

describe("legal documents", () => {
  it("exposes privacy and terms documents", () => {
    expect(getLegalDocument("privacy")).toBe(PRIVACY_POLICY);
    expect(getLegalDocument("terms")).toBe(TERMS_OF_SERVICE);
    expect(LEGAL_DOCUMENTS).toHaveLength(2);
  });

  it.each(LEGAL_DOCUMENTS.map((d) => [d.key, d] as const))(
    "%s: draft until approved, versioned, no effective date yet",
    (_key, doc) => {
      expect(doc.status).toBe("draft");
      expect(doc.version).toMatch(/draft/);
      expect(doc.effectiveDate).toBeNull();
      expect(doc.sections.length).toBeGreaterThan(5);
    },
  );

  it.each(LEGAL_DOCUMENTS.map((d) => [d.key, d] as const))(
    "%s: unique section anchors and non-empty blocks",
    (_key, doc) => {
      const ids = doc.sections.map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const { section, block } of blocks(doc)) {
        expect(section.heading.length).toBeGreaterThan(0);
        if (block.type === "p") {
          expect((block.text ?? "").trim().length).toBeGreaterThan(0);
        } else {
          expect((block.items ?? []).length).toBeGreaterThan(0);
        }
      }
    },
  );

  it("hash is deterministic and version/content-sensitive", () => {
    expect(legalDocumentHash(PRIVACY_POLICY)).toMatch(/^[0-9a-f]{64}$/);
    expect(legalDocumentHash(PRIVACY_POLICY)).toBe(
      legalDocumentHash(PRIVACY_POLICY),
    );
    expect(
      legalDocumentHash({ ...PRIVACY_POLICY, version: "0.2-draft" }),
    ).not.toBe(legalDocumentHash(PRIVACY_POLICY));
    expect(
      legalDocumentHash({
        ...PRIVACY_POLICY,
        sections: PRIVACY_POLICY.sections.slice(1),
      }),
    ).not.toBe(legalDocumentHash(PRIVACY_POLICY));
  });

  it("terms include the SAR operational disclaimer verbatim", () => {
    const joined = TERMS_OF_SERVICE.sections
      .flatMap((s) => s.blocks.map((b) => b.text ?? b.items?.join(" ") ?? ""))
      .join(" ");
    expect(joined).toContain(SAR_DISCLAIMER);
  });
});
