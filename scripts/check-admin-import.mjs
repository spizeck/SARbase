#!/usr/bin/env node
// Plain-Node smoke check for the Firebase Admin 14 import/runtime
// contract the Vercel deployment relies on (production /login 500
// ERR_REQUIRE_ESM; fix pattern proven in contract-builder PR #122).
//
// Why this exists: firebase-admin@14's auth graph pulls jwks-rsa -> jose.
// Unpinned jose@6 is ESM-only, so a CJS bundle that require()s it crashes
// at boot with ERR_REQUIRE_ESM. The repo guards that two ways:
//   - scoped override `jwks-rsa -> jose@5.10.0` in package.json
//   - serverExternalPackages: ["firebase-admin"] in next.config.ts so
//     Node resolves the chain natively instead of through the bundle
//
// This script needs no credentials, no emulator, and no network — it only
// resolves and require()s the entrypoints the app imports. Run it from
// the repo root: `npm run check:admin-import`.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);

let failures = 0;
const ok = (msg) => console.log(`  ok    ${msg}`);
const fail = (msg) => {
  failures++;
  console.error(`  FAIL  ${msg}`);
};

// `firebase-admin/package.json` is not exported, so resolve an entrypoint
// file and walk up to the owning package.json (skipping per-dist stubs
// like jose's dist/node/cjs/package.json, which carry no name field).
function pkgFor(spec, paths) {
  let dir = path.dirname(require.resolve(spec, { paths }));
  while (true) {
    const pkgPath = path.join(dir, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (pkg.name) return pkg;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`no package.json found for '${spec}'`);
    }
    dir = parent;
  }
}

// 1. The Admin SDK major line this configuration was validated against.
const admin = pkgFor("firebase-admin/app");
if (Number(admin.version.split(".")[0]) === 14) {
  ok(`firebase-admin@${admin.version}`);
} else {
  fail(`firebase-admin@${admin.version} — expected 14.x`);
}

// 2. Every modular entrypoint the app imports must require() cleanly
//    under plain CommonJS — the operation Vercel's CJS runtime performs.
for (const entry of ["firebase-admin/app", "firebase-admin/auth"]) {
  try {
    require(entry);
    ok(`require('${entry}')`);
  } catch (err) {
    fail(`require('${entry}') -> ${err?.code || err}`);
  }
}

// 3. jwks-rsa's jose must stay CJS-compatible. Node >= 20.19 can require()
//    ESM, so a bare require() of jose@6 would pass here while still
//    killing the bundled Vercel build — assert the package format instead:
//    the jose jwks-rsa resolves must declare a CommonJS entrypoint.
try {
  const jwksDir = path.dirname(require.resolve("jwks-rsa/package.json"));
  const jose = pkgFor("jose", [jwksDir]);
  const dot = jose.exports?.["."];
  const hasCjsEntry =
    jose.exports === undefined
      ? typeof jose.main === "string"
      : dot != null &&
        typeof dot === "object" &&
        (typeof dot.require === "string" ||
          (dot.node != null && typeof dot.node.require === "string"));
  if (hasCjsEntry) {
    ok(`jwks-rsa -> jose@${jose.version} has a CJS entrypoint`);
  } else {
    fail(`jwks-rsa -> jose@${jose.version} is ESM-only (ERR_REQUIRE_ESM risk)`);
  }
} catch (err) {
  fail(`resolving jwks-rsa -> jose -> ${err?.code || err}`);
}

if (failures > 0) {
  console.error(`\ncheck:admin-import failed (${failures} problem(s))`);
  process.exit(1);
}
console.log("\ncheck:admin-import passed");
