import { FirebaseError } from "@firebase/app";

export type InviteAuthMode = "sign_in" | "register";

export interface InviteAuthErrorView {
  message: string;
  /** Switch tabs when the failure means the other mode applies. */
  switchMode?: InviteAuthMode;
}

/**
 * Maps a Firebase Auth failure from the invitation acceptance form to
 * user-facing copy. Firebase deliberately folds "no such account" and
 * "wrong password" into `auth/invalid-credential` so account existence
 * can't be probed — the wording must not reintroduce that distinction:
 * it tells a failed sign-in to consider registering without claiming
 * the account does not exist.
 */
export function inviteAuthErrorView(
  err: unknown,
  mode: InviteAuthMode,
): InviteAuthErrorView {
  if (!(err instanceof FirebaseError)) {
    return { message: "Something went wrong. Please try again." };
  }
  switch (err.code) {
    case "auth/email-already-in-use":
      return {
        message: "An account with this email already exists — sign in instead.",
        switchMode: "sign_in",
      };
    case "auth/weak-password":
      return { message: "Choose a password of at least 6 characters." };
    case "auth/too-many-requests":
      return {
        message: "Too many attempts. Please wait a moment and try again.",
      };
    case "auth/invalid-credential":
      return {
        message:
          mode === "sign_in"
            ? "Couldn't sign you in — either the password is wrong or no account exists for this email yet. If you haven't created an account, choose “Create an account” above."
            : "Invalid email or password.",
      };
    case "auth/user-disabled":
      return {
        message: "This account has been disabled. Contact the administrator.",
      };
    case "auth/network-request-failed":
      return {
        message:
          "Couldn't reach the sign-in service. Check your connection and try again.",
      };
    case "auth/operation-not-allowed":
      return {
        message:
          "Email sign-in isn't enabled for this deployment. Contact the administrator.",
      };
    default:
      // An unlisted Firebase code is not necessarily a credential
      // problem — don't misdiagnose it.
      return { message: "Sign-in failed. Please try again." };
  }
}
