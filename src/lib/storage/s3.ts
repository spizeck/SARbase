import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";

import {
  StorageError,
  type FileStorageProvider,
  type StorageObjectStat,
  type StorageObjectStream,
} from "./provider";
import { assertStorageKeyShape } from "./local";

export interface S3StorageOptions {
  bucket: string;
  region: string;
  /** Custom endpoint for S3-compatible stores (R2, MinIO, ...). */
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * S3-compatible object storage provider — the production-capable cloud
 * option for deployed environments (AWS S3, Cloudflare R2, MinIO for
 * self-hosted object storage). Buckets must be PRIVATE: this provider
 * serves bytes only through the authorized server download path and never
 * constructs, returns, or persists object URLs.
 *
 * Provider SDK errors are normalized to StorageError; raw error text is
 * kept in `cause` for server-side logging only — the AWS SDK can echo
 * endpoints, request IDs, and key material context.
 */
export class S3FileStorageProvider implements FileStorageProvider {
  readonly providerName = "s3";

  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(options: S3StorageOptions) {
    this.bucket = options.bucket;
    this.client = new S3Client({
      region: options.region,
      endpoint: options.endpoint,
      // Path-style addressing is required by MinIO and most S3-compatible
      // endpoints; harmless when an endpoint is not set for AWS S3 virtual
      // hosts, but only enable it when a custom endpoint is in play.
      forcePathStyle: Boolean(options.endpoint),
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    });
  }

  async put(key: string, body: Uint8Array, contentType: string) {
    assertStorageKeyShape(key);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          // No canned ACL: buckets with Object Ownership
          // BucketOwnerEnforced (the AWS default) reject ACL headers
          // outright. Bucket policy/privacy is the operator's control —
          // SARbase never constructs public object URLs.
        }),
      );
    } catch (error) {
      throw mapS3Error(error, "write");
    }
  }

  async openRead(key: string): Promise<StorageObjectStream> {
    assertStorageKeyShape(key);
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!response.Body) {
        throw new StorageError(
          "provider_error",
          "Object storage returned an empty body.",
        );
      }
      const webStream = response.Body.transformToWebStream();
      return {
        stream: webStream as ReadableStream<Uint8Array>,
        sizeBytes: response.ContentLength ?? 0,
      };
    } catch (error) {
      throw mapS3Error(error, "read");
    }
  }

  async head(key: string): Promise<StorageObjectStat | null> {
    assertStorageKeyShape(key);
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        sizeBytes: response.ContentLength ?? 0,
        contentType: response.ContentType ?? null,
      };
    } catch (error) {
      if (isS3NotFound(error)) {
        return null;
      }
      throw mapS3Error(error, "read");
    }
  }

  async delete(key: string) {
    assertStorageKeyShape(key);
    try {
      // S3 delete is idempotent — a missing key is already deleted.
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch (error) {
      throw mapS3Error(error, "delete");
    }
  }
}

function isS3NotFound(error: unknown): boolean {
  return error instanceof NoSuchKey || error instanceof NotFound;
}

function mapS3Error(error: unknown, operation: string): StorageError {
  if (error instanceof StorageError) {
    return error;
  }
  if (isS3NotFound(error)) {
    return new StorageError(
      "object_not_found",
      "The stored object does not exist.",
      error,
    );
  }
  if (error instanceof S3ServiceException) {
    const status = error.$metadata?.httpStatusCode ?? 0;
    if (status === 404) {
      return new StorageError(
        "object_not_found",
        "The stored object does not exist.",
        error,
      );
    }
    if (status >= 500 || status === 429 || status === 0) {
      return new StorageError(
        "provider_unavailable",
        `Object storage ${operation} failed; retry may succeed.`,
        error,
      );
    }
    return new StorageError(
      "provider_error",
      `Object storage ${operation} failed.`,
      error,
    );
  }
  // DNS/TLS/timeout failures arrive as plain errors.
  return new StorageError(
    "provider_unavailable",
    `Object storage ${operation} failed; retry may succeed.`,
    error,
  );
}
