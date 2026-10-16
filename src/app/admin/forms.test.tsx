import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  AccessRoleForm,
  ManagerCapabilitiesForm,
  preventSubmitWhilePending,
  roleChangeUIReducer,
} from "./forms";
import {
  CAPABILITY_REGISTRY,
  ORG_CAPABILITIES,
  STANDARD_MANAGER_CAPABILITIES,
} from "@/lib/auth/capabilities";

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
  it("offers the two non-current roles for a member and no open confirmation", () => {
    const html = renderToStaticMarkup(
      <AccessRoleForm
        action={noopAction}
        currentRole="MEMBER"
        targetLabel="Pat Example"
        isSelf={false}
      />,
    );
    expect(html).toContain("Change to Administrator");
    expect(html).toContain("Change to Manager");
    expect(html).not.toContain("Change to Member");
    expect(html).not.toContain("Confirm:");
    expect(html).not.toContain("will become a");
  });

  it("offers the two non-current roles for an administrator", () => {
    const html = renderToStaticMarkup(
      <AccessRoleForm
        action={noopAction}
        currentRole="ADMIN"
        targetLabel="Pat Example"
        isSelf={false}
      />,
    );
    expect(html).toContain("Change to Member");
    expect(html).toContain("Change to Manager");
    expect(html).not.toContain("Change to Administrator");
    expect(html).not.toContain("Confirm:");
  });

  it("offers Member and Administrator choices for a manager", () => {
    const html = renderToStaticMarkup(
      <AccessRoleForm
        action={noopAction}
        currentRole="MANAGER"
        targetLabel="Pat Example"
        isSelf={false}
      />,
    );
    expect(html).toContain("Change to Member");
    expect(html).toContain("Change to Administrator");
    expect(html).not.toContain("Change to Manager");
  });
});

describe("ManagerCapabilitiesForm", () => {
  it("renders every registry capability grouped, with current grants checked", () => {
    const granted = ["EQUIPMENT_MANAGE", "TRAINING_MANAGE"] as const;
    const html = renderToStaticMarkup(
      <ManagerCapabilitiesForm
        action={noopAction}
        granted={[...granted]}
        targetLabel="Pat Example"
      />,
    );
    // Every registered capability renders as a named checkbox.
    for (const cap of ORG_CAPABILITIES) {
      expect(html).toContain(`value="${cap}"`);
    }
    for (const def of CAPABILITY_REGISTRY) {
      expect(html).toContain(def.label);
      expect(html).toContain(def.description);
    }
    // The granted set is pre-checked; nothing else is.
    expect(html).toContain('checked="" value="EQUIPMENT_MANAGE"');
    expect(html).toContain('checked="" value="TRAINING_MANAGE"');
    expect(html.match(/checked=""/g)?.length).toBe(2);
    // Group legends and the administrator-only disclaimer render.
    expect(html).toContain("Operations");
    expect(html).toContain("Finance");
    expect(html).toContain("administrator-only");
    expect(html).toContain("Apply standard set");
    // Nothing pending — the save button starts disabled with no review box.
    expect(html).not.toContain("Review before saving");
  });

  it("gives each instance a unique reason-input id (one form per manager row)", () => {
    // One form renders per manager row — ids must differ WITHIN the
    // same tree or labels associate with the wrong input.
    const html = renderToStaticMarkup(
      <>
        <ManagerCapabilitiesForm
          action={noopAction}
          granted={[]}
          targetLabel="A"
        />
        <ManagerCapabilitiesForm
          action={noopAction}
          granted={[]}
          targetLabel="B"
        />
      </>,
    );
    const ids = [
      ...html.matchAll(/<input[^>]*id="([^"]+)"[^>]*name="reason"/g),
    ].map((m) => m[1]);
    const labels = [
      ...html.matchAll(/<label[^>]*for="([^"]+)"[^>]*>\s*Reason/g),
    ].map((m) => m[1]);
    expect(ids.length).toBe(2);
    expect(new Set(ids).size).toBe(2);
    // Each label must target ITS OWN form's input — in document order
    // each form renders its label immediately before its input, so a
    // pairwise check catches swapped for/id pairs that a set
    // comparison would miss.
    expect(labels).toEqual(ids);
  });

  it("standard set is a documented subset of the registry", () => {
    // The form's "Apply standard set" button can only ever select
    // registry entries — and the registry never includes account
    // administration (there is no such capability key at all).
    for (const cap of STANDARD_MANAGER_CAPABILITIES) {
      expect(ORG_CAPABILITIES).toContain(cap);
    }
    expect(ORG_CAPABILITIES).not.toContain("ACCESS_MANAGE");
  });
});
