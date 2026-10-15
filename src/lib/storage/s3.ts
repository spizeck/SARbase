import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  GetObjectTaggingCommand,
  HeadObjectCommand,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";

import {
  StorageError,
  type DirectUploadTarget,
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
  /** Test seam — production code leaves this unset. */
  client?: S3Client;
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
    this.client =
      options.client ??
      new S3Client({
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
        // Recent SDK defaults compute a CRC32 body checksum and sign it —
        // a presigned URL then demands a header a browser cannot produce.
        // "WHEN_REQUIRED" keeps checksums off unless an API needs one;
        // integrity is verified server-side (SHA-256) at finalize instead.
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
      });
  }

  async put(key: string, body: Uint8Array, contentType: string) {
    assertStorageKeyShape(key);
    try {
      const response = await this.client.send(
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
      return {
        versionId: response.VersionId ?? null,
        etag: response.ETag ?? null,
      };
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
        etag: response.ETag ?? null,
        versionId: response.VersionId ?? null,
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

  /**
   * Presigned POST target for one exact key — the direct-upload path
   * that keeps file bytes off the hosting platform entirely. The POST
   * policy binds, at the store edge: the exact key, the declared
   * Content-Type (exact-match condition), and the declared byte size
   * (content-length-range pinned to a single value). A browser cannot
   * relabel or resize the object it uploads; the finalize step still
   * re-verifies everything against the stored bytes.
   */
  async createUploadTarget(
    key: string,
    options: {
      contentType: string;
      sizeBytes: number;
      expiresInSeconds: number;
    },
  ): Promise<DirectUploadTarget> {
    assertStorageKeyShape(key);
    const expiresAt = new Date(Date.now() + options.expiresInSeconds * 1000);
    const { url, fields } = await createPresignedPost(this.client, {
      Bucket: this.bucket,
      Key: key,
      Conditions: [
        ["content-length-range", options.sizeBytes, options.sizeBytes],
      ],
      Fields: { "Content-Type": options.contentType },
      Expires: options.expiresInSeconds,
    });
    return { url, method: "POST", fields, expiresAt };
  }

  /**
   * Server-side copy staging → final (S3 CopyObject never round-trips
   * bytes through this process), then best-effort removal of the
   * staging object. A failed staging delete leaves a duplicate that the
   * documented staging-prefix lifecycle rule expires — the final object
   * is authoritative and the operation still succeeds.
   *
   * `ifMatchEtag` sets x-amz-copy-source-if-match: the presigned POST
   * stays valid until expiry, so the grant holder could re-upload the
   * staging object between our verify pass and this copy. Pinning the
   * copy to the observed ETag makes a swapped object fail the
   * promotion (S3 answers 412 PreconditionFailed) instead of recording
   * unverified bytes under a mismatched checksum.
   */
  async promoteObject(
    stagingKey: string,
    finalKey: string,
    options?: { ifMatchEtag?: string },
  ) {
    assertStorageKeyShape(stagingKey);
    assertStorageKeyShape(finalKey);
    let stored: { versionId: string | null; etag: string | null };
    try {
      const copy = await this.client.send(
        new CopyObjectCommand({
          Bucket: this.bucket,
          Key: finalKey,
          CopySource: `${this.bucket}/${stagingKey}`,
          CopySourceIfMatch: options?.ifMatchEtag,
        }),
      );
      // The version identity of the NEW object — scan results bind to
      // this, not to the staging object that was verified.
      stored = {
        versionId: copy.VersionId ?? null,
        etag: copy.CopyObjectResult?.ETag ?? null,
      };
    } catch (error) {
      throw mapS3Error(error, "write");
    }
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: stagingKey }),
      );
    } catch {
      // Duplicate staging object — lifecycle expiry cleans it; a
      // failed cleanup delete must not fail a completed promote.
    }
    return stored;
  }

  /**
   * Read one object tag (used by scan reconciliation for
   * `GuardDutyMalwareScanStatus`). Requires `s3:GetObjectTagging` on the
   * application credentials — an AccessDenied surfaces as a provider
   * error, and a missing object/tag resolves to null.
   */
  async getObjectTag(
    key: string,
    tagKey: string,
    versionId?: string | null,
  ): Promise<string | null> {
    assertStorageKeyShape(key);
    try {
      const response = await this.client.send(
        new GetObjectTaggingCommand({
          Bucket: this.bucket,
          Key: key,
          VersionId: versionId ?? undefined,
        }),
      );
      return response.TagSet?.find((tag) => tag.Key === tagKey)?.Value ?? null;
    } catch (error) {
      if (isS3NotFound(error)) {
        return null;
      }
      throw mapS3Error(error, "read");
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
    if (status === 412) {
      // Conditional copy (copy-source-if-match): the staged object was
      // replaced after verification — the finalize must restart, not
      // record whatever arrived last.
      return new StorageError(
        "precondition_failed",
        "The stored object changed while it was being verified.",
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
