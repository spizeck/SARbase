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
              group: ["firebase", "firebase/*"],
              message:
                "Import from @firebase/app or @firebase/auth instead — the firebase umbrella reintroduces the firestore/gRPC subtree (issue #57).",
            },
          ],
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
