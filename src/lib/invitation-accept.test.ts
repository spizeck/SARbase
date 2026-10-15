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

  it("maps disabled accounts, network failures, and config gaps honestly", () => {
    expect(
      inviteAuthErrorView(fb("auth/user-disabled"), "sign_in").message,
    ).toContain("disabled");
    expect(
      inviteAuthErrorView(fb("auth/network-request-failed"), "sign_in").message,
    ).toContain("Check your connection");
    expect(
      inviteAuthErrorView(fb("auth/operation-not-allowed"), "sign_in").message,
    ).toContain("isn't enabled");
  });

  it("unrecognized Firebase codes fall back without misdiagnosing", () => {
    const view = inviteAuthErrorView(fb("auth/quota-exceeded"), "sign_in");
    expect(view.message).toBe("Sign-in failed. Please try again.");
    expect(view.message).not.toContain("Invalid email or password");
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
