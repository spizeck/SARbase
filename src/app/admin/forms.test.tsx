import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  AccessRoleForm,
  preventSubmitWhilePending,
  roleChangeUIReducer,
} from "./forms";

/**
 * Regression coverage for the access-page role-change confirmation: the
 * pending intent must be the explicit role the operator chose, must close
 * after a completed mutation, and must never re-derive the opposite
 * action from the flipped currentRole. Node environment — the reducer
 * carries the lifecycle, and static markup covers the rendered contract.
 */

const noopAction = vi.fn();

describe("roleChangeUIReducer", () => {
  it("records the exact role the operator opened", () => {
    expect(
      roleChangeUIReducer({ intent: null }, { type: "open", role: "ADMIN" }),
    ).toEqual({ intent: "ADMIN" });
    expect(
      roleChangeUIReducer({ intent: null }, { type: "open", role: "MEMBER" }),
    ).toEqual({ intent: "MEMBER" });
  });

  it("closes the confirmation after a successful promotion", () => {
    const opened = roleChangeUIReducer(
      { intent: null },
      { type: "open", role: "ADMIN" },
    );
    expect(
      roleChangeUIReducer(opened, {
        type: "settled",
        result: { updatedRole: "ADMIN" },
      }),
    ).toEqual({ intent: null });
  });

  it("closes the confirmation after a successful demotion", () => {
    const opened = roleChangeUIReducer(
      { intent: null },
      { type: "open", role: "MEMBER" },
    );
    expect(
      roleChangeUIReducer(opened, {
        type: "settled",
        result: { updatedRole: "MEMBER" },
      }),
    ).toEqual({ intent: null });
  });

  it("closes the confirmation on the no-change notice", () => {
    const opened = roleChangeUIReducer(
      { intent: null },
      { type: "open", role: "ADMIN" },
    );
    expect(
      roleChangeUIReducer(opened, {
        type: "settled",
        result: {
          notice: "That account already has this role — nothing changed.",
        },
      }),
    ).toEqual({ intent: null });
  });

  it("keeps the confirmation open when the mutation fails", () => {
    const opened = roleChangeUIReducer(
      { intent: null },
      { type: "open", role: "MEMBER" },
    );
    const failed = roleChangeUIReducer(opened, {
      type: "settled",
      result: { message: "You cannot demote the last active administrator." },
    });
    // Still showing the same intended action — the operator sees the
    // error without the displayed role having changed.
    expect(failed).toEqual({ intent: "MEMBER" });
  });

  it("keeps the confirmation open on a field-validation failure", () => {
    const opened = roleChangeUIReducer(
      { intent: null },
      { type: "open", role: "ADMIN" },
    );
    expect(
      roleChangeUIReducer(opened, {
        type: "settled",
        result: { fieldErrors: { role: ["Choose a role."] } },
      }),
    ).toEqual({ intent: "ADMIN" });
  });

  it("cancel closes the confirmation without a mutation", () => {
    const opened = roleChangeUIReducer(
      { intent: null },
      { type: "open", role: "ADMIN" },
    );
    expect(roleChangeUIReducer(opened, { type: "cancel" })).toEqual({
      intent: null,
    });
  });

  it("returns the same state object when a settle resolves nothing", () => {
    const idle = { intent: null };
    // The initial {} action state must not reopen anything.
    expect(roleChangeUIReducer(idle, { type: "settled", result: {} })).toBe(
      idle,
    );
  });
});

describe("preventSubmitWhilePending", () => {
  it("blocks a repeated submission while a request is in flight", () => {
    const event = { preventDefault: vi.fn() };
    preventSubmitWhilePending(true, event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it("allows the first submission through", () => {
    const event = { preventDefault: vi.fn() };
    preventSubmitWhilePending(false, event);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});

describe("AccessRoleForm", () => {
  it("offers only the opposite of the member role and no open confirmation", () => {
    const html = renderToStaticMarkup(
      <AccessRoleForm
        action={noopAction}
        currentRole="MEMBER"
        targetLabel="Pat Example"
        isSelf={false}
      />,
    );
    expect(html).toContain("Change to Administrator");
    expect(html).not.toContain("Confirm:");
    expect(html).not.toContain("will become a");
  });

  it("offers only the opposite of the administrator role and no open confirmation", () => {
    const html = renderToStaticMarkup(
      <AccessRoleForm
        action={noopAction}
        currentRole="ADMIN"
        targetLabel="Pat Example"
        isSelf={false}
      />,
    );
    expect(html).toContain("Change to Member");
    expect(html).not.toContain("Confirm:");
    expect(html).not.toContain("will become an");
  });
});
