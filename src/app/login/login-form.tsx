"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { signInWithEmailAndPassword } from "firebase/auth";

import { getFirebaseClientAuth } from "@/lib/firebase/client";
import { tryParseFirebaseClientEnvironment } from "@/lib/env";

import { createSessionAction } from "./actions";

/**
 * Email/password sign-in. The Firebase client SDK performs credential
 * verification against the provider; this page then hands the resulting
 * ID token to the server, which verifies it independently and mints the
 * session cookie. The token never reaches the URL, logs, or storage.
 */
export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const configured = tryParseFirebaseClientEnvironment() !== null;

  if (!configured) {
    return (
      <p className="text-sm text-neutral-600" role="alert">
        Authentication is not configured for this deployment. Contact the
        administrator.
      </p>
    );
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);

    try {
      const auth = getFirebaseClientAuth();
      if (!auth) {
        setError("Authentication is not available.");
        return;
      }
      const credential = await signInWithEmailAndPassword(
        auth,
        email.trim(),
        password,
      );
      const idToken = await credential.user.getIdToken();
      const result = await createSessionAction(idToken);

      if (!result.ok) {
        setError(
          result.error === "account_disabled"
            ? "This account is disabled. Contact the administrator."
            : result.error === "not_configured"
              ? "Authentication is not configured on the server."
              : "Invalid email or password.",
        );
        return;
      }

      const next = searchParams.get("next");
      const target =
        next && next.startsWith("/") && !next.startsWith("//")
          ? next
          : "/account";
      router.push(target);
      router.refresh();
    } catch {
      setError("Invalid email or password.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div>
        <label
          htmlFor="login-email"
          className="block text-sm font-medium text-neutral-800"
        >
          Email
        </label>
        <input
          id="login-email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
        />
      </div>
      <div>
        <label
          htmlFor="login-password"
          className="block text-sm font-medium text-neutral-800"
        >
          Password
        </label>
        <input
          id="login-password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
        />
      </div>
      {error && (
        <p className="text-sm text-red-700" role="alert">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
