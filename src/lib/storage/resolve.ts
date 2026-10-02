import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseAppEnvironment, parseStorageEnvironment } from "@/lib/env";

import { LocalFileStorageProvider } from "./local";
import { S3FileStorageProvider } from "./s3";
import { StorageConfigError, type FileStorageProvider } from "./provider";

/**
 * Resolve the configured file storage provider from the environment.
 *
 * Selection rules (deliberately fail closed):
 * - `FILE_STORAGE_PROVIDER=s3` → S3-compatible object store; requires
 *   bucket, region, and credentials — missing pieces throw
 *   StorageConfigError at resolution time, not a cryptic SDK error.
 * - `FILE_STORAGE_PROVIDER=local` → the local filesystem provider under
 *   FILE_STORAGE_LOCAL_ROOT (or an OS temp-dir default in development).
 * - Unset → local with a temp-dir default in development/test only. In a
 *   real production deployment (VERCEL_ENV=production or
 *   NODE_ENV=production) an unset provider is a StorageConfigError —
 *   silently writing production evidence into an ephemeral filesystem
 *   would lose files and backups. Operators choose "s3" explicitly, or
 *   "local" with an explicit root for self-hosting.
 * - The in-memory fake is never selectable — tests inject it directly.
 *
 * Resolution is lazy — called at first use so `next build` with zero
 * env vars never touches provider config.
 */
export function resolveFileStorageProvider(
  values: Record<string, string | undefined> = process.env,
): FileStorageProvider {
  const env = parseStorageEnvironment(values);
  const app = parseAppEnvironment(values);
  const isProduction =
    app.VERCEL_ENV === "production" || process.env.NODE_ENV === "production";

  if (isProduction && !env.FILE_STORAGE_PROVIDER) {
    throw new StorageConfigError(
      "FILE_STORAGE_PROVIDER is not set. Production deployments must choose a provider explicitly ('s3', or 'local' with FILE_STORAGE_LOCAL_ROOT for self-hosting).",
    );
  }
  const selection = env.FILE_STORAGE_PROVIDER ?? "local";

  if (selection === "s3") {
    if (
      !env.FILE_STORAGE_S3_BUCKET ||
      !env.FILE_STORAGE_S3_REGION ||
      !env.FILE_STORAGE_S3_ACCESS_KEY_ID ||
      !env.FILE_STORAGE_S3_SECRET_ACCESS_KEY
    ) {
      throw new StorageConfigError(
        "File storage provider 's3' requires FILE_STORAGE_S3_BUCKET, FILE_STORAGE_S3_REGION, FILE_STORAGE_S3_ACCESS_KEY_ID and FILE_STORAGE_S3_SECRET_ACCESS_KEY.",
      );
    }
    return new S3FileStorageProvider({
      bucket: env.FILE_STORAGE_S3_BUCKET,
      region: env.FILE_STORAGE_S3_REGION,
      endpoint: env.FILE_STORAGE_S3_ENDPOINT,
      accessKeyId: env.FILE_STORAGE_S3_ACCESS_KEY_ID,
      secretAccessKey: env.FILE_STORAGE_S3_SECRET_ACCESS_KEY,
    });
  }

  // selection === "local"
  const root =
    env.FILE_STORAGE_LOCAL_ROOT ??
    (isProduction ? undefined : join(tmpdir(), "sarbase-file-storage"));
  if (!root) {
    throw new StorageConfigError(
      "File storage provider 'local' requires FILE_STORAGE_LOCAL_ROOT in production. Set FILE_STORAGE_PROVIDER=s3 for object storage, or an explicit local root for self-hosting.",
    );
  }
  return new LocalFileStorageProvider({ root });
}

let cached: FileStorageProvider | null = null;

/** Process-wide lazy singleton — resolution happens on first use. */
export function getFileStorageProvider(): FileStorageProvider {
  cached ??= resolveFileStorageProvider();
  return cached;
}
