import { createHmac, timingSafeEqual } from "node:crypto";

import { parseStorageEnvironment } from "@/lib/env";

import { StorageConfigError } from "./provider";

/**
 * Upload tickets — the server-side grant half of direct-to-S3 uploads.
 *
 * A presigned URL authorizes the BROWSER↔STORE leg (write one exact
 * key, briefly). The ticket authorizes the FINALIZE leg back in the
 * app: it proves that this staging key/final key pair was issued to
 * this actor for this declared upload, inside the expiry window. A
 * caller cannot mint a key pair itself — the only way a staging key
 * becomes a recorded attachment is a ticket the server signed.
 *
 * The ticket is opaque to the client: it is returned verbatim with the
 * upload grant and echoed back at finalize. Its payload is integrity-
 * protected, not secret — keys and metadata already travel to the
 * client in the grant response.
 */

const TICKET_VERSION = "v1";

/** Fields bound into the grant — all verified again at finalize. */
export interface UploadTicketPayload {
  /** The exact staging object the presigned URL may write. */
  stagingKey: string;
  /** The object key the attachment will be recorded under. */
  finalKey: string;
  /** The identity the grant was issued to. */
  actorId: string;
  /** Declared media type and byte size authorized at prepare time. */
  mediaType: string;
  sizeBytes: number;
  /** Epoch seconds — grants are short-lived. */
  expiresAt: number;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(payloadSegment: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(payloadSegment)
    .digest("base64url");
}

/** Mint a ticket string the client echoes back verbatim at finalize. */
export function signUploadTicket(
  payload: UploadTicketPayload,
  secret: string,
): string {
  const payloadSegment = base64url(
    JSON.stringify({ v: TICKET_VERSION, ...payload }),
  );
  return `${TICKET_VERSION}.${payloadSegment}.${sign(payloadSegment, secret)}`;
}

/**
 * Verify a presented ticket and return its payload, or null when the
 * ticket is malformed, forged, or expired. The caller still compares
 * every bound field against the request it claims to authorize — the
 * ticket proves authenticity, the caller enforces semantics.
 */
export function verifyUploadTicket(
  ticket: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): UploadTicketPayload | null {
  const [version, payloadSegment, signature] = ticket.split(".");
  if (version !== TICKET_VERSION || !payloadSegment || !signature) {
    return null;
  }
  const expected = sign(payloadSegment, secret);
  const expectedBytes = Buffer.from(expected);
  const signatureBytes = Buffer.from(signature);
  if (
    expectedBytes.length !== signatureBytes.length ||
    !timingSafeEqual(expectedBytes, signatureBytes)
  ) {
    return null;
  }
  let decoded: UploadTicketPayload & { v?: string };
  try {
    decoded = JSON.parse(
      Buffer.from(payloadSegment, "base64url").toString("utf8"),
    ) as UploadTicketPayload & { v?: string };
  } catch {
    return null;
  }
  if (decoded.v !== TICKET_VERSION) {
    return null;
  }
  delete decoded.v;
  const payload = decoded;
  if (
    typeof payload.stagingKey !== "string" ||
    typeof payload.finalKey !== "string" ||
    typeof payload.actorId !== "string" ||
    typeof payload.mediaType !== "string" ||
    typeof payload.sizeBytes !== "number" ||
    typeof payload.expiresAt !== "number" ||
    payload.expiresAt <= nowSeconds
  ) {
    return null;
  }
  return payload;
}

/**
 * The HMAC key for ticket signing, derived from the object-store
 * credential. Direct upload is only offered by providers configured
 * with a server-side secret today (S3), so derivation needs no extra
 * environment variable — rotating the store credential rotates grant
 * signing with it. Fails closed when no derivable secret exists.
 */
export function resolveUploadTicketSecret(
  values: Record<string, string | undefined> = process.env,
): string {
  const env = parseStorageEnvironment(values);
  if (!env.FILE_STORAGE_S3_SECRET_ACCESS_KEY) {
    throw new StorageConfigError(
      "Direct uploads require a signing secret derived from the object-store credential (FILE_STORAGE_S3_SECRET_ACCESS_KEY).",
    );
  }
  return createHmac("sha256", env.FILE_STORAGE_S3_SECRET_ACCESS_KEY)
    .update("sarbase/upload-ticket/" + TICKET_VERSION)
    .digest("hex");
}
