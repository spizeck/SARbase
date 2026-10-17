import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Sentry SDK v11 replaced sendDefaultPii with dataCollection and made
 * the defaults *permissive* — an upgrade that deletes our explicit
 * restrictive block silently re-enables collection of user info,
 * cookies, HTTP bodies, and database payloads. Both init files are
 * read as source and asserted to carry the restrictive posture so a
 * future dependency bump cannot widen collection unnoticed.
 */

const root = path.resolve(__dirname, "../../..");

const configs = {
  "sentry.server.config.ts": readFileSync(
    path.join(root, "sentry.server.config.ts"),
    "utf8",
  ),
  "src/instrumentation-client.ts": readFileSync(
    path.join(root, "src/instrumentation-client.ts"),
    "utf8",
  ),
};

const restrictiveFlags = [
  "userInfo: false",
  "cookies: false",
  "httpHeaders: false",
  "httpBodies: []",
  "databaseQueryData: false",
  "queues: false",
];

describe("sentry init privacy posture", () => {
  for (const [file, source] of Object.entries(configs)) {
    it(`${file} sets an explicit restrictive dataCollection block`, () => {
      expect(source).toContain("dataCollection: {");
      for (const flag of restrictiveFlags) {
        expect(
          source,
          `${file} missing "${flag}" — Sentry v11 defaults collect this category`,
        ).toContain(flag);
      }
      // The removed v10 option must not come back as a set key —
      // mentions in comments explaining the migration are fine.
      expect(source).not.toContain("sendDefaultPii:");
    });
  }
});
