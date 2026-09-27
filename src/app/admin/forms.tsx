"use client";

import { useActionState } from "react";

import type { ActionState } from "./actions";

/**
 * Minimal accessible form components for the admin surface. Each maps a
 * server action's ActionState field errors to inline descriptions.
 */

const inputClass =
  "mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm";
const labelClass = "block text-sm font-medium text-neutral-800";
const errorClass = "mt-1 text-sm text-red-700";
const buttonClass =
  "rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50";

function FieldError({ id, errors }: { id: string; errors?: string[] }) {
  if (!errors?.length) return null;
  return (
    <p id={id} className={errorClass} role="alert">
      {errors.join(" ")}
    </p>
  );
}

type BoundAction = (
  prev: ActionState,
  formData: FormData,
) => Promise<ActionState>;

export function OrganizationForm({
  action,
  defaultName,
  submitLabel,
}: {
  action: BoundAction;
  defaultName?: string;
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="space-y-3">
      <div>
        <label htmlFor="org-name" className={labelClass}>
          Organization name
        </label>
        <input
          id="org-name"
          name="name"
          type="text"
          required
          maxLength={120}
          defaultValue={defaultName}
          aria-invalid={Boolean(state.fieldErrors?.name)}
          aria-describedby="org-name-error"
          className={inputClass}
        />
        <FieldError id="org-name-error" errors={state.fieldErrors?.name} />
      </div>
      {state.message && (
        <p className={errorClass} role="alert">
          {state.message}
        </p>
      )}
      <button type="submit" disabled={pending} className={buttonClass}>
        {pending ? "Saving…" : submitLabel}
      </button>
    </form>
  );
}

export function UnitCreateForm({ action }: { action: BoundAction }) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="flex items-end gap-3">
      <div className="grow">
        <label htmlFor="unit-name" className={labelClass}>
          New unit name
        </label>
        <input
          id="unit-name"
          name="name"
          type="text"
          required
          maxLength={120}
          aria-invalid={Boolean(state.fieldErrors?.name)}
          aria-describedby="unit-name-error"
          className={inputClass}
        />
        <FieldError id="unit-name-error" errors={state.fieldErrors?.name} />
      </div>
      <button type="submit" disabled={pending} className={buttonClass}>
        {pending ? "Adding…" : "Add unit"}
      </button>
      {state.message && (
        <p className={errorClass} role="alert">
          {state.message}
        </p>
      )}
    </form>
  );
}

export function UnitRenameForm({
  action,
  defaultName,
  unitId,
}: {
  action: BoundAction;
  defaultName: string;
  unitId: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const errorId = `unit-rename-error-${unitId}`;
  return (
    <form action={formAction} className="flex items-end gap-3">
      <div className="grow">
        <label htmlFor={`unit-rename-${unitId}`} className="sr-only">
          Unit name
        </label>
        <input
          id={`unit-rename-${unitId}`}
          name="name"
          type="text"
          required
          maxLength={120}
          defaultValue={defaultName}
          aria-invalid={Boolean(state.fieldErrors?.name)}
          aria-describedby={errorId}
          className={inputClass}
        />
        <FieldError id={errorId} errors={state.fieldErrors?.name} />
      </div>
      <button type="submit" disabled={pending} className={buttonClass}>
        {pending ? "Saving…" : "Rename"}
      </button>
      {state.message && (
        <p className={errorClass} role="alert">
          {state.message}
        </p>
      )}
    </form>
  );
}

export function MemberForm({
  action,
  defaults,
  submitLabel,
}: {
  action: BoundAction;
  defaults?: {
    displayName: string;
    email: string | null;
    phone: string | null;
  };
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="space-y-3">
      <div>
        <label htmlFor="member-name" className={labelClass}>
          Name
        </label>
        <input
          id="member-name"
          name="displayName"
          type="text"
          required
          maxLength={120}
          defaultValue={defaults?.displayName}
          aria-invalid={Boolean(state.fieldErrors?.displayName)}
          aria-describedby="member-name-error"
          className={inputClass}
        />
        <FieldError
          id="member-name-error"
          errors={state.fieldErrors?.displayName}
        />
      </div>
      <div>
        <label htmlFor="member-email" className={labelClass}>
          Email <span className="font-normal text-neutral-500">(optional)</span>
        </label>
        <input
          id="member-email"
          name="email"
          type="email"
          maxLength={254}
          defaultValue={defaults?.email ?? undefined}
          aria-invalid={Boolean(state.fieldErrors?.email)}
          aria-describedby="member-email-error"
          className={inputClass}
        />
        <FieldError id="member-email-error" errors={state.fieldErrors?.email} />
      </div>
      <div>
        <label htmlFor="member-phone" className={labelClass}>
          Phone <span className="font-normal text-neutral-500">(optional)</span>
        </label>
        <input
          id="member-phone"
          name="phone"
          type="tel"
          defaultValue={defaults?.phone ?? undefined}
          aria-invalid={Boolean(state.fieldErrors?.phone)}
          aria-describedby="member-phone-error"
          className={inputClass}
        />
        <FieldError id="member-phone-error" errors={state.fieldErrors?.phone} />
      </div>
      {state.message && (
        <p className={errorClass} role="alert">
          {state.message}
        </p>
      )}
      <button type="submit" disabled={pending} className={buttonClass}>
        {pending ? "Saving…" : submitLabel}
      </button>
    </form>
  );
}

export function LinkIdentityForm({ action }: { action: BoundAction }) {
  const [state, formAction, pending] = useActionState(action, {});

  return (
    <form action={formAction} className="space-y-4">
      <div>
        <label htmlFor="identity-email" className={labelClass}>
          Sign-in email
        </label>
        <input
          id="identity-email"
          name="email"
          type="email"
          required
          maxLength={254}
          placeholder="name@example.org"
          className={inputClass}
          aria-describedby="identity-email-error"
          aria-invalid={state.fieldErrors?.email ? "true" : undefined}
        />
        <FieldError
          id="identity-email-error"
          errors={state.fieldErrors?.email}
        />
      </div>
      {state.message && (
        <p className={errorClass} role="alert">
          {state.message}
        </p>
      )}
      <button type="submit" disabled={pending} className={buttonClass}>
        {pending ? "Linking…" : "Link identity"}
      </button>
    </form>
  );
}

export function MemberUnitsForm({
  action,
  units,
  assignedUnitIds,
}: {
  action: BoundAction;
  units: { id: string; name: string }[];
  assignedUnitIds: string[];
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const assigned = new Set(assignedUnitIds);

  if (units.length === 0) {
    return (
      <p className="text-sm text-neutral-500">
        This organization has no units yet.
      </p>
    );
  }

  return (
    <form action={formAction} className="space-y-3">
      <fieldset>
        <legend className="text-sm font-medium text-neutral-800">
          Unit membership
        </legend>
        <ul className="mt-2 space-y-2">
          {units.map((unit) => (
            <li key={unit.id}>
              <label className="flex items-center gap-2 text-sm text-neutral-800">
                <input
                  type="checkbox"
                  name="unitIds"
                  value={unit.id}
                  defaultChecked={assigned.has(unit.id)}
                  className="h-4 w-4 rounded border-neutral-300"
                />
                {unit.name}
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
      {state.message && (
        <p className={errorClass} role="alert">
          {state.message}
        </p>
      )}
      <button type="submit" disabled={pending} className={buttonClass}>
        {pending ? "Saving…" : "Save units"}
      </button>
    </form>
  );
}
