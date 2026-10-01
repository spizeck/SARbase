"use client";

import { useActionState, useState } from "react";

import type { ActionState } from "./actions";

/**
 * Forms for the admin callout surface (issue #14). A callout is a
 * factual invitation record plus its responses — these forms collect
 * only what a coordinator types (title, short message) and who they
 * invite. Availability shown alongside member names is descriptive
 * context only; it never filters or recommends who should be invited.
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

export interface CalloutMemberOption {
  id: string;
  displayName: string;
  /** Factual context, e.g. current availability label or "no email". */
  context?: string;
}

/**
 * Create + activate a callout in one action. The audience radio picks a
 * selector (whole organization / one unit / explicit members); the
 * materialized invitee list is resolved and snapshotted server-side.
 * The hidden activationKey is generated per render so a double-submit
 * or resubmit replays instead of duplicating.
 */
export function CalloutActivationForm({
  action,
  units,
  members,
  activationKey,
}: {
  action: BoundAction;
  units: { id: string; name: string }[];
  members: CalloutMemberOption[];
  activationKey: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const [audience, setAudience] = useState<"ORGANIZATION" | "UNIT" | "MEMBERS">(
    "ORGANIZATION",
  );

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="activationKey" value={activationKey} />
      <div>
        <label htmlFor="callout-title" className={labelClass}>
          Title
        </label>
        <input
          id="callout-title"
          name="title"
          type="text"
          required
          maxLength={120}
          placeholder="Assistance requested — sailing yacht near Fort Bay"
          aria-invalid={Boolean(state.fieldErrors?.title)}
          aria-describedby="callout-title-error"
          className={inputClass}
        />
        <FieldError
          id="callout-title-error"
          errors={state.fieldErrors?.title}
        />
      </div>
      <div>
        <label htmlFor="callout-message" className={labelClass}>
          Initial information{" "}
          <span className="text-neutral-500">(optional)</span>
        </label>
        <textarea
          id="callout-message"
          name="message"
          rows={3}
          maxLength={1000}
          placeholder="Short factual details included in the invitation email. Do not include casualty details or other sensitive incident information."
          aria-invalid={Boolean(state.fieldErrors?.message)}
          aria-describedby="callout-message-error callout-message-hint"
          className={inputClass}
        />
        <p id="callout-message-hint" className="mt-1 text-xs text-neutral-500">
          This text is emailed verbatim to every invited member.
        </p>
        <FieldError
          id="callout-message-error"
          errors={state.fieldErrors?.message}
        />
      </div>

      <fieldset>
        <legend className={labelClass}>Who should be invited?</legend>
        <div className="mt-2 space-y-2">
          <label className="flex items-center gap-2 text-sm text-neutral-800">
            <input
              type="radio"
              name="audience"
              value="ORGANIZATION"
              checked={audience === "ORGANIZATION"}
              onChange={() => setAudience("ORGANIZATION")}
            />
            All active members of this organization
          </label>
          <label className="flex items-center gap-2 text-sm text-neutral-800">
            <input
              type="radio"
              name="audience"
              value="UNIT"
              checked={audience === "UNIT"}
              onChange={() => setAudience("UNIT")}
            />
            Members of one unit
          </label>
          <label className="flex items-center gap-2 text-sm text-neutral-800">
            <input
              type="radio"
              name="audience"
              value="MEMBERS"
              checked={audience === "MEMBERS"}
              onChange={() => setAudience("MEMBERS")}
            />
            Selected members
          </label>
        </div>
        <FieldError
          id="callout-audience-error"
          errors={state.fieldErrors?.audience}
        />
      </fieldset>

      {audience === "UNIT" && (
        <div>
          <label htmlFor="callout-unit" className={labelClass}>
            Unit
          </label>
          <select
            id="callout-unit"
            name="unitId"
            defaultValue=""
            aria-invalid={Boolean(state.fieldErrors?.unitId)}
            aria-describedby="callout-unit-error callout-unit-hint"
            className={inputClass}
          >
            <option value="">Choose a unit…</option>
            {units.map((unit) => (
              <option key={unit.id} value={unit.id}>
                {unit.name}
              </option>
            ))}
          </select>
          <p id="callout-unit-hint" className="mt-1 text-xs text-neutral-500">
            The unit&apos;s current active members are invited; the list is
            recorded at activation and does not change later.
          </p>
          <FieldError
            id="callout-unit-error"
            errors={state.fieldErrors?.unitId}
          />
        </div>
      )}

      {audience === "MEMBERS" && (
        <fieldset>
          <legend className={labelClass}>Members</legend>
          <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto rounded-md border border-neutral-200 p-2">
            {members.map((member) => (
              <li key={member.id}>
                <label className="flex items-center gap-2 rounded px-2 py-1.5 text-sm text-neutral-800 hover:bg-neutral-50">
                  <input type="checkbox" name="memberIds" value={member.id} />
                  <span>{member.displayName}</span>
                  {member.context && (
                    <span className="text-xs text-neutral-500">
                      {member.context}
                    </span>
                  )}
                </label>
              </li>
            ))}
          </ul>
          <FieldError
            id="callout-members-error"
            errors={state.fieldErrors?.memberIds}
          />
        </fieldset>
      )}

      {state.message && (
        <p className={errorClass} role="alert">
          {state.message}
        </p>
      )}
      <button type="submit" disabled={pending} className={buttonClass}>
        {pending ? "Activating…" : "Activate callout"}
      </button>
    </form>
  );
}

/** Close a callout — idempotent admin act; history is preserved. */
export function CloseCalloutButton({
  action,
}: {
  action: () => Promise<ActionState>;
}) {
  const [state, formAction, pending] = useActionState(() => action(), {});
  return (
    <form action={formAction}>
      <button
        type="submit"
        disabled={pending}
        className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-800 hover:bg-neutral-50 disabled:opacity-50"
      >
        {pending ? "Closing…" : "Close callout"}
      </button>
      {state.message && (
        <p className="mt-1 text-xs text-red-700" role="alert">
          {state.message}
        </p>
      )}
    </form>
  );
}

/**
 * Record a member's response on their behalf (e.g. they phoned the
 * station). The history row is attributed to the acting admin — it
 * never pretends to be a member's own response.
 */
export function AdminResponseForm({
  action,
  idPrefix,
}: {
  action: BoundAction;
  idPrefix: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="mt-2 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor={`${idPrefix}-response`}>
          Recorded response
        </label>
        <select
          id={`${idPrefix}-response`}
          name="response"
          required
          defaultValue=""
          className="rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
        >
          <option value="" disabled>
            Record response…
          </option>
          <option value="COMING">Coming</option>
          <option value="UNAVAILABLE">Unavailable</option>
        </select>
        <label className="sr-only" htmlFor={`${idPrefix}-note`}>
          Note
        </label>
        <input
          id={`${idPrefix}-note`}
          name="note"
          type="text"
          maxLength={200}
          placeholder="Note (e.g. confirmed by phone)"
          className="w-56 rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
        />
        <button
          type="submit"
          disabled={pending}
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
        >
          {pending ? "Recording…" : "Record"}
        </button>
      </div>
      {state.message && (
        <p className="text-xs text-red-700" role="alert">
          {state.message}
        </p>
      )}
    </form>
  );
}
