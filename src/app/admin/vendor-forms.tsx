"use client";

import { useActionState } from "react";

import type { ActionState } from "./actions";

/**
 * Forms for the admin vendor surface (issue #17). Vendors are simple
 * contact/reference records — where the organization buys things — not
 * a CRM and not a purchasing workflow.
 */

const inputClass =
  "mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm";
const labelClass = "block text-sm font-medium text-neutral-800";
const errorClass = "mt-1 text-sm text-red-700";
const buttonClass =
  "rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50";
const secondaryButtonClass =
  "rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-800 hover:bg-neutral-50 disabled:opacity-50";

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

interface VendorDefaults {
  name?: string;
  contactName?: string | null;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  accountReference?: string | null;
  notes?: string | null;
}

/** Create or edit a vendor's contact/reference fields. */
export function VendorForm({
  action,
  defaults = {},
  idPrefix = "vendor",
  submitLabel,
}: {
  action: BoundAction;
  defaults?: VendorDefaults;
  idPrefix?: string;
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="space-y-4">
      <div>
        <label htmlFor={`${idPrefix}-name`} className={labelClass}>
          Vendor name
        </label>
        <input
          id={`${idPrefix}-name`}
          name="name"
          type="text"
          required
          maxLength={120}
          defaultValue={defaults.name}
          placeholder="e.g. Island Marine Supply"
          aria-invalid={Boolean(state.fieldErrors?.name)}
          aria-describedby={`${idPrefix}-name-error`}
          className={inputClass}
        />
        <FieldError
          id={`${idPrefix}-name-error`}
          errors={state.fieldErrors?.name}
        />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor={`${idPrefix}-contact`} className={labelClass}>
            Contact person <span className="text-neutral-500">(optional)</span>
          </label>
          <input
            id={`${idPrefix}-contact`}
            name="contactName"
            type="text"
            maxLength={120}
            defaultValue={defaults.contactName ?? undefined}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor={`${idPrefix}-account`} className={labelClass}>
            Account / customer #{" "}
            <span className="text-neutral-500">(optional)</span>
          </label>
          <input
            id={`${idPrefix}-account`}
            name="accountReference"
            type="text"
            maxLength={120}
            defaultValue={defaults.accountReference ?? undefined}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor={`${idPrefix}-email`} className={labelClass}>
            Email <span className="text-neutral-500">(optional)</span>
          </label>
          <input
            id={`${idPrefix}-email`}
            name="email"
            type="email"
            maxLength={254}
            defaultValue={defaults.email ?? undefined}
            aria-invalid={Boolean(state.fieldErrors?.email)}
            aria-describedby={`${idPrefix}-email-error`}
            className={inputClass}
          />
          <FieldError
            id={`${idPrefix}-email-error`}
            errors={state.fieldErrors?.email}
          />
        </div>
        <div>
          <label htmlFor={`${idPrefix}-phone`} className={labelClass}>
            Phone <span className="text-neutral-500">(optional)</span>
          </label>
          <input
            id={`${idPrefix}-phone`}
            name="phone"
            type="text"
            maxLength={40}
            defaultValue={defaults.phone ?? undefined}
            aria-invalid={Boolean(state.fieldErrors?.phone)}
            aria-describedby={`${idPrefix}-phone-error`}
            className={inputClass}
          />
          <FieldError
            id={`${idPrefix}-phone-error`}
            errors={state.fieldErrors?.phone}
          />
        </div>
      </div>
      <div>
        <label htmlFor={`${idPrefix}-website`} className={labelClass}>
          Website <span className="text-neutral-500">(optional)</span>
        </label>
        <input
          id={`${idPrefix}-website`}
          name="website"
          type="text"
          maxLength={200}
          defaultValue={defaults.website ?? undefined}
          placeholder="https://…"
          aria-invalid={Boolean(state.fieldErrors?.website)}
          aria-describedby={`${idPrefix}-website-error`}
          className={inputClass}
        />
        <FieldError
          id={`${idPrefix}-website-error`}
          errors={state.fieldErrors?.website}
        />
      </div>
      <div>
        <label htmlFor={`${idPrefix}-notes`} className={labelClass}>
          Notes <span className="text-neutral-500">(optional)</span>
        </label>
        <textarea
          id={`${idPrefix}-notes`}
          name="notes"
          rows={2}
          maxLength={2000}
          defaultValue={defaults.notes ?? undefined}
          placeholder="e.g. asks for PO numbers on invoices"
          className={inputClass}
        />
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

/** Activate/deactivate a vendor — never deletes records. */
export function VendorStatusButton({
  action,
  label,
}: {
  action: () => Promise<ActionState>;
  label: string;
}) {
  const [state, formAction, pending] = useActionState(() => action(), {});
  return (
    <form action={formAction}>
      <button type="submit" disabled={pending} className={secondaryButtonClass}>
        {pending ? "Working…" : label}
      </button>
      {state.message && (
        <p className="mt-1 text-xs text-red-700" role="alert">
          {state.message}
        </p>
      )}
    </form>
  );
}
