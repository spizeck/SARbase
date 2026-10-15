import { createHash } from "node:crypto";

import {
  StorageError,
  type DirectUploadTarget,
  type FileStorageProvider,
  type StorageErrorCode,
  type StorageObjectStat,
  type StorageObjectStream,
} from "./provider";

/**
 * Deterministic in-process provider for tests and credential-free
 * development. It NEVER touches disk or network — objects live in a Map.
 *
 * Failure injection: `failNext` queues StorageError codes consumed by the
 * next matching operation call so tests can script "put succeeds, delete
 * fails" or "DB write fails after object stored" deterministically.
 *
 * Never selectable in a real production deployment — resolve.ts fails
 * closed there.
 */
export class InMemoryFileStorageProvider implements FileStorageProvider {
  /** Widened to `string` so test subclasses can masquerade as "s3". */
  readonly providerName: string = "memory";

  readonly objects = new Map<
    string,
    { body: Uint8Array; contentType: string; etag: string }
  >();
  readonly calls: { op: string; key: string }[] = [];

  /** Failures consumed in order, applied to the next call of any op. */
  private script: StorageErrorCode[] = [];

  failNext(...codes: StorageErrorCode[]) {
    this.script.push(...codes);
  }

  private maybeFail(op: string, key: string) {
    this.calls.push({ op, key });
    const code = this.script.shift();
    if (code) {
      throw new StorageError(code, `Injected storage failure: ${code}`);
    }
  }

  async put(key: string, body: Uint8Array, contentType: string) {
    this.maybeFail("put", key);
    const etag = `mem-${createHash("sha256").update(body).digest("hex").slice(0, 16)}`;
    this.objects.set(key, {
      body: new Uint8Array(body),
      contentType,
      // A cheap content etag: re-uploading different bytes (the grant
      // replay CodeRabbit flagged) produces a different version token.
      etag,
    });
    return { versionId: null, etag };
  }

  async openRead(key: string): Promise<StorageObjectStream> {
    this.maybeFail("openRead", key);
    const object = this.objects.get(key);
    if (!object) {
      throw new StorageError(
        "object_not_found",
        "The stored object does not exist.",
      );
    }
    const body = object.body;
    return {
      stream: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(body);
          controller.close();
        },
      }),
      sizeBytes: body.byteLength,
    };
  }

  async head(key: string): Promise<StorageObjectStat | null> {
    this.maybeFail("head", key);
    const object = this.objects.get(key);
    if (!object) {
      return null;
    }
    return {
      sizeBytes: object.body.byteLength,
      contentType: object.contentType,
      etag: object.etag,
    };
  }

  async delete(key: string): Promise<void> {
    this.maybeFail("delete", key);
    this.objects.delete(key);
  }

  /**
   * Fake direct-upload capability for tests: the "URL" is opaque and
   * never fetched — tests stage bytes with `put(stagingKey, ...)`.
   */
  async createUploadTarget(
    key: string,
    options: {
      contentType: string;
      sizeBytes: number;
      expiresInSeconds: number;
    },
  ): Promise<DirectUploadTarget> {
    this.maybeFail("createUploadTarget", key);
    return {
      url: `memory://upload/${key}`,
      method: "POST",
      fields: {
        key,
        "Content-Type": options.contentType,
        Policy: "fake-policy",
        "X-Amz-Signature": "fake-signature",
      },
      expiresAt: new Date(Date.now() + options.expiresInSeconds * 1000),
    };
  }

  async promoteObject(
    stagingKey: string,
    finalKey: string,
    options?: { ifMatchEtag?: string },
  ): Promise<{ versionId: string | null; etag: string | null }> {
    this.maybeFail("promoteObject", stagingKey);
    const object = this.objects.get(stagingKey);
    if (!object) {
      throw new StorageError(
        "object_not_found",
        "The stored object does not exist.",
      );
    }
    if (options?.ifMatchEtag && object.etag !== options.ifMatchEtag) {
      throw new StorageError(
        "precondition_failed",
        "The stored object changed while it was being verified.",
      );
    }
    this.objects.set(finalKey, object);
    this.objects.delete(stagingKey);
    return { versionId: null, etag: object.etag };
  }

  // No tag store — scan reconciliation reports "no tag" unless a test
  // subclass provides one.
  async getObjectTag(
    key: string,
    tagKey: string,
    versionId?: string | null,
  ): Promise<string | null> {
    void key;
    void tagKey;
    void versionId;
    return null;
  }
}
