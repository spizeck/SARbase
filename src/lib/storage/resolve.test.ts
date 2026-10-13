import { describe, expect, it } from "vitest";

import { StorageConfigError } from "./provider";
import { resolveFileStorageProvider } from "./resolve";

const S3_ENV = {
  FILE_STORAGE_PROVIDER: "s3",
  FILE_STORAGE_S3_BUCKET: "sarbase-files",
  FILE_STORAGE_S3_REGION: "us-east-1",
  FILE_STORAGE_S3_ACCESS_KEY_ID: "key",
  FILE_STORAGE_S3_SECRET_ACCESS_KEY: "secret",
};

describe("resolveFileStorageProvider — preview isolation", () => {
  it("preview: refuses s3 without the preview opt-in flag", () => {
    expect(() =>
      resolveFileStorageProvider({ ...S3_ENV, VERCEL_ENV: "preview" }),
    ).toThrow(StorageConfigError);
  });

  it("preview: allows s3 with the deliberate opt-in", () => {
    const provider = resolveFileStorageProvider({
      ...S3_ENV,
      VERCEL_ENV: "preview",
      ALLOW_S3_IN_PREVIEW: "true",
    });
    expect(provider.providerName).toBe("s3");
  });

  it("preview: unconfigured storage falls back to the local provider", () => {
    const provider = resolveFileStorageProvider({ VERCEL_ENV: "preview" });
    expect(provider.providerName).toBe("local");
  });

  it("non-preview: s3 resolves normally", () => {
    const provider = resolveFileStorageProvider({
      ...S3_ENV,
      VERCEL_ENV: "production",
    });
    expect(provider.providerName).toBe("s3");
  });
});
