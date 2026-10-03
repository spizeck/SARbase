import { randomUUID } from "node:crypto";
import { mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";

import {
  StorageError,
  type FileStorageProvider,
  type StorageObjectStat,
  type StorageObjectStream,
} from "./provider";

/**
 * Local filesystem provider — development and self-hosting.
 *
 * Objects live under a configured root directory that must be OUTSIDE the
 * source tree and excluded from version control. Path safety is enforced
 * twice: keys are restricted to a strict character/shape allowlist, and
 * the resolved path is verified to stay inside the root before any I/O.
 * An untrusted storage key can never escape the root directory.
 *
 * Self-hosters: the root directory requires its own backup — PostgreSQL
 * dumps do not contain file bytes. See docs/attachments.md.
 */
export class LocalFileStorageProvider implements FileStorageProvider {
  readonly providerName = "local";

  private readonly root: string;

  constructor(options: { root: string }) {
    const root = resolve(options.root);
    if (!root) {
      throw new StorageError("config_missing", "Local storage root is empty.");
    }
    this.root = root;
  }

  /** Absolute path for `key`, or throws if the key would escape root. */
  private resolveKey(key: string): string {
    assertStorageKeyShape(key);
    const fullPath = resolve(join(this.root, ...key.split("/")));
    if (fullPath !== this.root && !fullPath.startsWith(this.root + sep)) {
      throw new StorageError(
        "provider_error",
        "Storage key resolved outside the storage root.",
      );
    }
    return fullPath;
  }

  async put(key: string, body: Uint8Array) {
    const fullPath = this.resolveKey(key);
    try {
      await mkdir(dirname(fullPath), { recursive: true });
      // Write to a sibling temp file and rename so readers never observe a
      // partially-written object under the final key.
      const tmpPath = join(dirname(fullPath), `.tmp-${randomUUID()}`);
      await writeFileAtomic(tmpPath, body);
      await rename(tmpPath, fullPath);
    } catch (error) {
      throw mapLocalFsError(error, "write");
    }
  }

  async openRead(key: string): Promise<StorageObjectStream> {
    const fullPath = this.resolveKey(key);
    try {
      // Open the handle synchronously so a missing object throws here —
      // before headers are sent — rather than mid-stream.
      const handle = await open(fullPath, "r");
      const info = await handle.stat();
      const node = handle.createReadStream();
      return {
        stream: Readable.toWeb(node) as ReadableStream<Uint8Array>,
        sizeBytes: info.size,
      };
    } catch (error) {
      throw mapLocalFsError(error, "read");
    }
  }

  async head(key: string): Promise<StorageObjectStat | null> {
    const fullPath = this.resolveKey(key);
    try {
      const info = await stat(fullPath);
      return { sizeBytes: info.size, contentType: null };
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw mapLocalFsError(error, "read");
    }
  }

  async delete(key: string) {
    const fullPath = this.resolveKey(key);
    try {
      await unlink(fullPath);
    } catch (error) {
      // Idempotent: a missing object is already "deleted".
      if (!isNotFound(error)) {
        throw mapLocalFsError(error, "delete");
      }
    }
  }
}

async function writeFileAtomic(path: string, body: Uint8Array) {
  const handle = await open(path, "w");
  try {
    await handle.write(body);
  } finally {
    await handle.close();
  }
}

/**
 * Strict storage-key shape: `/`-separated segments of unreserved
 * characters only. Rejects absolute paths, separators, traversal, and
 * control characters before path joining ever happens.
 */
export function assertStorageKeyShape(key: string): void {
  if (
    key.length === 0 ||
    key.length > 512 ||
    !/^[A-Za-z0-9_-]+(\/[A-Za-z0-9._-]+)*$/.test(key) ||
    key.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new StorageError(
      "provider_error",
      "Storage key failed shape validation.",
    );
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "ENOENT"
  );
}

function mapLocalFsError(error: unknown, operation: string): StorageError {
  if (error instanceof StorageError) {
    return error;
  }
  if (isNotFound(error)) {
    return new StorageError(
      "object_not_found",
      "The stored object does not exist.",
      error,
    );
  }
  return new StorageError(
    "provider_error",
    `Local storage ${operation} failed.`,
    error,
  );
}
