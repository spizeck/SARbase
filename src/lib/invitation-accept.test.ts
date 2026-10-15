import { describe, expect, it } from "vitest";
import { FirebaseError } from "firebase/app";

import { inviteAuthErrorView } from "./invitation-accept";

const fb = (code: string) => new FirebaseError(code, "firebase message");

describe("inviteAuthErrorView", () => {
  it("invalid credentials in sign-in mode points at registration", () => {
    const view = inviteAuthErrorView(fb("auth/invalid-credential"), "sign_in");
    // Enumeration-safe: does not assert whether the account exists.
    expect(view.message).toContain("Create an account");
    expect(view.message).not.toContain("does not exist");
    expect(view.switchMode).toBeUndefined();
  });

  it("invalid credentials in register mode stays generic", () => {
    const view = inviteAuthErrorView(fb("auth/invalid-credential"), "register");
    expect(view.message).toBe("Invalid email or password.");
    expect(view.switchMode).toBeUndefined();
  });

  it("email-already-in-use switches to sign-in", () => {
    const view = inviteAuthErrorView(
      fb("auth/email-already-in-use"),
      "register",
    );
    expect(view.switchMode).toBe("sign_in");
    expect(view.message).toContain("already exists");
  });

  it("maps weak-password and too-many-requests", () => {
    expect(
      inviteAuthErrorView(fb("auth/weak-password"), "register").message,
    ).toContain("6 characters");
    expect(
      inviteAuthErrorView(fb("auth/too-many-requests"), "sign_in").message,
    ).toContain("Too many attempts");
  });

  it("unrecognized Firebase codes fall back to a generic message", () => {
    expect(
      inviteAuthErrorView(fb("auth/network-request-failed"), "sign_in").message,
    ).toBe("Invalid email or password.");
  });

  it("non-Firebase errors get a generic failure message", () => {
    expect(inviteAuthErrorView(new Error("boom"), "sign_in").message).toBe(
      "Something went wrong. Please try again.",
    );
    expect(inviteAuthErrorView("nope", "register").message).toBe(
      "Something went wrong. Please try again.",
    );
  });
});
