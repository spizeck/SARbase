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
  readonly providerName = "memory";

  readonly objects = new Map<
    string,
    { body: Uint8Array; contentType: string }
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

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    this.maybeFail("put", key);
    this.objects.set(key, { body: new Uint8Array(body), contentType });
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

  async promoteObject(stagingKey: string, finalKey: string): Promise<void> {
    this.maybeFail("promoteObject", stagingKey);
    const object = this.objects.get(stagingKey);
    if (!object) {
      throw new StorageError(
        "object_not_found",
        "The stored object does not exist.",
      );
    }
    this.objects.set(finalKey, object);
    this.objects.delete(stagingKey);
  }
}
