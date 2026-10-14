import { S3ServiceException } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";

import { S3FileStorageProvider } from "./s3";
import { StorageError } from "./provider";

/**
 * Direct-upload surface of the S3 provider. `createUploadTarget` is pure
 * signing (no I/O); `promoteObject` runs against an injected client fake
 * asserting the exact commands issued.
 */
describe("S3FileStorageProvider — direct uploads", () => {
  const provider = new S3FileStorageProvider({
    bucket: "sarbase-files",
    region: "us-east-1",
    accessKeyId: "key",
    secretAccessKey: "secret",
  });

  it("issues a presigned POST scoped to key, content type, and size", async () => {
    const target = await provider.createUploadTarget(
      "staging/organizations/org-1/uuid-1",
      {
        contentType: "application/pdf",
        sizeBytes: 4096,
        expiresInSeconds: 900,
      },
    );

    expect(target.method).toBe("POST");
    expect(target.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(target.expiresAt.getTime()).toBeLessThan(Date.now() + 901 * 1000);

    const fields = target.fields;
    expect(fields["key"]).toBe("staging/organizations/org-1/uuid-1");
    expect(fields["Content-Type"]).toBe("application/pdf");
    expect(fields["Policy"]).toBeTruthy();
    expect(fields["X-Amz-Signature"]).toBeTruthy();

    // The signed policy is the enforcement — decode and inspect the
    // exact conditions the store edge will apply.
    const policy = JSON.parse(
      Buffer.from(fields["Policy"]!, "base64").toString("utf8"),
    ) as { expiration: string; conditions: unknown[] };
    const conditions = policy.conditions.map((c) => JSON.stringify(c));
    expect(conditions).toContain(
      JSON.stringify({ key: "staging/organizations/org-1/uuid-1" }),
    );
    expect(conditions).toContain(
      JSON.stringify({ "Content-Type": "application/pdf" }),
    );
    // Exact byte size pinned by content-length-range [size, size].
    expect(conditions).toContain(
      JSON.stringify(["content-length-range", 4096, 4096]),
    );
    // The grant's own expiry is inside the signed policy.
    expect(Date.parse(policy.expiration)).toBeGreaterThan(Date.now());
  });

  it("rejects malformed storage keys before signing", async () => {
    await expect(
      provider.createUploadTarget("../escape", {
        contentType: "text/plain",
        sizeBytes: 10,
        expiresInSeconds: 60,
      }),
    ).rejects.toBeInstanceOf(StorageError);
  });

  it("promotes by copying then deleting the staging object", async () => {
    const send = vi.fn().mockResolvedValue({});
    const client = { send } as never;
    const p = new S3FileStorageProvider({
      bucket: "sarbase-files",
      region: "us-east-1",
      accessKeyId: "key",
      secretAccessKey: "secret",
      client,
    });

    await p.promoteObject(
      "staging/organizations/org-1/uuid-1",
      "organizations/org-1/attachments/uuid-2",
    );

    expect(send).toHaveBeenCalledTimes(2);
    const [copy, del] = send.mock.calls.map(([command]) => command.input);
    expect(copy).toMatchObject({
      Bucket: "sarbase-files",
      Key: "organizations/org-1/attachments/uuid-2",
      CopySource: "sarbase-files/staging/organizations/org-1/uuid-1",
    });
    expect(del).toMatchObject({
      Bucket: "sarbase-files",
      Key: "staging/organizations/org-1/uuid-1",
    });
  });

  it("pins the promotion copy to the verified ETag", async () => {
    const send = vi.fn().mockResolvedValue({});
    const p = new S3FileStorageProvider({
      bucket: "sarbase-files",
      region: "us-east-1",
      accessKeyId: "key",
      secretAccessKey: "secret",
      client: { send } as never,
    });

    await p.promoteObject(
      "staging/organizations/org-1/uuid-1",
      "organizations/org-1/attachments/uuid-2",
      { ifMatchEtag: '"etag-observed-at-verify"' },
    );

    const [copy] = send.mock.calls.map(([command]) => command.input);
    expect(copy.CopySourceIfMatch).toBe('"etag-observed-at-verify"');
  });

  it("maps a failed copy precondition to precondition_failed", async () => {
    const send = vi.fn().mockRejectedValue(
      new S3ServiceException({
        name: "PreconditionFailed",
        $fault: "client",
        $metadata: { httpStatusCode: 412 },
      }),
    );
    const p = new S3FileStorageProvider({
      bucket: "b",
      region: "r",
      accessKeyId: "k",
      secretAccessKey: "s",
      client: { send } as never,
    });

    await expect(
      p.promoteObject("a/b", "c/d", { ifMatchEtag: '"stale"' }),
    ).rejects.toMatchObject({
      name: "StorageError",
      code: "precondition_failed",
    });
  });

  it("normalizes copy failures and tolerates cleanup failures", async () => {
    const failingCopy = { send: vi.fn().mockRejectedValue(new Error("boom")) };
    const p = new S3FileStorageProvider({
      bucket: "b",
      region: "r",
      accessKeyId: "k",
      secretAccessKey: "s",
      client: failingCopy as never,
    });
    await expect(p.promoteObject("a/b", "c/d")).rejects.toBeInstanceOf(
      StorageError,
    );

    // Copy succeeds, staging delete fails — promote still succeeds; the
    // documented lifecycle rule expires the leftover staging object.
    const partialSend = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("denied"));
    const q = new S3FileStorageProvider({
      bucket: "b",
      region: "r",
      accessKeyId: "k",
      secretAccessKey: "s",
      client: { send: partialSend } as never,
    });
    await expect(q.promoteObject("a/b", "c/d")).resolves.toBeUndefined();
  });
});
