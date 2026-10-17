import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier/flat";

export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  prettier,
  {
    rules: {
      // Issue #57: the `firebase` umbrella package pulls
      // @firebase/firestore -> @grpc/grpc-js, a flagged subtree the app
      // never executes. Depend on @firebase/app + @firebase/auth
      // directly; firebase-admin remains the server-side SDK.
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "firebase",
                "firebase/*",
                // Internal firebase seam — not the npm umbrella.
                "!@/lib/firebase",
                "!@/lib/firebase/*",
              ],
              message:
                "Import from @firebase/app or @firebase/auth instead — the firebase umbrella reintroduces the firestore/gRPC subtree (issue #57).",
            },
          ],
        },
      ],
      // no-restricted-imports only sees static imports — catch
      // await import("firebase/...") too.
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression[source.value=/^firebase($|\\/)/]",
          message:
            "Import from @firebase/app or @firebase/auth instead — the firebase umbrella reintroduces the firestore/gRPC subtree (issue #57).",
        },
      ],
    },
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
  ]),
]);
