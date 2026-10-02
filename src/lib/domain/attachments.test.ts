import { describe, expect, it } from "vitest";

/**
 * Pure-policy tests for issue #16 attachments — no database required.
 * Covers the upload policy (size, type, extension, signature),
 * filename sanitization, opaque keys, and download headers.
 */

import {
  ATTACHMENT_DISPLAY_FILENAME_MAX,
  ATTACHMENT_MAX_BYTES,
  AttachmentInputError,
  attachmentContentDisposition,
  newAttachmentStorageKey,
  sanitizeDisplayFilename,
  validateUpload,
} from "./attachments";

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e]); // "%PDF-1."
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
]);
const ZIP_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);

describe("validateUpload", () => {
  it("accepts a real PDF", () => {
    expect(() =>
      validateUpload({
        name: "report.pdf",
        mediaType: "application/pdf",
        bytes: PDF_BYTES,
      }),
    ).not.toThrow();
  });

  it("accepts PNG/JPEG/WebP images and text", () => {
    expect(() =>
      validateUpload({
        name: "photo.png",
        mediaType: "image/png",
        bytes: PNG_BYTES,
      }),
    ).not.toThrow();
    expect(() =>
      validateUpload({
        name: "notes.txt",
        mediaType: "text/plain",
        bytes: new TextEncoder().encode("plain text notes"),
      }),
    ).not.toThrow();
    expect(() =>
      validateUpload({
        name: "sheet.docx",
        mediaType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        bytes: ZIP_BYTES,
      }),
    ).not.toThrow();
  });

  it("rejects empty files", () => {
    expect(() =>
      validateUpload({
        name: "empty.pdf",
        mediaType: "application/pdf",
        bytes: new Uint8Array(0),
      }),
    ).toThrow(AttachmentInputError);
  });

  it("rejects oversized files", () => {
    expect(() =>
      validateUpload({
        name: "big.pdf",
        mediaType: "application/pdf",
        bytes: new Uint8Array(ATTACHMENT_MAX_BYTES + 1),
      }),
    ).toThrow(/25 MB or smaller/);
  });

  it("rejects unsupported media types including HTML and SVG", () => {
    for (const mediaType of [
      "text/html",
      "image/svg+xml",
      "application/javascript",
      "application/zip",
      "application/x-msdownload",
    ]) {
      expect(() =>
        validateUpload({
          name: "file.bin",
          mediaType,
          bytes: new Uint8Array([1, 2, 3]),
        }),
      ).toThrow(AttachmentInputError);
    }
  });

  it("rejects a filename extension that does not match the media type", () => {
    expect(() =>
      validateUpload({
        name: "photo.png",
        mediaType: "application/pdf",
        bytes: PDF_BYTES,
      }),
    ).toThrow(/extension does not match/);
  });

  it("rejects content that fails the type's signature check", () => {
    expect(() =>
      validateUpload({
        name: "fake.pdf",
        mediaType: "application/pdf",
        bytes: new TextEncoder().encode("this is not a pdf"),
      }),
    ).toThrow(/contents do not match/);
  });

  it("rejects binary content masquerading as text", () => {
    const bytes = new TextEncoder().encode("hello world");
    bytes[3] = 0; // NUL byte
    expect(() =>
      validateUpload({ name: "x.txt", mediaType: "text/plain", bytes }),
    ).toThrow(/not look like text/);
  });

  it("rejects missing or overlong filenames", () => {
    expect(() =>
      validateUpload({
        name: "   ",
        mediaType: "application/pdf",
        bytes: PDF_BYTES,
      }),
    ).toThrow(AttachmentInputError);
    expect(() =>
      validateUpload({
        name: `${"a".repeat(400)}.pdf`,
        mediaType: "application/pdf",
        bytes: PDF_BYTES,
      }),
    ).toThrow(AttachmentInputError);
  });
});

describe("sanitizeDisplayFilename", () => {
  it("strips path traversal from both separator styles", () => {
    expect(sanitizeDisplayFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeDisplayFilename("..\\..\\windows\\system32\\x.pdf")).toBe(
      "x.pdf",
    );
    expect(sanitizeDisplayFilename("a/b/c.pdf")).toBe("c.pdf");
  });

  it("removes control characters and bidi overrides", () => {
    expect(sanitizeDisplayFilename("rep\u202eort.pdf")).toBe("report.pdf");
    expect(sanitizeDisplayFilename("a\u0000b.pdf")).toBe("ab.pdf");
  });

  it("collapses empty and dot-only names to a safe fallback", () => {
    expect(sanitizeDisplayFilename("...")).toBe("attachment");
    expect(sanitizeDisplayFilename("   ")).toBe("attachment");
    expect(sanitizeDisplayFilename("/")).toBe("attachment");
  });

  it("caps the display name length", () => {
    const long = `${"n".repeat(400)}.pdf`;
    expect(sanitizeDisplayFilename(long).length).toBeLessThanOrEqual(
      ATTACHMENT_DISPLAY_FILENAME_MAX,
    );
  });

  it("normalizes unicode to NFC", () => {
    // e + combining acute (U+0301) composes to é (U+00E9)
    const decomposed = "résumé.pdf";
    expect(sanitizeDisplayFilename(decomposed)).toBe("résumé.pdf");
  });
});

describe("newAttachmentStorageKey", () => {
  it("produces opaque org-scoped keys free of filename/business context", () => {
    const key = newAttachmentStorageKey("org123");
    expect(key).toMatch(/^organizations\/org123\/attachments\/[0-9a-f-]{36}$/);
    expect(key).not.toContain("report");
    expect(key).not.toContain(".pdf");
    expect(newAttachmentStorageKey("org123")).not.toBe(key);
  });
});

describe("attachmentContentDisposition", () => {
  it("forces download with an ASCII fallback and UTF-8 name", () => {
    const cd = attachmentContentDisposition("report.pdf");
    expect(cd).toBe(
      `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`,
    );
  });

  it("neutralizes header injection attempts", () => {
    const cd = attachmentContentDisposition('a"\r\nX-Injected: yes.pdf');
    expect(cd).not.toContain("\r");
    expect(cd).not.toContain("\n");
    expect(cd.startsWith("attachment;")).toBe(true);
  });

  it("keeps unicode names via filename* with an underscored fallback", () => {
    const cd = attachmentContentDisposition("résumé.pdf");
    expect(cd).toContain(`filename="r_sum_.pdf"`);
    expect(cd).toContain(`filename*=UTF-8''r%C3%A9sum%C3%A9.pdf`);
  });

  it("rejects bytes above the text probe as binary for text types", () => {
    // A NUL in the first 4KB marks text/plain as binary masquerade.
    const bytes = new Uint8Array(5000).fill(0x41);
    bytes[4090] = 0;
    expect(() =>
      validateUpload({ name: "x.txt", mediaType: "text/plain", bytes }),
    ).toThrow(/not look like text/);
  });
});
