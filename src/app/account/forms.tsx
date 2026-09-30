"use client";

import { useState, useActionState } from "react";

import type { AvailabilityStatus } from "@prisma/client";

import type { ActionState } from "../admin/actions";

/**
 * Member-facing availability and contact-preference forms (issue #12).
 * Shared by the /account self-service surface and the admin member
 * page — both bind a server action that resolves the member server-side
 * (the memberId is bound into the action, never trusted from a field).
 *
 * All wording is deliberately factual: these controls record a
 * statement or a channel preference. They say nothing about crew
 * sufficiency, readiness, or who should be called.
 */

const inputClass =
  "mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm";
const labelClass = "block text-sm font-medium text-neutral-800";
const errorClass = "mt-1 text-sm text-red-700";
const buttonClass =
  "rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50";

type BoundAction = (
  prev: ActionState,
  formData: FormData,
) => Promise<ActionState>;

function FieldError({ id, errors }: { id: string; errors?: string[] }) {
  if (!errors?.length) return null;
  return (
    <p id={id} className={errorClass} role="alert">
      {errors.join(" ")}
    </p>
  );
}

const STATUS_OPTIONS: { value: AvailabilityStatus; label: string }[] = [
  { value: "AVAILABLE", label: "Available" },
  { value: "UNAVAILABLE", label: "Unavailable" },
  { value: "OFF_ISLAND", label: "Off island" },
  { value: "UNKNOWN", label: "Not specified" },
];

export function AvailabilityForm({
  action,
  defaultStatus = "UNKNOWN",
  defaultUntil,
  defaultNote,
  idPrefix = "availability",
}: {
  action: BoundAction;
  defaultStatus?: AvailabilityStatus;
  defaultUntil?: string | null;
  defaultNote?: string | null;
  idPrefix?: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const [status, setStatus] = useState<AvailabilityStatus>(defaultStatus);
  // The end date only applies to a real statement — hidden (and absent
  // from submission) while "Not specified" is selected.
  const showUntil = status !== "UNKNOWN";

  return (
    <form action={formAction} className="space-y-3">
      <div>
        <label htmlFor={`${idPrefix}-status`} className={labelClass}>
          Status
        </label>
        <select
          id={`${idPrefix}-status`}
          name="status"
          value={status}
          onChange={(e) => setStatus(e.target.value as AvailabilityStatus)}
          className={inputClass}
        >
          {STATUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <FieldError
          id={`${idPrefix}-status-error`}
          errors={state.fieldErrors?.status}
        />
      </div>
      {showUntil && (
        <div>
          <label htmlFor={`${idPrefix}-until`} className={labelClass}>
            Applies until (optional)
          </label>
          <input
            id={`${idPrefix}-until`}
            name="until"
            type="date"
            defaultValue={defaultUntil ?? ""}
            aria-invalid={Boolean(state.fieldErrors?.until)}
            aria-describedby={`${idPrefix}-until-hint ${idPrefix}-until-error`}
            className={inputClass}
          />
          <p
            id={`${idPrefix}-until-hint`}
            className="mt-1 text-xs text-neutral-500"
          >
            This status stays in effect through that day in the
            organization&apos;s timezone. After it passes, the status falls back
            to “Not specified”.
          </p>
          <FieldError
            id={`${idPrefix}-until-error`}
            errors={state.fieldErrors?.until}
          />
        </div>
      )}
      <div>
        <label htmlFor={`${idPrefix}-note`} className={labelClass}>
          Note (optional)
        </label>
        <input
          id={`${idPrefix}-note`}
          name="note"
          type="text"
          maxLength={200}
          defaultValue={defaultNote ?? ""}
          placeholder="e.g. Back on the island Oct 12"
          aria-invalid={Boolean(state.fieldErrors?.note)}
          aria-describedby={`${idPrefix}-note-error`}
          className={inputClass}
        />
        <FieldError
          id={`${idPrefix}-note-error`}
          errors={state.fieldErrors?.note}
        />
      </div>
      {state.message && (
        <p className={errorClass} role="alert">
          {state.message}
        </p>
      )}
      <button type="submit" disabled={pending} className={buttonClass}>
        {pending ? "Saving…" : "Update status"}
      </button>
    </form>
  );
}

const CHANNELS: {
  key: "notifyEmail" | "notifySms" | "notifyWhatsapp" | "notifyPush";
  label: string;
  /** Which member field must be recorded for this channel to apply. */
  needs: "email" | "phone" | null;
  destinationHint: string;
}[] = [
  {
    key: "notifyEmail",
    label: "Email",
    needs: "email",
    destinationHint: "Uses the email address on the member record.",
  },
  {
    key: "notifySms",
    label: "SMS",
    needs: "phone",
    destinationHint: "Uses the phone number on the member record.",
  },
  {
    key: "notifyWhatsapp",
    label: "WhatsApp",
    needs: "phone",
    destinationHint: "Uses the phone number on the member record.",
  },
  {
    key: "notifyPush",
    label: "Push",
    needs: null,
    destinationHint: "No device registered yet — records willingness only.",
  },
];

export function ContactPreferencesForm({
  action,
  email,
  phone,
  defaults,
  idPrefix = "contact",
}: {
  action: BoundAction;
  email: string | null;
  phone: string | null;
  defaults?: {
    notifyEmail: boolean;
    notifySms: boolean;
    notifyWhatsapp: boolean;
    notifyPush: boolean;
  } | null;
  idPrefix?: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const destination = (needs: "email" | "phone" | null) =>
    needs === "email" ? email : needs === "phone" ? phone : null;

  return (
    <form action={formAction} className="space-y-3">
      <fieldset>
        <legend className={labelClass}>
          Channels the member is willing to be notified on
        </legend>
        <p className="mt-1 text-xs text-neutral-500">
          Preferences only — SARbase does not send notifications yet, and a
          selected channel is not proof a message can be delivered.
        </p>
        <ul className="mt-2 space-y-2">
          {CHANNELS.map((channel) => {
            const dest = destination(channel.needs);
            const missingDestination = channel.needs != null && !dest;
            return (
              <li key={channel.key} className="flex items-start gap-3">
                <input
                  id={`${idPrefix}-${channel.key}`}
                  name={channel.key}
                  type="checkbox"
                  defaultChecked={defaults?.[channel.key] ?? false}
                  disabled={missingDestination}
                  aria-describedby={`${idPrefix}-${channel.key}-hint`}
                  className="mt-0.5 h-4 w-4 rounded border-neutral-300"
                />
                <div>
                  <label
                    htmlFor={`${idPrefix}-${channel.key}`}
                    className="text-sm font-medium text-neutral-800"
                  >
                    {channel.label}
                    {dest ? (
                      <span className="ml-2 font-normal text-neutral-500">
                        {dest}
                      </span>
                    ) : null}
                  </label>
                  <p
                    id={`${idPrefix}-${channel.key}-hint`}
                    className="text-xs text-neutral-500"
                  >
                    {missingDestination
                      ? `Requires a ${channel.needs === "email" ? "n email address" : " phone number"} on the member record.`
                      : channel.destinationHint}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      </fieldset>
      {state.message && (
        <p className={errorClass} role="alert">
          {state.message}
        </p>
      )}
      <button type="submit" disabled={pending} className={buttonClass}>
        {pending ? "Saving…" : "Save preferences"}
      </button>
    </form>
  );
}
