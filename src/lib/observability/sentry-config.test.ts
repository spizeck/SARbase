import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Sentry SDK v11 replaced sendDefaultPii with dataCollection and made
 * the defaults *permissive* — an upgrade that deletes our explicit
 * restrictive block silently re-enables collection of user info,
 * cookies, HTTP bodies, and database payloads. Both init files are
 * read as source and the argument passed to `Sentry.init` is asserted
 * to carry the restrictive posture — checking the whole file would let
 * an orphaned block pass while init runs on permissive defaults.
 */

const root = path.resolve(__dirname, "../../..");

/** The object literal handed to Sentry.init — everything between the
 *  call's opening brace and the statement that closes the call. */
function initBlock(source: string, file: string): string {
  const start = source.indexOf("Sentry.init({");
  expect(start, `${file} does not call Sentry.init`).toBeGreaterThan(-1);
  const end = source.indexOf("});", start);
  expect(end, `${file} Sentry.init call is unterminated`).toBeGreaterThan(
    start,
  );
  return source.slice(start, end);
}

const configs = {
  "sentry.server.config.ts": initBlock(
    readFileSync(path.join(root, "sentry.server.config.ts"), "utf8"),
    "sentry.server.config.ts",
  ),
  "src/instrumentation-client.ts": initBlock(
    readFileSync(path.join(root, "src/instrumentation-client.ts"), "utf8"),
    "src/instrumentation-client.ts",
  ),
};

const restrictiveFlags = [
  "userInfo: false",
  "cookies: false",
  "httpHeaders: false",
  "httpBodies: []",
  "document: false",
  "variables: false",
  "inputs: false",
  "outputs: false",
  "databaseQueryData: false",
  "queues: false",
  // Deliberately tighter than the v10 baseline: query strings carry
  // bearer tokens; frame locals are not redacted by the scrubber.
  "urlQueryParams: false",
  "stackFrameVariables: false",
];

describe("sentry init privacy posture", () => {
  for (const [file, init] of Object.entries(configs)) {
    it(`${file} passes an explicit restrictive dataCollection block to Sentry.init`, () => {
      expect(init).toContain("dataCollection: {");
      for (const flag of restrictiveFlags) {
        expect(
          init,
          `${file} missing "${flag}" inside Sentry.init — Sentry v11 defaults collect this category`,
        ).toContain(flag);
      }
      // The removed v10 option must not come back as a set key —
      // mentions in comments explaining the migration are fine.
      expect(init).not.toContain("sendDefaultPii:");
    });
  }
});
