"use client";

import { useActionState, useMemo, useState } from "react";

import type { ActionState } from "./actions";

/**
 * Forms for the admin expense surface (issue #17). These collect the
 * factual record — date, exact amount, currency, vendor, purpose, who
 * submitted/paid — plus lifecycle, reimbursement, and context-link
 * actions. SARbase records financial facts; it is not accounting
 * software and nothing here moves money.
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

interface ExpenseDefaults {
  expenseDate?: string | null;
  amount?: string;
  currency?: string;
  vendorId?: string | null;
  category?: string | null;
  description?: string | null;
  submittedByMemberId?: string | null;
  paidByMemberId?: string | null;
}

// Common ISO 4217 codes offered as a datalist hint — the field accepts
// any valid 3-letter code; the domain validates against the full ISO
// exponent table in src/lib/money.ts.
const COMMON_CURRENCIES = [
  "USD",
  "EUR",
  "GBP",
  "CAD",
  "AUD",
  "NZD",
  "JPY",
  "CHF",
];

/**
 * Create a draft expense, or correct material fields on an existing
 * one. `requireReason` renders the mandatory correction-reason field —
 * set when the expense is APPROVED or already REIMBURSED.
 */
export function ExpenseFieldsForm({
  action,
  defaults = {},
  vendors,
  members,
  categories = [],
  includeReimbursement = false,
  requireReason = false,
  submitLabel,
}: {
  action: BoundAction;
  defaults?: ExpenseDefaults;
  vendors: { id: string; name: string }[];
  members: { id: string; displayName: string }[];
  categories?: string[];
  includeReimbursement?: boolean;
  requireReason?: boolean;
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <label htmlFor="expense-date" className={labelClass}>
            Expense date
          </label>
          <input
            id="expense-date"
            name="expenseDate"
            type="date"
            required
            defaultValue={defaults.expenseDate ?? undefined}
            aria-invalid={Boolean(state.fieldErrors?.expenseDate)}
            aria-describedby="expense-date-error"
            className={inputClass}
          />
          <FieldError
            id="expense-date-error"
            errors={state.fieldErrors?.expenseDate}
          />
        </div>
        <div>
          <label htmlFor="expense-amount" className={labelClass}>
            Amount
          </label>
          <input
            id="expense-amount"
            name="amount"
            type="text"
            required
            inputMode="decimal"
            maxLength={30}
            defaultValue={defaults.amount}
            placeholder="e.g. 42.15"
            aria-invalid={Boolean(state.fieldErrors?.amount)}
            aria-describedby="expense-amount-error"
            className={inputClass}
          />
          <FieldError
            id="expense-amount-error"
            errors={state.fieldErrors?.amount}
          />
        </div>
        <div>
          <label htmlFor="expense-currency" className={labelClass}>
            Currency
          </label>
          <input
            id="expense-currency"
            name="currency"
            type="text"
            required
            minLength={3}
            maxLength={3}
            pattern="[A-Za-z]{3}"
            defaultValue={defaults.currency ?? "USD"}
            list="expense-currency-codes"
            aria-invalid={Boolean(state.fieldErrors?.currency)}
            aria-describedby="expense-currency-error"
            className={`${inputClass} uppercase`}
          />
          <datalist id="expense-currency-codes">
            {COMMON_CURRENCIES.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          <FieldError
            id="expense-currency-error"
            errors={state.fieldErrors?.currency}
          />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="expense-vendor" className={labelClass}>
            Vendor <span className="text-neutral-500">(optional)</span>
          </label>
          <select
            id="expense-vendor"
            name="vendorId"
            defaultValue={defaults.vendorId ?? ""}
            className={inputClass}
          >
            <option value="">—</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="expense-category" className={labelClass}>
            Category <span className="text-neutral-500">(optional)</span>
          </label>
          <input
            id="expense-category"
            name="category"
            type="text"
            maxLength={60}
            defaultValue={defaults.category ?? undefined}
            list="expense-categories"
            placeholder="e.g. Fuel, Maintenance, Equipment"
            className={inputClass}
          />
          <datalist id="expense-categories">
            {categories.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </div>
      </div>
      <div>
        <label htmlFor="expense-description" className={labelClass}>
          What was it for? <span className="text-neutral-500">(optional)</span>
        </label>
        <textarea
          id="expense-description"
          name="description"
          rows={2}
          maxLength={2000}
          defaultValue={defaults.description ?? undefined}
          placeholder="e.g. engine oil and filter for the 100-hour service"
          className={inputClass}
        />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="expense-submittedBy" className={labelClass}>
            Submitted by{" "}
            <span className="text-neutral-500">(optional member)</span>
          </label>
          <select
            id="expense-submittedBy"
            name="submittedByMemberId"
            defaultValue={defaults.submittedByMemberId ?? ""}
            className={inputClass}
          >
            <option value="">—</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="expense-paidBy" className={labelClass}>
            Paid by{" "}
            <span className="text-neutral-500">
              (member who paid out of pocket)
            </span>
          </label>
          <select
            id="expense-paidBy"
            name="paidByMemberId"
            defaultValue={defaults.paidByMemberId ?? ""}
            className={inputClass}
          >
            <option value="">Organization paid</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName}
              </option>
            ))}
          </select>
        </div>
      </div>
      {includeReimbursement && (
        <div>
          <label htmlFor="expense-reimbursement" className={labelClass}>
            Reimbursement
          </label>
          <select
            id="expense-reimbursement"
            name="reimbursementStatus"
            defaultValue="NOT_REQUIRED"
            className={inputClass}
          >
            <option value="NOT_REQUIRED">Not required</option>
            <option value="PENDING">
              Pending — the paying member needs reimbursing
            </option>
          </select>
          <p className="mt-1 text-xs text-neutral-500">
            Choose pending when a volunteer paid personally. Reimbursed is
            recorded later as its own reviewed fact.
          </p>
        </div>
      )}
      {requireReason && (
        <div>
          <label htmlFor="expense-reason" className={labelClass}>
            Correction reason
          </label>
          <input
            id="expense-reason"
            name="reason"
            type="text"
            required
            maxLength={500}
            placeholder="Why is this record being corrected?"
            aria-invalid={Boolean(state.fieldErrors?.reason)}
            aria-describedby="expense-reason-error"
            className={inputClass}
          />
          <FieldError
            id="expense-reason-error"
            errors={state.fieldErrors?.reason}
          />
        </div>
      )}
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

/** Lifecycle transition button — the domain validates the edge. */
export function ExpenseTransitionButton({
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

/** Reject an expense — the reason is required; it is the point. */
export function ExpenseRejectForm({ action }: { action: BoundAction }) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <input
        name="note"
        type="text"
        required
        maxLength={500}
        placeholder="Rejection reason (required)"
        aria-label="Rejection reason"
        aria-invalid={Boolean(state.fieldErrors?.note)}
        className="rounded-md border border-neutral-300 px-2 py-1 text-sm"
      />
      <button type="submit" disabled={pending} className={secondaryButtonClass}>
        {pending ? "Working…" : "Reject"}
      </button>
      {state.message && (
        <p className="text-xs text-red-700" role="alert">
          {state.message}
        </p>
      )}
    </form>
  );
}

/**
 * Record the reimbursement state — an administrative fact, never
 * payment processing. Un-marking REIMBURSED asks for a note.
 */
export function ExpenseReimbursementForm({
  action,
  current,
}: {
  action: BoundAction;
  current: "NOT_REQUIRED" | "PENDING" | "REIMBURSED";
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3">
      <div>
        <label htmlFor="reimbursement-status" className={labelClass}>
          Reimbursement state
        </label>
        <select
          id="reimbursement-status"
          name="status"
          defaultValue={current}
          className={inputClass}
        >
          <option value="NOT_REQUIRED">Not required</option>
          <option value="PENDING">Pending</option>
          <option value="REIMBURSED">Reimbursed</option>
        </select>
      </div>
      <div>
        <label htmlFor="reimbursement-note" className={labelClass}>
          Note{" "}
          <span className="text-neutral-500">
            (required to un-mark reimbursed)
          </span>
        </label>
        <input
          id="reimbursement-note"
          name="note"
          type="text"
          maxLength={500}
          className={inputClass}
        />
      </div>
      <button type="submit" disabled={pending} className={secondaryButtonClass}>
        {pending ? "Saving…" : "Record"}
      </button>
      {state.message && (
        <p className={`${errorClass} w-full`} role="alert">
          {state.message}
        </p>
      )}
    </form>
  );
}

export interface ExpenseLinkTarget {
  kind: string;
  id: string;
  label: string;
}

/**
 * Link the expense to an operational record — incident, training event,
 * asset, maintenance record, or inventory item. The kind selector
 * filters the target list client-side; both are revalidated server-side.
 */
export function ExpenseLinkForm({
  action,
  options,
}: {
  action: BoundAction;
  options: ExpenseLinkTarget[];
}) {
  const kinds = useMemo(
    () => [...new Set(options.map((o) => o.kind))],
    [options],
  );
  const [kind, setKind] = useState(kinds[0] ?? "");
  const [state, formAction, pending] = useActionState(action, {});
  const kindLabel = (k: string) =>
    ({
      INCIDENT: "Incident",
      TRAINING_EVENT: "Training event",
      ASSET: "Asset",
      MAINTENANCE_RECORD: "Maintenance record",
      INVENTORY_ITEM: "Inventory item",
    })[k] ?? k;
  const targets = options.filter((o) => o.kind === kind);

  if (kinds.length === 0) return null;

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3">
      <div>
        <label htmlFor="link-kind" className={labelClass}>
          Record type
        </label>
        <select
          id="link-kind"
          name="kind"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          className={inputClass}
        >
          {kinds.map((k) => (
            <option key={k} value={k}>
              {kindLabel(k)}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="link-target" className={labelClass}>
          Record
        </label>
        <select
          id="link-target"
          name="targetId"
          required
          className={inputClass}
        >
          {targets.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="link-note" className={labelClass}>
          Note <span className="text-neutral-500">(optional)</span>
        </label>
        <input
          id="link-note"
          name="note"
          type="text"
          maxLength={200}
          className={inputClass}
        />
      </div>
      <button type="submit" disabled={pending} className={secondaryButtonClass}>
        {pending ? "Linking…" : "Link"}
      </button>
      {state.message && (
        <p className={`${errorClass} w-full`} role="alert">
          {state.message}
        </p>
      )}
      {state.fieldErrors?.targetId && (
        <p className={`${errorClass} w-full`} role="alert">
          {state.fieldErrors.targetId.join(" ")}
        </p>
      )}
    </form>
  );
}

/** Remove a context link — the removal is audited on the expense. */
export function RemoveExpenseLinkButton({
  action,
}: {
  action: () => Promise<ActionState>;
}) {
  const [state, formAction, pending] = useActionState(() => action(), {});
  return (
    <form action={formAction} className="inline">
      <button
        type="submit"
        disabled={pending}
        className="text-xs font-medium text-neutral-500 hover:text-red-700 disabled:opacity-50"
      >
        {pending ? "Removing…" : "Remove"}
      </button>
      {state.message && (
        <p className="mt-1 text-xs text-red-700" role="alert">
          {state.message}
        </p>
      )}
    </form>
  );
}
