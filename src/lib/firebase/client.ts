import { getApp, getApps, initializeApp, type FirebaseApp } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";

import { tryParseFirebaseClientEnvironment } from "@/lib/env";

/**
 * Browser-side Firebase client — lazily initialized so importing this
 * module never crashes an unconfigured deployment. `null` means
 * "authentication is not configured"; callers render that state
 * explicitly instead of throwing.
 */
let cachedApp: FirebaseApp | null | undefined;
let cachedAuth: Auth | null | undefined;

export function getFirebaseClientAuth(): Auth | null {
  if (typeof window === "undefined") {
    return null;
  }
  if (cachedAuth !== undefined) {
    return cachedAuth;
  }

  const env = tryParseFirebaseClientEnvironment();
  if (!env) {
    cachedAuth = null;
    return cachedAuth;
  }

  cachedApp =
    getApps().length > 0
      ? getApp()
      : initializeApp({
          apiKey: env.NEXT_PUBLIC_FIREBASE_API_KEY,
          authDomain: env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
          projectId: env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
          appId: env.NEXT_PUBLIC_FIREBASE_APP_ID,
        });
  cachedAuth = getAuth(cachedApp);
  return cachedAuth;
}
