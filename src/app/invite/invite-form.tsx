"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  createUserWithEmailAndPassword,
  sendEmailVerification,
  signInWithEmailAndPassword,
  signOut,
} from "@firebase/auth";

import { getFirebaseClientAuth } from "@/lib/firebase/client";
import { inviteAuthErrorView } from "@/lib/invitation-accept";

import type { AcceptInvitationResult } from "./actions";

type BoundAcceptAction = (idToken: string) => Promise<AcceptInvitationResult>;

/**
 * Invitation acceptance form — sign in with an existing account or
 * register a new one, then hand the fresh Firebase ID token to the
 * server action, which verifies it and binds the identity to the
 * invitation.
 *
 * New accounts start UNVERIFIED in Firebase: registration sends a
 * Firebase verification email and asks the invitee to return and sign
 * in once verified — the server requires `email_verified` on the ID
 * token before the invitation is consumed.
 */
export function InviteAcceptForm({
  action,
  invitedEmail,
  configured,
}: {
  action: BoundAcceptAction;
  invitedEmail: string;
  configured: boolean;
}) {
  const router = useRouter();
  // Most invitees have never held an account, so registration is the
  // default tab; an existing account surfaces `email-already-in-use`
  // and flips to sign-in with a clear message.
  const [mode, setMode] = useState<"sign_in" | "register">("register");
  const [email, setEmail] = useState(invitedEmail);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (!configured) {
    return (
      <p className="text-sm text-neutral-600" role="alert">
        Authentication is not configured for this deployment. Contact the
        administrator.
      </p>
    );
  }

  async function acceptWith(idToken: string) {
    const result = await action(idToken);
    if (!result.ok) {
      setError(result.error ?? "The invitation could not be accepted.");
      return;
    }
    router.push("/org");
    router.refresh();
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setPending(true);

    try {
      const auth = getFirebaseClientAuth();
      if (!auth) {
        setError("Authentication is not available.");
        return;
      }

      if (mode === "register") {
        const credential = await createUserWithEmailAndPassword(
          auth,
          email.trim(),
          password,
        );
        try {
          // Return the invitee to THIS invitation after they verify.
          await sendEmailVerification(credential.user, {
            url: window.location.href,
          });
        } catch {
          // Best-effort: the account exists; an administrator can resend
          // the invitation if the verification email never arrives.
        }
        await signOut(auth);
        setPassword("");
        setMode("sign_in");
        setNotice(
          "Account created. We sent a verification email — click its link, then return here and sign in to accept the invitation.",
        );
        return;
      }

      const credential = await signInWithEmailAndPassword(
        auth,
        email.trim(),
        password,
      );
      const idToken = await credential.user.getIdToken();
      await acceptWith(idToken);
    } catch (err) {
      const view = inviteAuthErrorView(err, mode);
      if (view.switchMode) setMode(view.switchMode);
      setError(view.message);
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div
        className="flex gap-4 text-sm"
        role="tablist"
        aria-label="Account mode"
      >
        <button
          type="button"
          role="tab"
          aria-selected={mode === "register"}
          onClick={() => {
            setMode("register");
            setError(null);
          }}
          className={
            mode === "register"
              ? "font-medium text-neutral-900 underline underline-offset-4"
              : "text-neutral-500 hover:text-neutral-800"
          }
        >
          Create an account
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "sign_in"}
          onClick={() => {
            setMode("sign_in");
            setError(null);
          }}
          className={
            mode === "sign_in"
              ? "font-medium text-neutral-900 underline underline-offset-4"
              : "text-neutral-500 hover:text-neutral-800"
          }
        >
          I have an account
        </button>
      </div>

      <div>
        <label
          htmlFor="invite-email"
          className="block text-sm font-medium text-neutral-800"
        >
          Email
        </label>
        <input
          id="invite-email"
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
          htmlFor="invite-password"
          className="block text-sm font-medium text-neutral-800"
        >
          Password
        </label>
        <input
          id="invite-password"
          type="password"
          autoComplete={
            mode === "register" ? "new-password" : "current-password"
          }
          required
          minLength={mode === "register" ? 6 : undefined}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
        />
      </div>
      {notice && (
        <p className="text-sm text-neutral-700" role="status">
          {notice}
        </p>
      )}
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
        {pending
          ? mode === "register"
            ? "Creating account…"
            : "Signing in…"
          : mode === "register"
            ? "Create account"
            : "Sign in and accept"}
      </button>
    </form>
  );
}
