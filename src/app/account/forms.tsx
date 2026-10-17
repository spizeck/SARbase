"use client";

import { useState, useActionState } from "react";

import type { AvailabilityStatus } from "@prisma/client";

import type { PhoneRegionOption } from "@/lib/contact";
import { PhoneFields } from "../admin/phone-fields";
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
  whatsappConsented = false,
  defaults,
  idPrefix = "contact",
}: {
  action: BoundAction;
  email: string | null;
  phone: string | null;
  /** Live WhatsApp consent (consented + not opted out). */
  whatsappConsented?: boolean;
  defaults?: {
    notifyEmail: boolean;
    notifySms: boolean;
    notifyWhatsapp: boolean;
    notifyPush: boolean;
    preferredChannel?: "EMAIL" | "WHATSAPP" | null;
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
                  // A saved "willing" flag whose destination was later
                  // removed renders unchecked — a checked-but-disabled
                  // box would assert a preference that can't apply.
                  defaultChecked={
                    !missingDestination && (defaults?.[channel.key] ?? false)
                  }
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
      <div>
        <label htmlFor={`${idPrefix}-preferredChannel`} className={labelClass}>
          Preferred channel
        </label>
        <p className="mt-1 text-xs text-neutral-500">
          When more than one channel is enabled, notifications go to this one —
          SARbase never switches channels silently.
        </p>
        <select
          id={`${idPrefix}-preferredChannel`}
          name="preferredChannel"
          defaultValue={defaults?.preferredChannel ?? "EMAIL"}
          className="mt-1 block w-full rounded border-neutral-300 text-sm"
        >
          <option value="EMAIL">Email</option>
          <option value="WHATSAPP" disabled={!phone || !whatsappConsented}>
            WhatsApp{!whatsappConsented ? " (requires consent)" : ""}
          </option>
        </select>
      </div>
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

/**
 * Member callout response (issue #14) — same two factual choices as
 * the token link, recorded with source ACCOUNT against the caller's
 * own linked member record.
 */
export function CalloutResponseForm({
  action,
  currentResponse,
}: {
  action: BoundAction;
  currentResponse: "COMING" | "UNAVAILABLE" | null;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form
      action={formAction}
      className="mt-2 flex flex-wrap items-center gap-2"
    >
      <button
        type="submit"
        name="response"
        value="COMING"
        disabled={pending}
        aria-pressed={currentResponse === "COMING"}
        className={`rounded-md px-4 py-2 text-sm font-medium disabled:opacity-60 ${
          currentResponse === "COMING"
            ? "bg-green-800 text-white"
            : "bg-green-700 text-white hover:bg-green-800"
        }`}
      >
        {currentResponse === "COMING" ? "Coming ✓" : "I'm coming"}
      </button>
      <button
        type="submit"
        name="response"
        value="UNAVAILABLE"
        disabled={pending}
        aria-pressed={currentResponse === "UNAVAILABLE"}
        className={`rounded-md border px-4 py-2 text-sm font-medium disabled:opacity-60 ${
          currentResponse === "UNAVAILABLE"
            ? "border-amber-400 bg-amber-100 text-amber-900"
            : "border-neutral-300 text-neutral-800 hover:bg-neutral-50"
        }`}
      >
        {currentResponse === "UNAVAILABLE" ? "Unavailable ✓" : "Unavailable"}
      </button>
      {state.message && (
        <p className="w-full text-xs text-red-700" role="alert">
          {state.message}
        </p>
      )}
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* Issue #71 — member self-service contact details and submissions.    */
/*                                                                      */
/* Contact details: the member edits the permitted fields on their OWN */
/* linked record; every change is audited (MemberContactChange).       */
/*                                                                      */
/* Submissions: a member asks the organization to record a              */
/* qualification (with evidence) or to correct an existing record.     */
/* A pending submission changes nothing verified — it becomes fact     */
/* only when an organization administrator approves it.                */
/* ------------------------------------------------------------------ */

/**
 * The member-editable contact fields — email, own phone, and emergency
 * contact. The roster display name is deliberately absent: it is
 * administrative data, not self-service.
 */
export function ContactDetailsForm({
  action,
  defaults,
  regions,
  idPrefix = "details",
}: {
  action: BoundAction;
  defaults: {
    email: string | null;
    phone: string | null;
    emergencyContactName: string | null;
    emergencyContactPhone: string | null;
  };
  regions: PhoneRegionOption[];
  idPrefix?: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="space-y-3">
      <div>
        <label htmlFor={`${idPrefix}-email`} className={labelClass}>
          Email <span className="font-normal text-neutral-500">(optional)</span>
        </label>
        <input
          id={`${idPrefix}-email`}
          name="email"
          type="email"
          maxLength={254}
          autoComplete="email"
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
      <PhoneFields
        idPrefix={`${idPrefix}-phone`}
        regions={regions}
        defaultPhone={defaults.phone}
        errors={state.fieldErrors?.phone}
      />
      <fieldset className="space-y-3 border-t border-neutral-200 pt-3">
        <legend className="text-sm font-medium text-neutral-800">
          Emergency contact{" "}
          <span className="font-normal text-neutral-500">(optional)</span>
        </legend>
        <p className="text-xs text-neutral-500">
          Who your organization should contact for you in an emergency.
        </p>
        <div>
          <label htmlFor={`${idPrefix}-ec-name`} className={labelClass}>
            Contact name
          </label>
          <input
            id={`${idPrefix}-ec-name`}
            name="emergencyContactName"
            type="text"
            maxLength={120}
            autoComplete="off"
            defaultValue={defaults.emergencyContactName ?? undefined}
            aria-invalid={Boolean(state.fieldErrors?.emergencyContactName)}
            aria-describedby={`${idPrefix}-ec-name-error`}
            className={inputClass}
          />
          <FieldError
            id={`${idPrefix}-ec-name-error`}
            errors={state.fieldErrors?.emergencyContactName}
          />
        </div>
        <PhoneFields
          idPrefix={`${idPrefix}-ec-phone`}
          regions={regions}
          defaultPhone={defaults.emergencyContactPhone}
          errors={state.fieldErrors?.emergencyContactPhone}
          fieldName="emergencyContactPhone"
          regionFieldName="emergencyContactPhoneRegion"
        />
      </fieldset>
      {state.message && (
        <p className={errorClass} role="alert">
          {state.message}
        </p>
      )}
      {state.notice && (
        <p className="mt-1 text-sm text-green-800" role="status">
          {state.notice}
        </p>
      )}
      <button type="submit" disabled={pending} className={buttonClass}>
        {pending ? "Saving…" : "Save contact details"}
      </button>
    </form>
  );
}

/**
 * File a submission: a qualification claim (with the claimed dates and
 * issuer) or a correction to an existing qualification record. The kind
 * selector shows only the fields that kind uses — irrelevant fields are
 * unmounted so they cannot submit stray values.
 */
export function SubmissionForm({
  action,
  definitions,
  ownQualifications,
  idPrefix = "submission",
}: {
  action: BoundAction;
  /** This org's ACTIVE qualification definitions (id + name). */
  definitions: { id: string; name: string }[];
  /** The member's own existing qualification records (for corrections). */
  ownQualifications: { id: string; label: string }[];
  idPrefix?: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const [kind, setKind] = useState<"QUALIFICATION_CLAIM" | "RECORD_CORRECTION">(
    "QUALIFICATION_CLAIM",
  );

  return (
    <form action={formAction} className="space-y-3">
      <div>
        <label htmlFor={`${idPrefix}-kind`} className={labelClass}>
          What are you submitting?
        </label>
        <select
          id={`${idPrefix}-kind`}
          name="kind"
          value={kind}
          onChange={(e) =>
            setKind(
              e.target.value as "QUALIFICATION_CLAIM" | "RECORD_CORRECTION",
            )
          }
          className={inputClass}
        >
          <option value="QUALIFICATION_CLAIM">
            Qualification or training evidence
          </option>
          <option value="RECORD_CORRECTION">Record correction</option>
        </select>
        <FieldError
          id={`${idPrefix}-kind-error`}
          errors={state.fieldErrors?.kind}
        />
      </div>

      {kind === "QUALIFICATION_CLAIM" && (
        <>
          <div>
            <label htmlFor={`${idPrefix}-definition`} className={labelClass}>
              Qualification
            </label>
            <select
              id={`${idPrefix}-definition`}
              name="qualificationDefinitionId"
              aria-invalid={Boolean(
                state.fieldErrors?.qualificationDefinitionId,
              )}
              aria-describedby={`${idPrefix}-definition-error`}
              className={inputClass}
              defaultValue=""
            >
              <option value="" disabled>
                Choose a qualification…
              </option>
              {definitions.map((definition) => (
                <option key={definition.id} value={definition.id}>
                  {definition.name}
                </option>
              ))}
            </select>
            <FieldError
              id={`${idPrefix}-definition-error`}
              errors={state.fieldErrors?.qualificationDefinitionId}
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor={`${idPrefix}-issued`} className={labelClass}>
                Issue date{" "}
                <span className="font-normal text-neutral-500">(optional)</span>
              </label>
              <input
                id={`${idPrefix}-issued`}
                name="issuedOn"
                type="date"
                aria-invalid={Boolean(state.fieldErrors?.issuedOn)}
                aria-describedby={`${idPrefix}-issued-error`}
                className={inputClass}
              />
              <FieldError
                id={`${idPrefix}-issued-error`}
                errors={state.fieldErrors?.issuedOn}
              />
            </div>
            <div>
              <label htmlFor={`${idPrefix}-expires`} className={labelClass}>
                Expiry date{" "}
                <span className="font-normal text-neutral-500">(optional)</span>
              </label>
              <input
                id={`${idPrefix}-expires`}
                name="expiresOn"
                type="date"
                aria-invalid={Boolean(state.fieldErrors?.expiresOn)}
                aria-describedby={`${idPrefix}-expires-error`}
                className={inputClass}
              />
              <FieldError
                id={`${idPrefix}-expires-error`}
                errors={state.fieldErrors?.expiresOn}
              />
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor={`${idPrefix}-issuer`} className={labelClass}>
                Issuing organization{" "}
                <span className="font-normal text-neutral-500">(optional)</span>
              </label>
              <input
                id={`${idPrefix}-issuer`}
                name="issuer"
                type="text"
                maxLength={120}
                placeholder="e.g. KNRM"
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor={`${idPrefix}-reference`} className={labelClass}>
                Certificate or reference{" "}
                <span className="font-normal text-neutral-500">(optional)</span>
              </label>
              <input
                id={`${idPrefix}-reference`}
                name="reference"
                type="text"
                maxLength={120}
                className={inputClass}
              />
            </div>
          </div>
        </>
      )}

      {kind === "RECORD_CORRECTION" && (
        <div>
          <label htmlFor={`${idPrefix}-target`} className={labelClass}>
            Which record is wrong?{" "}
            <span className="font-normal text-neutral-500">(optional)</span>
          </label>
          <select
            id={`${idPrefix}-target`}
            name="targetMemberQualificationId"
            className={inputClass}
            defaultValue=""
          >
            <option value="">Not a specific record</option>
            {ownQualifications.map((record) => (
              <option key={record.id} value={record.id}>
                {record.label}
              </option>
            ))}
          </select>
          <FieldError
            id={`${idPrefix}-target-error`}
            errors={state.fieldErrors?.targetMemberQualificationId}
          />
        </div>
      )}

      <div>
        <label htmlFor={`${idPrefix}-details`} className={labelClass}>
          Details
        </label>
        <textarea
          id={`${idPrefix}-details`}
          name="details"
          required
          maxLength={2000}
          rows={4}
          placeholder={
            kind === "QUALIFICATION_CLAIM"
              ? "Describe the qualification — course, provider, certificate number…"
              : "What is wrong, and what should it say?"
          }
          aria-invalid={Boolean(state.fieldErrors?.details)}
          aria-describedby={`${idPrefix}-details-error`}
          className={inputClass}
        />
        <FieldError
          id={`${idPrefix}-details-error`}
          errors={state.fieldErrors?.details}
        />
      </div>

      <p className="text-xs text-neutral-500">
        An organization administrator reviews every submission. Nothing here
        changes your verified records until it is approved — you can attach
        evidence files after submitting.
      </p>

      {state.message && (
        <p className={errorClass} role="alert">
          {state.message}
        </p>
      )}
      <button type="submit" disabled={pending} className={buttonClass}>
        {pending ? "Submitting…" : "Submit for review"}
      </button>
    </form>
  );
}

/**
 * WhatsApp consent (issue #100) — self-service only. Consent is a
 * legal fact separate from the willingness checkboxes: granting or
 * opting out is explicit, timestamped, and audited. This form is the
 * ONLY surface that writes consent — staff preference editors never
 * render it.
 */
export function WhatsAppConsentForm({
  action,
  phone,
  consentedAt,
  optedOutAt,
}: {
  action: BoundAction;
  phone: string | null;
  consentedAt: Date | null;
  optedOutAt: Date | null;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const consented = consentedAt != null && optedOutAt == null;

  return (
    <form action={formAction} className="space-y-2">
      <fieldset>
        <legend className={labelClass}>WhatsApp consent</legend>
        <p className="mt-1 text-xs text-neutral-500">
          {consented
            ? `You consented to SARbase WhatsApp messages on ${consentedAt!.toLocaleDateString()}. Consent covers operational notifications to ${phone ?? "your phone number"} — it is never proof a message was delivered or that you responded.`
            : optedOutAt
              ? `You opted out of SARbase WhatsApp messages on ${optedOutAt.toLocaleDateString()}. Opting out stops future WhatsApp sends without changing any delivery history — you can consent again at any time.`
              : "SARbase can send operational messages (callout alerts, updates) to your phone number via WhatsApp — but only with your explicit consent. You can opt out at any time; opting out stops future WhatsApp sends without changing any delivery history."}
        </p>
        {!phone && (
          <p className="mt-1 text-xs text-neutral-500">
            A phone number on the member record is required before WhatsApp
            messages can reach you.
          </p>
        )}
      </fieldset>
      <input
        type="hidden"
        name="consent"
        value={consented ? "false" : "true"}
      />
      {state.message && (
        <p className={errorClass} role="alert">
          {state.message}
        </p>
      )}
      <button
        type="submit"
        disabled={pending || (!consented && !phone)}
        className={buttonClass}
      >
        {pending
          ? "Saving…"
          : consented
            ? "Opt out of WhatsApp"
            : "Consent to WhatsApp messages"}
      </button>
    </form>
  );
}
