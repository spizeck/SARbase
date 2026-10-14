import { describe, expect, it } from "vitest";

import { StorageConfigError } from "./provider";
import {
  resolveUploadTicketSecret,
  signUploadTicket,
  verifyUploadTicket,
  type UploadTicketPayload,
} from "./upload-ticket";

const SECRET = "test-upload-ticket-secret";
const NOW = 1_800_000_000;

function payload(overrides: Partial<UploadTicketPayload> = {}) {
  return {
    stagingKey: "staging/organizations/org-1/abc-123",
    finalKey: "organizations/org-1/attachments/def-456",
    actorId: "actor-1",
    mediaType: "application/pdf",
    sizeBytes: 1024,
    expiresAt: NOW + 900,
    ...overrides,
  };
}

describe("upload tickets", () => {
  it("round-trips a valid grant", () => {
    const fields = payload();
    const ticket = signUploadTicket(fields, SECRET);
    expect(verifyUploadTicket(ticket, SECRET, NOW)).toEqual(fields);
  });

  it("rejects a ticket signed with a different secret", () => {
    const ticket = signUploadTicket(payload(), "other-secret");
    expect(verifyUploadTicket(ticket, SECRET, NOW)).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const ticket = signUploadTicket(payload(), SECRET);
    const [version, , signature] = ticket.split(".");
    const tampered = Buffer.from(
      JSON.stringify({ ...payload(), sizeBytes: 5 }),
    ).toString("base64url");
    expect(
      verifyUploadTicket(`${version}.${tampered}.${signature}`, SECRET, NOW),
    ).toBeNull();
  });

  it("rejects an expired grant", () => {
    const ticket = signUploadTicket(payload(), SECRET);
    expect(verifyUploadTicket(ticket, SECRET, NOW + 901)).toBeNull();
  });

  it("rejects malformed and truncated tickets", () => {
    for (const bad of ["", "v1", "v1.abc", "v1.abc.def.ghi", "v2.abc.def"]) {
      expect(verifyUploadTicket(bad, SECRET, NOW)).toBeNull();
    }
  });

  it("rejects a structurally invalid payload", () => {
    const segment = Buffer.from(JSON.stringify({ stagingKey: 42 })).toString(
      "base64url",
    );
    // Forged signature aside, the payload shape itself must be validated.
    const ticket = `v1.${segment}.${"a".repeat(43)}`;
    expect(verifyUploadTicket(ticket, SECRET, NOW)).toBeNull();
  });
});

describe("resolveUploadTicketSecret", () => {
  it("derives deterministically from the object-store credential", () => {
    const a = resolveUploadTicketSecret({
      FILE_STORAGE_S3_SECRET_ACCESS_KEY: "secret-a",
    });
    const b = resolveUploadTicketSecret({
      FILE_STORAGE_S3_SECRET_ACCESS_KEY: "secret-a",
    });
    expect(a).toBe(b);
    expect(a).not.toBe("secret-a");
  });

  it("produces a different key per credential", () => {
    expect(
      resolveUploadTicketSecret({
        FILE_STORAGE_S3_SECRET_ACCESS_KEY: "secret-a",
      }),
    ).not.toBe(
      resolveUploadTicketSecret({
        FILE_STORAGE_S3_SECRET_ACCESS_KEY: "secret-b",
      }),
    );
  });

  it("fails closed without a derivable secret", () => {
    expect(() => resolveUploadTicketSecret({})).toThrow(StorageConfigError);
  });
});
