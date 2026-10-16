"use client";

import { useActionState, useState } from "react";

import type { ActionState } from "./actions";

/**
 * Administrator review of a member submission (issue #71). Two explicit
 * choices — approve or reject — with feedback to the member required on
 * rejection. Nothing is approved implicitly; the reviewer picks a button
 * and the named `decision` field carries the choice.
 */

const inputClass =
  "mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm";
const labelClass = "block text-sm font-medium text-neutral-800";
const errorClass = "mt-1 text-sm text-red-700";

type BoundAction = (
  prev: ActionState,
  formData: FormData,
) => Promise<ActionState>;

export function SubmissionReviewForm({
  action,
  idPrefix = "review",
}: {
  action: BoundAction;
  idPrefix?: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  // The note is only mandatory on rejection — tracking the pending
  // choice lets the hint say so honestly instead of being a static lie.
  const [decision, setDecision] = useState<"APPROVED" | "REJECTED" | null>(
    null,
  );

  return (
    <form action={formAction} className="space-y-3">
      <div>
        <label htmlFor={`${idPrefix}-note`} className={labelClass}>
          Note to the member{" "}
          <span className="font-normal text-neutral-500">
            (required when not accepting)
          </span>
        </label>
        <textarea
          id={`${idPrefix}-note`}
          name="note"
          rows={3}
          maxLength={500}
          required={decision === "REJECTED"}
          placeholder="Shown to the member with your decision."
          aria-invalid={Boolean(state.fieldErrors?.note)}
          aria-describedby={`${idPrefix}-note-error`}
          className={inputClass}
        />
        {state.fieldErrors?.note?.length ? (
          <p id={`${idPrefix}-note-error`} className={errorClass} role="alert">
            {state.fieldErrors.note.join(" ")}
          </p>
        ) : null}
      </div>
      {state.message && (
        <p className={errorClass} role="alert">
          {state.message}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          name="decision"
          value="APPROVED"
          disabled={pending}
          onClick={() => setDecision("APPROVED")}
          className="rounded-md bg-green-800 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
        >
          {pending && decision === "APPROVED"
            ? "Approving…"
            : "Approve and record"}
        </button>
        <button
          type="submit"
          name="decision"
          value="REJECTED"
          disabled={pending}
          onClick={() => setDecision("REJECTED")}
          className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-800 hover:bg-neutral-50 disabled:opacity-50"
        >
          {pending && decision === "REJECTED"
            ? "Sending back…"
            : "Do not accept"}
        </button>
      </div>
    </form>
  );
}
