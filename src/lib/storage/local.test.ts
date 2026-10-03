import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LocalFileStorageProvider } from "./local";
import { StorageError } from "./provider";

/** Local filesystem provider — real temp directory, no network. */

let root: string;
let provider: LocalFileStorageProvider;

async function readAll(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

describe("LocalFileStorageProvider", () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "sarbase-storage-test-"));
    provider = new LocalFileStorageProvider({ root });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("puts, reads, heads, and deletes an object", async () => {
    const key = "organizations/org1/attachments/abc123";
    const body = new TextEncoder().encode("file contents");
    await provider.put(key, body);

    const stat = await provider.head(key);
    expect(stat).not.toBeNull();
    expect(stat!.sizeBytes).toBe(body.byteLength);

    const read = await provider.openRead(key);
    expect(read.sizeBytes).toBe(body.byteLength);
    const bytes = await readAll(read.stream);
    expect(Buffer.from(bytes).toString()).toBe("file contents");

    await provider.delete(key);
    expect(await provider.head(key)).toBeNull();
    // Delete is idempotent — a missing key is a no-op success.
    await provider.delete(key);
  });

  it("creates intermediate directories and never leaves temp files", async () => {
    await provider.put("a/b/c/object", new Uint8Array([1]));
    const leaf = await readdir(join(root, "a", "b", "c"));
    expect(leaf).toEqual(["object"]);
  });

  it("rejects keys that would escape the root", async () => {
    for (const bad of [
      "../escape",
      "a/../../escape",
      "..\\escape",
      "/absolute/path",
      "a//b",
      "",
      "segment/with space/ok",
    ]) {
      await expect(provider.head(bad)).rejects.toBeInstanceOf(StorageError);
      await expect(provider.head(bad)).rejects.toMatchObject({
        code: "provider_error",
      });
    }
    // Nothing written outside the root — the root itself is untouched by
    // failed validation.
    expect(await readdir(root)).not.toContain("escape");
  });

  it("reports missing objects as object_not_found", async () => {
    await expect(provider.openRead("missing/key")).rejects.toMatchObject({
      code: "object_not_found",
    });
    expect(await provider.head("missing/key")).toBeNull();
  });
});
