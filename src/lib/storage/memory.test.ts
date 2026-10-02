import { describe, expect, it } from "vitest";

import { InMemoryFileStorageProvider } from "./memory";
import { StorageError } from "./provider";

/** Deterministic in-memory provider — put/get/head/delete + failure injection. */

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += Buffer.from(value).toString();
  }
  return text;
}

describe("InMemoryFileStorageProvider", () => {
  it("round-trips bytes by key", async () => {
    const provider = new InMemoryFileStorageProvider();
    await provider.put("k1", new TextEncoder().encode("data"), "text/plain");
    const read = await provider.openRead("k1");
    expect(read.sizeBytes).toBe(4);
    expect(await readAll(read.stream)).toBe("data");
    expect((await provider.head("k1"))?.sizeBytes).toBe(4);
  });

  it("treats missing objects as not-found and delete as idempotent", async () => {
    const provider = new InMemoryFileStorageProvider();
    expect(await provider.head("nope")).toBeNull();
    await expect(provider.openRead("nope")).rejects.toMatchObject({
      code: "object_not_found",
    });
    await provider.delete("nope"); // no-op success
  });

  it("injects scripted failures consumed in order", async () => {
    const provider = new InMemoryFileStorageProvider();
    provider.failNext("provider_unavailable");
    await expect(
      provider.put("k", new Uint8Array([1]), "text/plain"),
    ).rejects.toMatchObject({ code: "provider_unavailable" });
    // Script exhausted — the next call succeeds.
    await provider.put("k", new Uint8Array([1]), "text/plain");
    expect(await provider.head("k")).not.toBeNull();
  });

  it("isolates stored bytes from caller mutation", async () => {
    const provider = new InMemoryFileStorageProvider();
    const body = new Uint8Array([1, 2, 3]);
    await provider.put("k", body, "application/octet-stream");
    body[0] = 99;
    const read = await provider.openRead("k");
    const reader = read.stream.getReader();
    const { value } = await reader.read();
    expect(value![0]).toBe(1);
  });

  it("throws StorageError, not arbitrary values, for injected failures", async () => {
    const provider = new InMemoryFileStorageProvider();
    provider.failNext("provider_error");
    await expect(provider.delete("k")).rejects.toBeInstanceOf(StorageError);
  });
});
