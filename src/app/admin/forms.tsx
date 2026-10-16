"use client";

import {
  useActionState,
  useEffect,
  useReducer,
  useState,
  useTransition,
} from "react";

import type { OrgRole } from "@prisma/client";

import type { PhoneRegionOption } from "@/lib/contact";

import type { ActionState } from "./actions";
import { PhoneFields } from "./phone-fields";
import { TimezoneSelect } from "./timezone-select";
import {
  DEFAULT_ORGANIZATION_TIMEZONE,
  type TimeZoneOption,
} from "@/lib/timezones";

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
  defaultTimeZone,
  submitLabel,
  timeZoneOptions,
}: {
  action: BoundAction;
  defaultName?: string;
  defaultTimeZone?: string;
  submitLabel: string;
  /** Server-computed IANA option list for the timezone picker. */
  timeZoneOptions: TimeZoneOption[];
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
      <div>
        <label htmlFor="org-timezone" className={labelClass}>
          Timezone
        </label>
        <TimezoneSelect
          options={timeZoneOptions}
          defaultValue={defaultTimeZone ?? DEFAULT_ORGANIZATION_TIMEZONE}
          invalid={Boolean(state.fieldErrors?.timezone)}
        />
        <p id="org-timezone-hint" className="mt-1 text-xs text-neutral-500">
          Search by city, region, or UTC offset. Qualification expiry dates are
          evaluated against this zone.
        </p>
        <FieldError
          id="org-timezone-error"
          errors={state.fieldErrors?.timezone}
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
  regions,
  showEmergencyContact = true,
}: {
  action: BoundAction;
  defaults?: {
    displayName: string;
    email: string | null;
    phone: string | null;
    emergencyContactName?: string | null;
    emergencyContactPhone?: string | null;
  };
  submitLabel: string;
  /** Server-computed region list for the phone country selector. */
  regions: PhoneRegionOption[];
  /**
   * Emergency-contact fields are Administrator-only data (issue #84) —
   * hidden from MEMBERS_MANAGE managers. The action ignores them for
   * non-admin callers too; this flag only keeps them out of the DOM.
   */
  showEmergencyContact?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="space-y-3" aria-label="Member details">
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
      <PhoneFields
        idPrefix="member"
        regions={regions}
        defaultPhone={defaults?.phone}
        errors={state.fieldErrors?.phone}
      />
      {showEmergencyContact && (
        <fieldset className="space-y-3 border-t border-neutral-200 pt-3">
          <legend className="text-sm font-medium text-neutral-800">
            Emergency contact{" "}
            <span className="font-normal text-neutral-500">(optional)</span>
          </legend>
          <div>
            <label htmlFor="member-emergency-name" className={labelClass}>
              Contact name
            </label>
            <input
              id="member-emergency-name"
              name="emergencyContactName"
              type="text"
              maxLength={120}
              defaultValue={defaults?.emergencyContactName ?? undefined}
              aria-invalid={Boolean(state.fieldErrors?.emergencyContactName)}
              aria-describedby="member-emergency-name-error"
              className={inputClass}
            />
            <FieldError
              id="member-emergency-name-error"
              errors={state.fieldErrors?.emergencyContactName}
            />
          </div>
          <PhoneFields
            idPrefix="member-emergency"
            regions={regions}
            defaultPhone={defaults?.emergencyContactPhone}
            errors={state.fieldErrors?.emergencyContactPhone}
            fieldName="emergencyContactPhone"
            regionFieldName="emergencyContactPhoneRegion"
          />
        </fieldset>
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

export function LinkIdentityForm({
  action,
  defaultEmail,
}: {
  action: BoundAction;
  defaultEmail?: string | null;
}) {
  // Server errors describe the last SUBMITTED value — `state` is set
  // only from a real response, so an untouched or being-edited input
  // never carries one. Editing clears the previous response.
  const [state, setState] = useState<ActionState>({});
  const [email, setEmail] = useState(defaultEmail ?? "");
  const [pending, startTransition] = useTransition();

  return (
    <form
      action={(formData) =>
        startTransition(async () => {
          const result = await action({}, formData);
          setState(result);
          if (!result.fieldErrors && !result.message) {
            setEmail("");
          }
        })
      }
      className="space-y-4"
    >
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
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setState({});
          }}
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

/**
 * Primary onboarding action — email + organization role + (for ADMIN)
 * an explicit elevated-access confirmation.
 */
export function InviteMemberForm({
  action,
  defaultEmail,
  defaultRole = "MEMBER",
}: {
  action: BoundAction;
  defaultEmail?: string | null;
  defaultRole?: "MEMBER" | "ADMIN";
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const [role, setRole] = useState<"MEMBER" | "ADMIN">(defaultRole);
  const [confirmedAdmin, setConfirmedAdmin] = useState(false);
  const isAdmin = role === "ADMIN";

  return (
    <form action={formAction} className="space-y-4">
      <div>
        <label htmlFor="invite-email" className={labelClass}>
          Invitation email
        </label>
        <input
          id="invite-email"
          name="email"
          type="email"
          required
          maxLength={254}
          defaultValue={defaultEmail ?? undefined}
          placeholder="member@example.org"
          className={inputClass}
          aria-describedby="invite-email-error invite-email-hint"
          aria-invalid={state.fieldErrors?.email ? "true" : undefined}
        />
        <p id="invite-email-hint" className="mt-1 text-xs text-neutral-500">
          The recipient must sign in (or register) with this email address to
          accept the invitation.
        </p>
        <FieldError id="invite-email-error" errors={state.fieldErrors?.email} />
      </div>
      <div>
        <label htmlFor="invite-role" className={labelClass}>
          Organization role
        </label>
        <select
          id="invite-role"
          name="role"
          value={role}
          onChange={(e) => {
            setRole(e.target.value as "MEMBER" | "ADMIN");
            if (e.target.value !== "ADMIN") setConfirmedAdmin(false);
          }}
          className={inputClass}
          aria-describedby="invite-role-error"
        >
          <option value="MEMBER">Member</option>
          <option value="ADMIN">Administrator</option>
        </select>
        <FieldError id="invite-role-error" errors={state.fieldErrors?.role} />
      </div>
      {isAdmin && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3">
          <label className="flex items-start gap-2 text-sm text-neutral-800">
            <input
              type="checkbox"
              checked={confirmedAdmin}
              onChange={(e) => setConfirmedAdmin(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-neutral-300"
            />
            <span>
              This invitation grants <strong>administrator</strong> access: full
              control over members, settings, and records. Confirm that the
              recipient should receive elevated access.
            </span>
          </label>
        </div>
      )}
      {state.notice && (
        <p
          className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
          role="status"
        >
          {state.notice}
        </p>
      )}
      {state.message && (
        <p className={errorClass} role="alert">
          {state.message}
        </p>
      )}
      <button
        type="submit"
        disabled={pending || (isAdmin && !confirmedAdmin)}
        className={buttonClass}
      >
        {pending ? "Sending…" : "Send invitation"}
      </button>
    </form>
  );
}

/** Resend / revoke controls for an outstanding invitation. */
export function InvitationActionButtons({
  resendAction,
  revokeAction,
}: {
  resendAction: () => Promise<ActionState>;
  revokeAction: () => Promise<ActionState>;
}) {
  const [resendState, resendFormAction, resendPending] = useActionState(
    () => resendAction(),
    {},
  );
  const [revokeState, revokeFormAction, revokePending] = useActionState(
    () => revokeAction(),
    {},
  );
  const notice = resendState.notice ?? revokeState.notice;
  const error = resendState.message ?? revokeState.message;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <form action={resendFormAction}>
          <button
            type="submit"
            disabled={resendPending || revokePending}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-800 hover:bg-neutral-100 disabled:opacity-50"
          >
            {resendPending ? "Resending…" : "Resend invitation"}
          </button>
        </form>
        <form action={revokeFormAction}>
          <button
            type="submit"
            disabled={resendPending || revokePending}
            className="rounded-md border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
          >
            {revokePending ? "Revoking…" : "Revoke invitation"}
          </button>
        </form>
      </div>
      {notice && (
        <p className="text-sm text-amber-800" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className={errorClass} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Role-change confirmation state (issue #74). The pending intent records
 * the exact role the operator chose — never re-derived from the current
 * role — so a successful change that flips the rendered role cannot
 * silently re-purpose an open confirmation into the opposite action.
 */
export interface RoleChangeUIState {
  /** The role awaiting confirmation, or null when no change is pending. */
  intent: OrgRole | null;
}

export type RoleChangeUIEvent =
  | { type: "open"; role: OrgRole }
  | { type: "cancel" }
  | { type: "settled"; result: ActionState };

export function roleChangeUIReducer(
  state: RoleChangeUIState,
  event: RoleChangeUIEvent,
): RoleChangeUIState {
  switch (event.type) {
    case "open":
      return { intent: event.role };
    case "cancel":
      return { intent: null };
    case "settled":
      // A completed request ends the intent: a changed role returns
      // updatedRole, a same-role request returns a notice. An error
      // keeps the confirmation open so the operator sees what failed.
      if (event.result.updatedRole || event.result.notice) {
        return state.intent === null ? state : { intent: null };
      }
      return state;
  }
}

/** Blocks a second submission while a request is already in flight. */
export function preventSubmitWhilePending(
  pending: boolean,
  event: { preventDefault: () => void },
) {
  if (pending) event.preventDefault();
}

/**
 * Organization role change with explicit confirmation (issue #74).
 * The first click reveals a summary of the access being granted or
 * removed; the change submits only on the second, confirming click.
 */
export function AccessRoleForm({
  action,
  currentRole,
  targetLabel,
  isSelf,
}: {
  action: BoundAction;
  currentRole: OrgRole;
  /** Who the change applies to — shown inside the confirmation. */
  targetLabel: string;
  /** True when the administrator is changing their own grant. */
  isSelf: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const [ui, dispatch] = useReducer(roleChangeUIReducer, { intent: null });
  // Interim two-way toggle pending the full Manager UI: MANAGER rows
  // offer promotion to administrator; the domain clears their
  // capability grants on any role change regardless of direction.
  const nextRole = currentRole === "ADMIN" ? "MEMBER" : "ADMIN";
  const intentRole = ui.intent;

  useEffect(() => {
    dispatch({ type: "settled", result: state });
  }, [state]);

  return (
    <div className="space-y-2">
      {intentRole !== null ? (
        <form
          action={formAction}
          onSubmit={(event) => preventSubmitWhilePending(pending, event)}
          className="space-y-2"
        >
          <input type="hidden" name="role" value={intentRole} />
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-neutral-800">
            {intentRole === "ADMIN" ? (
              <p>
                <strong>{targetLabel}</strong> will become an{" "}
                <strong>administrator</strong>: they can manage members,
                invitations, settings, records, and other accounts&apos; roles
                in this organization. This is SARbase recordkeeping access only
                — it says nothing about operational or command authority.
              </p>
            ) : (
              <p>
                <strong>{targetLabel}</strong> will become a{" "}
                <strong>member</strong>: they lose all administrator
                capabilities and keep only member self-service access.
                {isSelf
                  ? " You are changing your own access — you will no longer be able to administer this organization."
                  : ""}
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={pending}
              className={
                intentRole === "ADMIN"
                  ? "rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
                  : "rounded-md border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
              }
            >
              {pending
                ? "Saving…"
                : `Confirm: make ${intentRole === "ADMIN" ? "administrator" : "member"}`}
            </button>
            <button
              type="button"
              onClick={() => dispatch({ type: "cancel" })}
              disabled={pending}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-800 hover:bg-neutral-100 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => dispatch({ type: "open", role: nextRole })}
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-800 hover:bg-neutral-100"
        >
          {currentRole === "ADMIN"
            ? "Change to Member"
            : "Change to Administrator"}
        </button>
      )}
      {state.updatedRole && intentRole === null && (
        <p className="text-sm text-green-800" role="status">
          {targetLabel} is now{" "}
          {state.updatedRole === "ADMIN"
            ? "an administrator"
            : state.updatedRole === "MANAGER"
              ? "a manager"
              : "a member"}
          .
        </p>
      )}
      {state.notice && intentRole === null && (
        <p className="text-sm text-amber-800" role="status">
          {state.notice}
        </p>
      )}
      {state.message && (
        <p className={errorClass} role="alert">
          {state.message}
        </p>
      )}
      {state.fieldErrors?.role?.length ? (
        <p className={errorClass} role="alert">
          {state.fieldErrors.role.join(" ")}
        </p>
      ) : null}
    </div>
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

export function QualificationDefinitionForm({
  action,
  defaults,
  submitLabel,
}: {
  action: BoundAction;
  defaults?: { name: string; description: string | null };
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="space-y-3">
      <div>
        <label htmlFor="qual-name" className={labelClass}>
          Qualification name
        </label>
        <input
          id="qual-name"
          name="name"
          type="text"
          required
          maxLength={120}
          defaultValue={defaults?.name}
          placeholder="e.g. First aid certificate"
          aria-invalid={Boolean(state.fieldErrors?.name)}
          aria-describedby="qual-name-error"
          className={inputClass}
        />
        <FieldError id="qual-name-error" errors={state.fieldErrors?.name} />
      </div>
      <div>
        <label htmlFor="qual-description" className={labelClass}>
          Description{" "}
          <span className="font-normal text-neutral-500">(optional)</span>
        </label>
        <textarea
          id="qual-description"
          name="description"
          rows={2}
          maxLength={500}
          defaultValue={defaults?.description ?? undefined}
          aria-invalid={Boolean(state.fieldErrors?.description)}
          aria-describedby="qual-description-error"
          className={inputClass}
        />
        <FieldError
          id="qual-description-error"
          errors={state.fieldErrors?.description}
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

interface QualificationRecordDefaults {
  definitionId?: string;
  issuedOn: string | null;
  expiresOn: string | null;
  issuer: string | null;
  reference: string | null;
  notes: string | null;
}

export function MemberQualificationForm({
  action,
  definitions,
  definitionName,
  defaults,
  submitLabel,
}: {
  action: BoundAction;
  /** Active definitions — shown only when creating a new record. */
  definitions?: { id: string; name: string }[];
  /** Shown read-only when editing (the definition is immutable). */
  definitionName?: string;
  defaults?: QualificationRecordDefaults;
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="space-y-3">
      {definitions ? (
        <div>
          <label htmlFor="mq-definition" className={labelClass}>
            Qualification
          </label>
          <select
            id="mq-definition"
            name="definitionId"
            required
            defaultValue={defaults?.definitionId ?? ""}
            aria-invalid={Boolean(state.fieldErrors?.definitionId)}
            aria-describedby="mq-definition-error"
            className={inputClass}
          >
            <option value="" disabled>
              Choose a qualification…
            </option>
            {definitions.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <FieldError
            id="mq-definition-error"
            errors={state.fieldErrors?.definitionId}
          />
        </div>
      ) : (
        <p className="text-sm text-neutral-600">
          Qualification:{" "}
          <span className="font-medium text-neutral-900">{definitionName}</span>
        </p>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="mq-issued" className={labelClass}>
            Issued on{" "}
            <span className="font-normal text-neutral-500">(optional)</span>
          </label>
          <input
            id="mq-issued"
            name="issuedOn"
            type="date"
            defaultValue={defaults?.issuedOn ?? undefined}
            aria-invalid={Boolean(state.fieldErrors?.issuedOn)}
            aria-describedby="mq-issued-error"
            className={inputClass}
          />
          <FieldError
            id="mq-issued-error"
            errors={state.fieldErrors?.issuedOn}
          />
        </div>
        <div>
          <label htmlFor="mq-expires" className={labelClass}>
            Expires on{" "}
            <span className="font-normal text-neutral-500">(optional)</span>
          </label>
          <input
            id="mq-expires"
            name="expiresOn"
            type="date"
            defaultValue={defaults?.expiresOn ?? undefined}
            aria-invalid={Boolean(state.fieldErrors?.expiresOn)}
            aria-describedby="mq-expires-error"
            className={inputClass}
          />
          <FieldError
            id="mq-expires-error"
            errors={state.fieldErrors?.expiresOn}
          />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="mq-issuer" className={labelClass}>
            Issuer{" "}
            <span className="font-normal text-neutral-500">(optional)</span>
          </label>
          <input
            id="mq-issuer"
            name="issuer"
            type="text"
            maxLength={120}
            defaultValue={defaults?.issuer ?? undefined}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="mq-reference" className={labelClass}>
            Reference no.{" "}
            <span className="font-normal text-neutral-500">(optional)</span>
          </label>
          <input
            id="mq-reference"
            name="reference"
            type="text"
            maxLength={120}
            defaultValue={defaults?.reference ?? undefined}
            className={inputClass}
          />
        </div>
      </div>
      <div>
        <label htmlFor="mq-notes" className={labelClass}>
          Notes <span className="font-normal text-neutral-500">(optional)</span>
        </label>
        <textarea
          id="mq-notes"
          name="notes"
          rows={2}
          maxLength={2000}
          defaultValue={defaults?.notes ?? undefined}
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

interface TrainingEventDefaults {
  title: string;
  date: string;
  unitId: string | null;
  durationMinutes: number | null;
  location: string | null;
  instructorName: string | null;
  leadMemberId: string | null;
  notes: string | null;
  followUp: string | null;
  topics: string;
}

export function TrainingEventForm({
  action,
  units,
  members,
  defaults,
  submitLabel,
}: {
  action: BoundAction;
  units: { id: string; name: string }[];
  members: { id: string; displayName: string }[];
  defaults?: Partial<TrainingEventDefaults>;
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="space-y-3">
      <div>
        <label htmlFor="te-title" className={labelClass}>
          Title
        </label>
        <input
          id="te-title"
          name="title"
          type="text"
          required
          maxLength={120}
          defaultValue={defaults?.title}
          aria-invalid={Boolean(state.fieldErrors?.title)}
          aria-describedby="te-title-error"
          className={inputClass}
        />
        <FieldError id="te-title-error" errors={state.fieldErrors?.title} />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="te-date" className={labelClass}>
            Date
          </label>
          <input
            id="te-date"
            name="date"
            type="date"
            required
            defaultValue={defaults?.date}
            aria-invalid={Boolean(state.fieldErrors?.date)}
            aria-describedby="te-date-error"
            className={inputClass}
          />
          <FieldError id="te-date-error" errors={state.fieldErrors?.date} />
        </div>
        <div>
          <label htmlFor="te-duration" className={labelClass}>
            Duration (minutes){" "}
            <span className="font-normal text-neutral-500">(optional)</span>
          </label>
          <input
            id="te-duration"
            name="durationMinutes"
            type="number"
            min={1}
            max={1440}
            defaultValue={defaults?.durationMinutes ?? undefined}
            aria-invalid={Boolean(state.fieldErrors?.durationMinutes)}
            aria-describedby="te-duration-error"
            className={inputClass}
          />
          <FieldError
            id="te-duration-error"
            errors={state.fieldErrors?.durationMinutes}
          />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="te-unit" className={labelClass}>
            Unit{" "}
            <span className="font-normal text-neutral-500">(optional)</span>
          </label>
          <select
            id="te-unit"
            name="unitId"
            defaultValue={defaults?.unitId ?? ""}
            className={inputClass}
          >
            <option value="">Organization-wide</option>
            {units.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="te-lead" className={labelClass}>
            Lead member{" "}
            <span className="font-normal text-neutral-500">(optional)</span>
          </label>
          <select
            id="te-lead"
            name="leadMemberId"
            defaultValue={defaults?.leadMemberId ?? ""}
            className={inputClass}
          >
            <option value="">None / external</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="te-location" className={labelClass}>
            Location{" "}
            <span className="font-normal text-neutral-500">(optional)</span>
          </label>
          <input
            id="te-location"
            name="location"
            type="text"
            maxLength={160}
            defaultValue={defaults?.location ?? undefined}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="te-instructor" className={labelClass}>
            Instructor{" "}
            <span className="font-normal text-neutral-500">(optional)</span>
          </label>
          <input
            id="te-instructor"
            name="instructorName"
            type="text"
            maxLength={120}
            defaultValue={defaults?.instructorName ?? undefined}
            placeholder="External instructor or agency name"
            className={inputClass}
          />
        </div>
      </div>
      <div>
        <label htmlFor="te-topics" className={labelClass}>
          Topics practiced{" "}
          <span className="font-normal text-neutral-500">
            (optional, comma-separated)
          </span>
        </label>
        <input
          id="te-topics"
          name="topics"
          type="text"
          defaultValue={defaults?.topics ?? undefined}
          placeholder="anchor handling, radio procedure"
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor="te-notes" className={labelClass}>
          Notes <span className="font-normal text-neutral-500">(optional)</span>
        </label>
        <textarea
          id="te-notes"
          name="notes"
          rows={2}
          maxLength={2000}
          defaultValue={defaults?.notes ?? undefined}
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor="te-followup" className={labelClass}>
          Follow-up{" "}
          <span className="font-normal text-neutral-500">(optional)</span>
        </label>
        <textarea
          id="te-followup"
          name="followUp"
          rows={2}
          maxLength={2000}
          defaultValue={defaults?.followUp ?? undefined}
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

export function TrainingAttendanceForm({
  action,
  members,
  attendedMemberIds,
}: {
  action: BoundAction;
  members: { id: string; displayName: string }[];
  attendedMemberIds: string[];
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const attended = new Set(attendedMemberIds);

  if (members.length === 0) {
    return (
      <p className="text-sm text-neutral-500">
        This organization has no members yet.
      </p>
    );
  }

  return (
    <form action={formAction} className="space-y-3">
      <fieldset>
        <legend className="text-sm font-medium text-neutral-800">
          Attendees
        </legend>
        <ul className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {members.map((member) => (
            <li key={member.id}>
              <label className="flex items-center gap-2 text-sm text-neutral-800">
                <input
                  type="checkbox"
                  name="memberIds"
                  value={member.id}
                  defaultChecked={attended.has(member.id)}
                  className="h-4 w-4 rounded border-neutral-300"
                />
                {member.displayName}
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
        {pending ? "Saving…" : "Save attendance"}
      </button>
    </form>
  );
}
