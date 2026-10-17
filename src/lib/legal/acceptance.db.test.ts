import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import {
  hasAcceptedCurrentTerms,
  recordTermsAcceptance,
} from "@/lib/legal/acceptance";
import {
  PRIVACY_POLICY,
  TERMS_OF_SERVICE,
  legalDocumentHash,
} from "@/lib/legal/documents";

const hasDb = Boolean(process.env.DATABASE_URL);
const PREFIX = "dbtest-legal-";

let counter = 0;
const ident = () => `${PREFIX}${++counter}`;

describe.skipIf(!hasDb)("terms acceptance", () => {
  afterAll(async () => {
    await prisma.termsAcceptance.deleteMany({
      where: { authIdentityId: { startsWith: PREFIX } },
    });
  });

  it("persists version + content hash and flips the acceptance check", async () => {
    const id = ident();
    expect(await hasAcceptedCurrentTerms(id)).toBe(false);

    const row = await recordTermsAcceptance(id);
    expect(row.termsVersion).toBe(TERMS_OF_SERVICE.version);
    expect(row.termsHash).toBe(legalDocumentHash(TERMS_OF_SERVICE));
    expect(row.privacyVersion).toBe(PRIVACY_POLICY.version);
    expect(row.privacyHash).toBe(legalDocumentHash(PRIVACY_POLICY));
    expect(row.mechanism).toBe("explicit_checkbox");
    expect(row.acceptedAt).toBeInstanceOf(Date);

    expect(await hasAcceptedCurrentTerms(id)).toBe(true);
  });

  it("is idempotent per (identity, terms version) — no duplicate rows", async () => {
    const id = ident();
    const first = await recordTermsAcceptance(id);
    const second = await recordTermsAcceptance(id);
    expect(second.id).toBe(first.id);

    const count = await prisma.termsAcceptance.count({
      where: { authIdentityId: id },
    });
    expect(count).toBe(1);
  });

  it("acceptance is per-identity — another user is unaffected", async () => {
    const a = ident();
    const b = ident();
    await recordTermsAcceptance(a);
    expect(await hasAcceptedCurrentTerms(b)).toBe(false);
  });
});
