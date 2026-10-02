"use client";

import { useActionState } from "react";

import type { ActionState } from "./actions";

/**
 * Forms for the admin incident surface (issue #15). These collect only
 * what a human enters — factual fields, notes, and correction reasons.
 * Nothing here infers participation, readiness, or any operational
 * state; incident data is an administrative record.
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

interface MaterialDefaults {
  title?: string;
  summary?: string | null;
  reportedAt?: string | null;
  departedAt?: string | null;
  onSceneAt?: string | null;
  returnedAt?: string | null;
}

function TimestampField({
  id,
  name,
  label,
  defaultValue,
  errors,
}: {
  id: string;
  name: string;
  label: string;
  defaultValue?: string | null;
  errors?: string[];
}) {
  return (
    <div>
      <label htmlFor={id} className={labelClass}>
        {label} <span className="text-neutral-500">(optional, local time)</span>
      </label>
      <input
        id={id}
        name={name}
        type="datetime-local"
        defaultValue={defaultValue ?? undefined}
        aria-invalid={Boolean(errors?.length)}
        aria-describedby={`${id}-error`}
        className={inputClass}
      />
      <FieldError id={`${id}-error`} errors={errors} />
    </div>
  );
}

/**
 * Create or correct the incident's material fields. `requireReason`
 * (set when the incident is CLOSED) renders the correction-reason
 * input — the domain refuses a material change without it.
 */
export function IncidentFieldsForm({
  action,
  defaults = {},
  calloutId,
  requireReason = false,
  submitLabel,
}: {
  action: BoundAction;
  defaults?: MaterialDefaults;
  calloutId?: string;
  requireReason?: boolean;
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="space-y-4">
      {calloutId && <input type="hidden" name="calloutId" value={calloutId} />}
      <div>
        <label htmlFor="incident-title" className={labelClass}>
          Title
        </label>
        <input
          id="incident-title"
          name="title"
          type="text"
          required
          maxLength={120}
          defaultValue={defaults.title}
          aria-invalid={Boolean(state.fieldErrors?.title)}
          aria-describedby="incident-title-error"
          className={inputClass}
        />
        <FieldError
          id="incident-title-error"
          errors={state.fieldErrors?.title}
        />
      </div>
      <div>
        <label htmlFor="incident-summary" className={labelClass}>
          Initial report <span className="text-neutral-500">(optional)</span>
        </label>
        <textarea
          id="incident-summary"
          name="summary"
          rows={4}
          maxLength={4000}
          defaultValue={defaults.summary ?? undefined}
          placeholder="What was reported, as it was reported."
          aria-invalid={Boolean(state.fieldErrors?.summary)}
          aria-describedby="incident-summary-error"
          className={inputClass}
        />
        <FieldError
          id="incident-summary-error"
          errors={state.fieldErrors?.summary}
        />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TimestampField
          id="incident-reportedAt"
          name="reportedAt"
          label="Reported"
          defaultValue={defaults.reportedAt}
          errors={state.fieldErrors?.reportedAt}
        />
        <TimestampField
          id="incident-departedAt"
          name="departedAt"
          label="Departed"
          defaultValue={defaults.departedAt}
          errors={state.fieldErrors?.departedAt}
        />
        <TimestampField
          id="incident-onSceneAt"
          name="onSceneAt"
          label="On scene"
          defaultValue={defaults.onSceneAt}
          errors={state.fieldErrors?.onSceneAt}
        />
        <TimestampField
          id="incident-returnedAt"
          name="returnedAt"
          label="Returned"
          defaultValue={defaults.returnedAt}
          errors={state.fieldErrors?.returnedAt}
        />
      </div>
      {requireReason && (
        <div>
          <label htmlFor="incident-reason" className={labelClass}>
            Correction reason
          </label>
          <input
            id="incident-reason"
            name="reason"
            type="text"
            required
            maxLength={500}
            placeholder="Why is this record being corrected?"
            aria-invalid={Boolean(state.fieldErrors?.reason)}
            aria-describedby="incident-reason-error"
            className={inputClass}
          />
          <FieldError
            id="incident-reason-error"
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

/** Lifecycle transition button — target is bound server-side validated. */
export function IncidentTransitionButton({
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

/** Link an unlinked incident to a callout that has no incident yet. */
export function LinkCalloutForm({
  action,
  callouts,
}: {
  action: BoundAction;
  callouts: { id: string; title: string }[];
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3">
      <div>
        <label htmlFor="link-callout" className={labelClass}>
          Callout
        </label>
        <select
          id="link-callout"
          name="calloutId"
          required
          defaultValue=""
          className={inputClass}
        >
          <option value="" disabled>
            Choose a callout…
          </option>
          {callouts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
      </div>
      <button type="submit" disabled={pending} className={secondaryButtonClass}>
        {pending ? "Linking…" : "Link callout"}
      </button>
      {state.message && (
        <p className={`${errorClass} w-full`} role="alert">
          {state.message}
        </p>
      )}
      {state.fieldErrors?.calloutId && (
        <FieldError
          id="link-callout-error"
          errors={state.fieldErrors.calloutId}
        />
      )}
    </form>
  );
}

/** Record a member as a participant — an explicit administrative fact. */
export function AddIncidentMemberForm({
  action,
  members,
}: {
  action: BoundAction;
  members: { id: string; displayName: string }[];
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3">
      <div>
        <label htmlFor="participant-member" className={labelClass}>
          Member
        </label>
        <select
          id="participant-member"
          name="memberId"
          required
          defaultValue=""
          className={inputClass}
        >
          <option value="" disabled>
            Choose a member…
          </option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="participant-role" className={labelClass}>
          Role <span className="text-neutral-500">(optional, factual)</span>
        </label>
        <input
          id="participant-role"
          name="roleNote"
          type="text"
          maxLength={200}
          placeholder="e.g. coxswain, radio"
          className={inputClass}
        />
      </div>
      <button type="submit" disabled={pending} className={secondaryButtonClass}>
        {pending ? "Adding…" : "Add participant"}
      </button>
      {state.message && (
        <p className={`${errorClass} w-full`} role="alert">
          {state.message}
        </p>
      )}
    </form>
  );
}

/** Record an asset as used on the incident. */
export function AddIncidentAssetForm({
  action,
  assets,
}: {
  action: BoundAction;
  assets: { id: string; name: string }[];
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3">
      <div>
        <label htmlFor="participant-asset" className={labelClass}>
          Asset
        </label>
        <select
          id="participant-asset"
          name="assetId"
          required
          defaultValue=""
          className={inputClass}
        >
          <option value="" disabled>
            Choose an asset…
          </option>
          {assets.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="asset-note" className={labelClass}>
          Note <span className="text-neutral-500">(optional)</span>
        </label>
        <input
          id="asset-note"
          name="note"
          type="text"
          maxLength={200}
          className={inputClass}
        />
      </div>
      <button type="submit" disabled={pending} className={secondaryButtonClass}>
        {pending ? "Adding…" : "Add asset"}
      </button>
      {state.message && (
        <p className={`${errorClass} w-full`} role="alert">
          {state.message}
        </p>
      )}
    </form>
  );
}

/** Remove a participant/asset row — a REMOVED timeline event preserves the fact. */
export function RemoveParticipantButton({
  action,
  label = "Remove",
}: {
  action: () => Promise<ActionState>;
  label?: string;
}) {
  const [state, formAction, pending] = useActionState(() => action(), {});
  return (
    <form action={formAction} className="inline">
      <button
        type="submit"
        disabled={pending}
        className="text-xs font-medium text-neutral-500 hover:text-red-700 disabled:opacity-50"
      >
        {pending ? "Removing…" : label}
      </button>
      {state.message && (
        <p className="mt-1 text-xs text-red-700" role="alert">
          {state.message}
        </p>
      )}
    </form>
  );
}

/** Add a human-authored note — general, after-action, or closing. */
export function AddIncidentNoteForm({ action }: { action: BoundAction }) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="note-kind" className={labelClass}>
            Kind
          </label>
          <select
            id="note-kind"
            name="kind"
            defaultValue="GENERAL"
            className={inputClass}
          >
            <option value="GENERAL">Note</option>
            <option value="AFTER_ACTION">After-action</option>
            <option value="CLOSING">Closing</option>
          </select>
        </div>
        <TimestampField
          id="note-occurredAt"
          name="occurredAt"
          label="Observation time"
        />
      </div>
      <div>
        <label htmlFor="note-body" className={labelClass}>
          Note
        </label>
        <textarea
          id="note-body"
          name="body"
          rows={3}
          required
          maxLength={4000}
          aria-invalid={Boolean(state.fieldErrors?.body)}
          aria-describedby="note-body-error"
          className={inputClass}
        />
        <FieldError id="note-body-error" errors={state.fieldErrors?.body} />
      </div>
      {state.message && (
        <p className={errorClass} role="alert">
          {state.message}
        </p>
      )}
      <button type="submit" disabled={pending} className={buttonClass}>
        {pending ? "Adding…" : "Add note"}
      </button>
    </form>
  );
}

/**
 * Correct a note's text. Appends an IncidentNoteCorrection — the
 * original wording is preserved, so this is an amendment, not a rewrite.
 */
export function CorrectNoteForm({
  action,
  currentBody,
  idPrefix,
}: {
  action: BoundAction;
  currentBody: string;
  idPrefix: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="mt-2 space-y-2">
      <div>
        <label htmlFor={`${idPrefix}-body`} className="sr-only">
          Corrected note text
        </label>
        <textarea
          id={`${idPrefix}-body`}
          name="body"
          rows={3}
          required
          maxLength={4000}
          defaultValue={currentBody}
          aria-invalid={Boolean(state.fieldErrors?.body)}
          aria-describedby={`${idPrefix}-body-error`}
          className={inputClass}
        />
        <FieldError
          id={`${idPrefix}-body-error`}
          errors={state.fieldErrors?.body}
        />
      </div>
      <div>
        <label htmlFor={`${idPrefix}-reason`} className="sr-only">
          Correction reason
        </label>
        <input
          id={`${idPrefix}-reason`}
          name="reason"
          type="text"
          maxLength={500}
          placeholder="Correction reason (optional)"
          className={inputClass}
        />
      </div>
      {state.message && (
        <p className={errorClass} role="alert">
          {state.message}
        </p>
      )}
      <button type="submit" disabled={pending} className={secondaryButtonClass}>
        {pending ? "Correcting…" : "Save correction"}
      </button>
    </form>
  );
}
