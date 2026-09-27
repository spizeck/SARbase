import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";

import { parseFirebaseAdminEnvironment } from "@/lib/env";

/**
 * Firebase Admin SDK — SERVER ONLY.
 *
 * Never import this module (or firebase-admin) from client components or
 * anything reachable by the browser bundle. Initialization is lazy:
 * the first call parses env and throws a named error when credentials
 * are absent — which keeps builds/CI secret-free while failing closed
 * at the auth boundary (an unconfigured deployment simply cannot issue
 * or verify sessions).
 */
let cachedAuth: Auth | null = null;

export function getFirebaseAuth(): Auth {
  if (cachedAuth) {
    return cachedAuth;
  }

  const env = parseFirebaseAdminEnvironment();
  const app =
    getApps()[0] ??
    initializeApp({
      credential: cert({
        projectId: env.FIREBASE_ADMIN_PROJECT_ID,
        clientEmail: env.FIREBASE_ADMIN_CLIENT_EMAIL,
        privateKey: env.FIREBASE_ADMIN_PRIVATE_KEY,
      }),
    });

  cachedAuth = getAuth(app);
  return cachedAuth;
}
