"use client";

import { useActionState } from "react";

import type { ActionState } from "./actions";

/**
 * Forms for the admin notification surface (issue #13). Administrative
 * test sends and manual retries only — deliberately not a callout or
 * dispatch interface.
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

/**
 * Send one administrative test notification. Either a member target —
 * whose contact preferences are enforced — or a one-off email
 * destination, never both. The hidden idempotency key is generated per
 * page render so resubmitting an unchanged form replays rather than
 * double-sends.
 */
export function NotificationTestSendForm({
  action,
  members,
  idempotencyKey,
}: {
  action: BoundAction;
  members: { id: string; displayName: string; email: string | null }[];
  idempotencyKey: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <div>
        <label htmlFor="ntf-member" className={labelClass}>
          Member recipient
        </label>
        <select
          id="ntf-member"
          name="memberId"
          defaultValue=""
          aria-invalid={Boolean(state.fieldErrors?.memberId)}
          aria-describedby="ntf-member-error ntf-member-hint"
          className={inputClass}
        >
          <option value="">— or enter a one-off address below —</option>
          {members.map((member) => (
            <option key={member.id} value={member.id}>
              {member.displayName}
              {member.email ? "" : " (no email on record)"}
            </option>
          ))}
        </select>
        <p id="ntf-member-hint" className="mt-1 text-xs text-neutral-500">
          Member sends honor that member&apos;s contact preferences — a member
          who has not enabled email notifications will be recorded as
          suppressed, not sent.
        </p>
        <FieldError
          id="ntf-member-error"
          errors={state.fieldErrors?.memberId}
        />
      </div>
      <div>
        <label htmlFor="ntf-destination" className={labelClass}>
          One-off email address
        </label>
        <input
          id="ntf-destination"
          name="destination"
          type="email"
          maxLength={254}
          placeholder="ops@example.org"
          aria-invalid={Boolean(state.fieldErrors?.destination)}
          aria-describedby="ntf-destination-error"
          className={inputClass}
        />
        <FieldError
          id="ntf-destination-error"
          errors={state.fieldErrors?.destination}
        />
      </div>
      <div>
        <label htmlFor="ntf-subject" className={labelClass}>
          Subject
        </label>
        <input
          id="ntf-subject"
          name="subject"
          type="text"
          required
          maxLength={120}
          aria-invalid={Boolean(state.fieldErrors?.subject)}
          aria-describedby="ntf-subject-error"
          className={inputClass}
        />
        <FieldError
          id="ntf-subject-error"
          errors={state.fieldErrors?.subject}
        />
      </div>
      <div>
        <label htmlFor="ntf-body" className={labelClass}>
          Message
        </label>
        <textarea
          id="ntf-body"
          name="body"
          required
          rows={4}
          maxLength={4000}
          aria-invalid={Boolean(state.fieldErrors?.body)}
          aria-describedby="ntf-body-error"
          className={inputClass}
        />
        <FieldError id="ntf-body-error" errors={state.fieldErrors?.body} />
      </div>
      {state.message && (
        <p className={errorClass} role="alert">
          {state.message}
        </p>
      )}
      <button type="submit" disabled={pending} className={buttonClass}>
        {pending ? "Sending…" : "Send test notification"}
      </button>
    </form>
  );
}

/** Manual retry for an eligible failed/stuck notification. */
export function NotificationRetryButton({
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
        className="rounded-md border border-neutral-300 px-2 py-0.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
      >
        {pending ? "Retrying…" : "Retry send"}
      </button>
      {state.message && (
        <p className="mt-1 text-xs text-red-700" role="alert">
          {state.message}
        </p>
      )}
    </form>
  );
}
