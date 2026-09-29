"use client";

import { useActionState } from "react";

import type { ActionState } from "./actions";

/**
 * Issue #11 admin forms — inspections, maintenance plans/records,
 * defects, and meters. All wording stays factual: these record what
 * happened and what was scheduled, never whether an asset is fit.
 */

const inputClass =
  "mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm";
const labelClass = "block text-sm font-medium text-neutral-800";
const errorClass = "mt-1 text-sm text-red-700";
const buttonClass =
  "rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50";
const optionalMark = (
  <span className="font-normal text-neutral-500">(optional)</span>
);

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

const RECURRENCE_LABELS: Record<string, string> = {
  NONE: "Does not recur",
  CALENDAR_DAYS: "Every N days",
  CALENDAR_MONTHS: "Every N months",
  METER_INTERVAL: "Every N meter units",
};

const CONDITION_OPTIONS = [
  { value: "", label: "Not recorded" },
  { value: "GOOD", label: "Good" },
  { value: "FAIR", label: "Fair" },
  { value: "DAMAGED", label: "Damaged" },
];

type MemberOption = { id: string; displayName: string };
type MeterOption = { id: string; name: string; unit: string };

/* ------------------------------------------------------------------ */
/* Inspection definitions                                              */
/* ------------------------------------------------------------------ */

interface InspectionDefinitionDefaults {
  name: string;
  description: string | null;
  recurrenceType: "NONE" | "CALENDAR_DAYS" | "CALENDAR_MONTHS";
  intervalValue: number | null;
}

export function InspectionDefinitionForm({
  action,
  formId,
  defaults,
  submitLabel,
}: {
  action: BoundAction;
  formId: string;
  defaults?: Partial<InspectionDefinitionDefaults>;
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const id = (f: string) => `idef-${f}-${formId}`;
  return (
    <form action={formAction} className="space-y-3">
      <div>
        <label htmlFor={id("name")} className={labelClass}>
          Inspection name
        </label>
        <input
          id={id("name")}
          name="name"
          type="text"
          required
          maxLength={120}
          defaultValue={defaults?.name}
          placeholder="e.g. Monthly vessel visual inspection"
          aria-invalid={Boolean(state.fieldErrors?.name)}
          aria-describedby={id("name-error")}
          className={inputClass}
        />
        <FieldError id={id("name-error")} errors={state.fieldErrors?.name} />
      </div>
      <div>
        <label htmlFor={id("description")} className={labelClass}>
          Description {optionalMark}
        </label>
        <textarea
          id={id("description")}
          name="description"
          rows={2}
          maxLength={500}
          defaultValue={defaults?.description ?? undefined}
          className={inputClass}
        />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={id("recurrenceType")} className={labelClass}>
            Recurrence
          </label>
          <select
            id={id("recurrenceType")}
            name="recurrenceType"
            defaultValue={defaults?.recurrenceType ?? "NONE"}
            className={inputClass}
          >
            <option value="NONE">{RECURRENCE_LABELS.NONE}</option>
            <option value="CALENDAR_DAYS">
              {RECURRENCE_LABELS.CALENDAR_DAYS}
            </option>
            <option value="CALENDAR_MONTHS">
              {RECURRENCE_LABELS.CALENDAR_MONTHS}
            </option>
          </select>
        </div>
        <div>
          <label htmlFor={id("intervalValue")} className={labelClass}>
            Interval {optionalMark}
          </label>
          <input
            id={id("intervalValue")}
            name="intervalValue"
            type="number"
            min={1}
            max={36500}
            defaultValue={defaults?.intervalValue ?? undefined}
            placeholder="e.g. 30"
            aria-invalid={Boolean(state.fieldErrors?.intervalValue)}
            aria-describedby={id("intervalValue-error")}
            className={inputClass}
          />
          <FieldError
            id={id("intervalValue-error")}
            errors={state.fieldErrors?.intervalValue}
          />
        </div>
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

/* ------------------------------------------------------------------ */
/* Inspection records                                                  */
/* ------------------------------------------------------------------ */

export function InspectionRecordForm({
  action,
  formId,
  definitions,
  members,
  meters,
  defaultDate,
  submitLabel,
}: {
  action: BoundAction;
  formId: string;
  definitions: { id: string; name: string }[];
  members: MemberOption[];
  meters: MeterOption[];
  defaultDate?: string;
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const id = (f: string) => `irec-${f}-${formId}`;
  return (
    <form action={formAction} className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={id("definitionId")} className={labelClass}>
            Inspection type
          </label>
          <select
            id={id("definitionId")}
            name="definitionId"
            required
            defaultValue=""
            aria-invalid={Boolean(state.fieldErrors?.definitionId)}
            aria-describedby={id("definitionId-error")}
            className={inputClass}
          >
            <option value="" disabled>
              Choose…
            </option>
            {definitions.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <FieldError
            id={id("definitionId-error")}
            errors={state.fieldErrors?.definitionId}
          />
        </div>
        <div>
          <label htmlFor={id("performedOn")} className={labelClass}>
            Performed on
          </label>
          <input
            id={id("performedOn")}
            name="performedOn"
            type="date"
            required
            defaultValue={defaultDate}
            aria-invalid={Boolean(state.fieldErrors?.performedOn)}
            aria-describedby={id("performedOn-error")}
            className={inputClass}
          />
          <FieldError
            id={id("performedOn-error")}
            errors={state.fieldErrors?.performedOn}
          />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={id("inspectorMemberId")} className={labelClass}>
            Inspector (member) {optionalMark}
          </label>
          <select
            id={id("inspectorMemberId")}
            name="inspectorMemberId"
            defaultValue=""
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
        <div>
          <label htmlFor={id("inspectorName")} className={labelClass}>
            Inspector name {optionalMark}
          </label>
          <input
            id={id("inspectorName")}
            name="inspectorName"
            type="text"
            maxLength={120}
            placeholder="e.g. external surveyor"
            className={inputClass}
          />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={id("conditionObserved")} className={labelClass}>
            Observed condition {optionalMark}
          </label>
          <select
            id={id("conditionObserved")}
            name="conditionObserved"
            defaultValue=""
            className={inputClass}
          >
            {CONDITION_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={id("nextDueOn")} className={labelClass}>
            Next due {optionalMark}
          </label>
          <input
            id={id("nextDueOn")}
            name="nextDueOn"
            type="date"
            aria-invalid={Boolean(state.fieldErrors?.nextDueOn)}
            aria-describedby={id("nextDueOn-error")}
            className={inputClass}
          />
          <p className="mt-1 text-xs text-neutral-500">
            Blank = derived from the inspection type&rsquo;s recurrence.
          </p>
          <FieldError
            id={id("nextDueOn-error")}
            errors={state.fieldErrors?.nextDueOn}
          />
        </div>
      </div>
      {meters.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor={id("meterId")} className={labelClass}>
              Meter {optionalMark}
            </label>
            <select
              id={id("meterId")}
              name="meterId"
              defaultValue=""
              className={inputClass}
            >
              <option value="">No reading</option>
              {meters.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.unit})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={id("meterReading")} className={labelClass}>
              Meter reading {optionalMark}
            </label>
            <input
              id={id("meterReading")}
              name="meterReading"
              type="text"
              inputMode="decimal"
              placeholder="e.g. 812.4"
              aria-invalid={Boolean(state.fieldErrors?.meterReading)}
              aria-describedby={id("meterReading-error")}
              className={inputClass}
            />
            <FieldError
              id={id("meterReading-error")}
              errors={state.fieldErrors?.meterReading}
            />
          </div>
        </div>
      )}
      <div>
        <label htmlFor={id("notes")} className={labelClass}>
          Notes {optionalMark}
        </label>
        <textarea
          id={id("notes")}
          name="notes"
          rows={2}
          maxLength={2000}
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

interface InspectionRecordEditDefaults {
  performedOn: string;
  inspectorMemberId: string | null;
  inspectorName: string | null;
  conditionObserved: string | null;
  nextDueOn: string | null;
  notes: string | null;
}

export function InspectionRecordEditForm({
  action,
  formId,
  members,
  defaults,
  submitLabel,
}: {
  action: BoundAction;
  formId: string;
  members: MemberOption[];
  defaults: InspectionRecordEditDefaults;
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const id = (f: string) => `irecedit-${f}-${formId}`;
  return (
    <form action={formAction} className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={id("performedOn")} className={labelClass}>
            Performed on
          </label>
          <input
            id={id("performedOn")}
            name="performedOn"
            type="date"
            required
            defaultValue={defaults.performedOn}
            aria-invalid={Boolean(state.fieldErrors?.performedOn)}
            aria-describedby={id("performedOn-error")}
            className={inputClass}
          />
          <FieldError
            id={id("performedOn-error")}
            errors={state.fieldErrors?.performedOn}
          />
        </div>
        <div>
          <label htmlFor={id("nextDueOn")} className={labelClass}>
            Next due {optionalMark}
          </label>
          <input
            id={id("nextDueOn")}
            name="nextDueOn"
            type="date"
            defaultValue={defaults.nextDueOn ?? undefined}
            aria-invalid={Boolean(state.fieldErrors?.nextDueOn)}
            aria-describedby={id("nextDueOn-error")}
            className={inputClass}
          />
          <FieldError
            id={id("nextDueOn-error")}
            errors={state.fieldErrors?.nextDueOn}
          />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={id("inspectorMemberId")} className={labelClass}>
            Inspector (member) {optionalMark}
          </label>
          <select
            id={id("inspectorMemberId")}
            name="inspectorMemberId"
            defaultValue={defaults.inspectorMemberId ?? ""}
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
        <div>
          <label htmlFor={id("inspectorName")} className={labelClass}>
            Inspector name {optionalMark}
          </label>
          <input
            id={id("inspectorName")}
            name="inspectorName"
            type="text"
            maxLength={120}
            defaultValue={defaults.inspectorName ?? undefined}
            className={inputClass}
          />
        </div>
      </div>
      <div>
        <label htmlFor={id("conditionObserved")} className={labelClass}>
          Observed condition {optionalMark}
        </label>
        <select
          id={id("conditionObserved")}
          name="conditionObserved"
          defaultValue={defaults.conditionObserved ?? ""}
          className={inputClass}
        >
          {CONDITION_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor={id("notes")} className={labelClass}>
          Notes {optionalMark}
        </label>
        <textarea
          id={id("notes")}
          name="notes"
          rows={2}
          maxLength={2000}
          defaultValue={defaults.notes ?? undefined}
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor={id("correctionNote")} className={labelClass}>
          Correction note {optionalMark}
        </label>
        <input
          id={id("correctionNote")}
          name="correctionNote"
          type="text"
          maxLength={500}
          placeholder="Why is this record being corrected?"
          aria-invalid={Boolean(state.fieldErrors?.correctionNote)}
          aria-describedby={id("correctionNote-error")}
          className={inputClass}
        />
        <FieldError
          id={id("correctionNote-error")}
          errors={state.fieldErrors?.correctionNote}
        />
        <p className="mt-1 text-xs text-neutral-500">
          Material corrections are preserved in an immutable change history.
        </p>
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

/* ------------------------------------------------------------------ */
/* Maintenance plans                                                   */
/* ------------------------------------------------------------------ */

interface MaintenancePlanDefaults {
  name: string;
  description: string | null;
  intervalType: "NONE" | "CALENDAR_DAYS" | "CALENDAR_MONTHS" | "METER_INTERVAL";
  intervalValue: number | null;
  meterId: string | null;
  meterInterval: string | null;
}

export function MaintenancePlanForm({
  action,
  formId,
  meters,
  defaults,
  submitLabel,
}: {
  action: BoundAction;
  formId: string;
  meters: MeterOption[];
  defaults?: Partial<MaintenancePlanDefaults>;
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const id = (f: string) => `plan-${f}-${formId}`;
  return (
    <form action={formAction} className="space-y-3">
      <div>
        <label htmlFor={id("name")} className={labelClass}>
          Plan name
        </label>
        <input
          id={id("name")}
          name="name"
          type="text"
          required
          maxLength={120}
          defaultValue={defaults?.name}
          placeholder="e.g. Engine oil change"
          aria-invalid={Boolean(state.fieldErrors?.name)}
          aria-describedby={id("name-error")}
          className={inputClass}
        />
        <FieldError id={id("name-error")} errors={state.fieldErrors?.name} />
      </div>
      <div>
        <label htmlFor={id("description")} className={labelClass}>
          Description {optionalMark}
        </label>
        <textarea
          id={id("description")}
          name="description"
          rows={2}
          maxLength={500}
          defaultValue={defaults?.description ?? undefined}
          className={inputClass}
        />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={id("intervalType")} className={labelClass}>
            Interval
          </label>
          <select
            id={id("intervalType")}
            name="intervalType"
            defaultValue={defaults?.intervalType ?? "NONE"}
            className={inputClass}
          >
            <option value="NONE">{RECURRENCE_LABELS.NONE}</option>
            <option value="CALENDAR_DAYS">
              {RECURRENCE_LABELS.CALENDAR_DAYS}
            </option>
            <option value="CALENDAR_MONTHS">
              {RECURRENCE_LABELS.CALENDAR_MONTHS}
            </option>
            <option value="METER_INTERVAL">
              {RECURRENCE_LABELS.METER_INTERVAL}
            </option>
          </select>
          <FieldError
            id={id("intervalType-error")}
            errors={state.fieldErrors?.intervalType}
          />
        </div>
        <div>
          <label htmlFor={id("intervalValue")} className={labelClass}>
            Calendar interval {optionalMark}
          </label>
          <input
            id={id("intervalValue")}
            name="intervalValue"
            type="number"
            min={1}
            max={36500}
            defaultValue={defaults?.intervalValue ?? undefined}
            placeholder="days or months"
            aria-invalid={Boolean(state.fieldErrors?.intervalValue)}
            aria-describedby={id("intervalValue-error")}
            className={inputClass}
          />
          <FieldError
            id={id("intervalValue-error")}
            errors={state.fieldErrors?.intervalValue}
          />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={id("meterId")} className={labelClass}>
            Meter {optionalMark}
          </label>
          <select
            id={id("meterId")}
            name="meterId"
            defaultValue={defaults?.meterId ?? ""}
            aria-invalid={Boolean(state.fieldErrors?.meterId)}
            aria-describedby={id("meterId-error")}
            className={inputClass}
          >
            <option value="">None</option>
            {meters.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.unit})
              </option>
            ))}
          </select>
          <FieldError
            id={id("meterId-error")}
            errors={state.fieldErrors?.meterId}
          />
        </div>
        <div>
          <label htmlFor={id("meterInterval")} className={labelClass}>
            Meter interval {optionalMark}
          </label>
          <input
            id={id("meterInterval")}
            name="meterInterval"
            type="text"
            inputMode="decimal"
            defaultValue={defaults?.meterInterval ?? undefined}
            placeholder="e.g. 100"
            aria-invalid={Boolean(state.fieldErrors?.meterInterval)}
            aria-describedby={id("meterInterval-error")}
            className={inputClass}
          />
          <FieldError
            id={id("meterInterval-error")}
            errors={state.fieldErrors?.meterInterval}
          />
        </div>
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

/* ------------------------------------------------------------------ */
/* Maintenance records                                                 */
/* ------------------------------------------------------------------ */

export function MaintenanceRecordForm({
  action,
  formId,
  plans,
  members,
  meters,
  defaultDate,
  submitLabel,
}: {
  action: BoundAction;
  formId: string;
  plans: { id: string; name: string }[];
  members: MemberOption[];
  meters: MeterOption[];
  defaultDate?: string;
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const id = (f: string) => `mrec-${f}-${formId}`;
  return (
    <form action={formAction} className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={id("title")} className={labelClass}>
            Work done
          </label>
          <input
            id={id("title")}
            name="title"
            type="text"
            required
            maxLength={120}
            placeholder="e.g. Engine oil change"
            aria-invalid={Boolean(state.fieldErrors?.title)}
            aria-describedby={id("title-error")}
            className={inputClass}
          />
          <FieldError
            id={id("title-error")}
            errors={state.fieldErrors?.title}
          />
        </div>
        <div>
          <label htmlFor={id("performedOn")} className={labelClass}>
            Performed on
          </label>
          <input
            id={id("performedOn")}
            name="performedOn"
            type="date"
            required
            defaultValue={defaultDate}
            aria-invalid={Boolean(state.fieldErrors?.performedOn)}
            aria-describedby={id("performedOn-error")}
            className={inputClass}
          />
          <FieldError
            id={id("performedOn-error")}
            errors={state.fieldErrors?.performedOn}
          />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={id("planId")} className={labelClass}>
            Maintenance plan {optionalMark}
          </label>
          <select
            id={id("planId")}
            name="planId"
            defaultValue=""
            className={inputClass}
          >
            <option value="">None (ad-hoc work)</option>
            {plans.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={id("nextDueOn")} className={labelClass}>
            Next due {optionalMark}
          </label>
          <input
            id={id("nextDueOn")}
            name="nextDueOn"
            type="date"
            aria-invalid={Boolean(state.fieldErrors?.nextDueOn)}
            aria-describedby={id("nextDueOn-error")}
            className={inputClass}
          />
          <p className="mt-1 text-xs text-neutral-500">
            For ad-hoc work; plan-linked records derive the due date from the
            plan.
          </p>
          <FieldError
            id={id("nextDueOn-error")}
            errors={state.fieldErrors?.nextDueOn}
          />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={id("performedByMemberId")} className={labelClass}>
            Performed by (member) {optionalMark}
          </label>
          <select
            id={id("performedByMemberId")}
            name="performedByMemberId"
            defaultValue=""
            className={inputClass}
          >
            <option value="">Not recorded</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={id("providerName")} className={labelClass}>
            Provider / technician {optionalMark}
          </label>
          <input
            id={id("providerName")}
            name="providerName"
            type="text"
            maxLength={120}
            placeholder="e.g. Marina Services"
            className={inputClass}
          />
        </div>
      </div>
      {meters.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor={id("meterId")} className={labelClass}>
              Meter {optionalMark}
            </label>
            <select
              id={id("meterId")}
              name="meterId"
              defaultValue=""
              className={inputClass}
            >
              <option value="">No reading</option>
              {meters.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.unit})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={id("meterReading")} className={labelClass}>
              Meter reading {optionalMark}
            </label>
            <input
              id={id("meterReading")}
              name="meterReading"
              type="text"
              inputMode="decimal"
              placeholder="e.g. 812.4"
              aria-invalid={Boolean(state.fieldErrors?.meterReading)}
              aria-describedby={id("meterReading-error")}
              className={inputClass}
            />
            <FieldError
              id={id("meterReading-error")}
              errors={state.fieldErrors?.meterReading}
            />
          </div>
        </div>
      )}
      <div>
        <label htmlFor={id("workPerformed")} className={labelClass}>
          Work performed {optionalMark}
        </label>
        <textarea
          id={id("workPerformed")}
          name="workPerformed"
          rows={2}
          maxLength={2000}
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor={id("notes")} className={labelClass}>
          Notes {optionalMark}
        </label>
        <textarea
          id={id("notes")}
          name="notes"
          rows={2}
          maxLength={2000}
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

interface MaintenanceRecordEditDefaults {
  title: string;
  performedOn: string;
  workPerformed: string | null;
  providerName: string | null;
  performedByMemberId: string | null;
  nextDueOn: string | null;
  notes: string | null;
}

export function MaintenanceRecordEditForm({
  action,
  formId,
  members,
  defaults,
  submitLabel,
}: {
  action: BoundAction;
  formId: string;
  members: MemberOption[];
  defaults: MaintenanceRecordEditDefaults;
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const id = (f: string) => `mrecedit-${f}-${formId}`;
  return (
    <form action={formAction} className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={id("title")} className={labelClass}>
            Work done
          </label>
          <input
            id={id("title")}
            name="title"
            type="text"
            required
            maxLength={120}
            defaultValue={defaults.title}
            aria-invalid={Boolean(state.fieldErrors?.title)}
            aria-describedby={id("title-error")}
            className={inputClass}
          />
          <FieldError
            id={id("title-error")}
            errors={state.fieldErrors?.title}
          />
        </div>
        <div>
          <label htmlFor={id("performedOn")} className={labelClass}>
            Performed on
          </label>
          <input
            id={id("performedOn")}
            name="performedOn"
            type="date"
            required
            defaultValue={defaults.performedOn}
            aria-invalid={Boolean(state.fieldErrors?.performedOn)}
            aria-describedby={id("performedOn-error")}
            className={inputClass}
          />
          <FieldError
            id={id("performedOn-error")}
            errors={state.fieldErrors?.performedOn}
          />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={id("performedByMemberId")} className={labelClass}>
            Performed by (member) {optionalMark}
          </label>
          <select
            id={id("performedByMemberId")}
            name="performedByMemberId"
            defaultValue={defaults.performedByMemberId ?? ""}
            className={inputClass}
          >
            <option value="">Not recorded</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={id("providerName")} className={labelClass}>
            Provider / technician {optionalMark}
          </label>
          <input
            id={id("providerName")}
            name="providerName"
            type="text"
            maxLength={120}
            defaultValue={defaults.providerName ?? undefined}
            className={inputClass}
          />
        </div>
      </div>
      <div>
        <label htmlFor={id("nextDueOn")} className={labelClass}>
          Next due {optionalMark}
        </label>
        <input
          id={id("nextDueOn")}
          name="nextDueOn"
          type="date"
          defaultValue={defaults.nextDueOn ?? undefined}
          aria-invalid={Boolean(state.fieldErrors?.nextDueOn)}
          aria-describedby={id("nextDueOn-error")}
          className={inputClass}
        />
        <FieldError
          id={id("nextDueOn-error")}
          errors={state.fieldErrors?.nextDueOn}
        />
      </div>
      <div>
        <label htmlFor={id("workPerformed")} className={labelClass}>
          Work performed {optionalMark}
        </label>
        <textarea
          id={id("workPerformed")}
          name="workPerformed"
          rows={2}
          maxLength={2000}
          defaultValue={defaults.workPerformed ?? undefined}
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor={id("notes")} className={labelClass}>
          Notes {optionalMark}
        </label>
        <textarea
          id={id("notes")}
          name="notes"
          rows={2}
          maxLength={2000}
          defaultValue={defaults.notes ?? undefined}
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor={id("correctionNote")} className={labelClass}>
          Correction note {optionalMark}
        </label>
        <input
          id={id("correctionNote")}
          name="correctionNote"
          type="text"
          maxLength={500}
          placeholder="Why is this record being corrected?"
          aria-invalid={Boolean(state.fieldErrors?.correctionNote)}
          aria-describedby={id("correctionNote-error")}
          className={inputClass}
        />
        <FieldError
          id={id("correctionNote-error")}
          errors={state.fieldErrors?.correctionNote}
        />
        <p className="mt-1 text-xs text-neutral-500">
          Material corrections are preserved in an immutable change history.
        </p>
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

/* ------------------------------------------------------------------ */
/* Defects                                                             */
/* ------------------------------------------------------------------ */

interface DefectDefaults {
  title: string;
  description: string | null;
  reportedOn: string;
  reportedByMemberId: string | null;
  reporterName: string | null;
}

export function DefectForm({
  action,
  formId,
  members,
  defaultDate,
  defaults,
  showMarkOutOfService = false,
  submitLabel,
}: {
  action: BoundAction;
  formId: string;
  members: MemberOption[];
  defaultDate?: string;
  defaults?: Partial<DefectDefaults>;
  showMarkOutOfService?: boolean;
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const id = (f: string) => `def-${f}-${formId}`;
  return (
    <form action={formAction} className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={id("title")} className={labelClass}>
            Title
          </label>
          <input
            id={id("title")}
            name="title"
            type="text"
            required
            maxLength={120}
            defaultValue={defaults?.title}
            placeholder="e.g. Bilge pump intermittent"
            aria-invalid={Boolean(state.fieldErrors?.title)}
            aria-describedby={id("title-error")}
            className={inputClass}
          />
          <FieldError
            id={id("title-error")}
            errors={state.fieldErrors?.title}
          />
        </div>
        <div>
          <label htmlFor={id("reportedOn")} className={labelClass}>
            Reported on
          </label>
          <input
            id={id("reportedOn")}
            name="reportedOn"
            type="date"
            required
            defaultValue={defaults?.reportedOn ?? defaultDate}
            aria-invalid={Boolean(state.fieldErrors?.reportedOn)}
            aria-describedby={id("reportedOn-error")}
            className={inputClass}
          />
          <FieldError
            id={id("reportedOn-error")}
            errors={state.fieldErrors?.reportedOn}
          />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={id("reportedByMemberId")} className={labelClass}>
            Reported by (member) {optionalMark}
          </label>
          <select
            id={id("reportedByMemberId")}
            name="reportedByMemberId"
            defaultValue={defaults?.reportedByMemberId ?? ""}
            className={inputClass}
          >
            <option value="">Not recorded</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={id("reporterName")} className={labelClass}>
            Reporter name {optionalMark}
          </label>
          <input
            id={id("reporterName")}
            name="reporterName"
            type="text"
            maxLength={120}
            defaultValue={defaults?.reporterName ?? undefined}
            placeholder="e.g. harbor staff"
            className={inputClass}
          />
        </div>
      </div>
      <div>
        <label htmlFor={id("description")} className={labelClass}>
          Description {optionalMark}
        </label>
        <textarea
          id={id("description")}
          name="description"
          rows={2}
          maxLength={2000}
          defaultValue={defaults?.description ?? undefined}
          className={inputClass}
        />
      </div>
      {showMarkOutOfService && (
        <div className="flex items-start gap-2">
          <input
            id={id("markOutOfService")}
            name="markOutOfService"
            type="checkbox"
            className="mt-1 h-4 w-4 rounded border-neutral-300"
          />
          <label
            htmlFor={id("markOutOfService")}
            className="text-sm text-neutral-800"
          >
            Also mark this asset out of service{" "}
            <span className="text-neutral-500">
              (an explicit, reversible choice — the defect itself changes
              nothing)
            </span>
          </label>
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

/**
 * Resolve or reopen a defect. `target` is the desired status —
 * "RESOLVED" shows the resolution fields; "OPEN" is a reopen with an
 * optional note.
 */
export function DefectTransitionForm({
  action,
  formId,
  target,
  defaultDate,
}: {
  action: BoundAction;
  formId: string;
  target: "OPEN" | "RESOLVED";
  defaultDate?: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const id = (f: string) => `deftr-${f}-${formId}`;
  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="status" value={target} />
      {target === "RESOLVED" && (
        <>
          <div>
            <label htmlFor={id("resolvedOn")} className={labelClass}>
              Resolved on
            </label>
            <input
              id={id("resolvedOn")}
              name="resolvedOn"
              type="date"
              required
              defaultValue={defaultDate}
              aria-invalid={Boolean(state.fieldErrors?.resolvedOn)}
              aria-describedby={id("resolvedOn-error")}
              className={inputClass}
            />
            <FieldError
              id={id("resolvedOn-error")}
              errors={state.fieldErrors?.resolvedOn}
            />
          </div>
          <div>
            <label htmlFor={id("resolutionNotes")} className={labelClass}>
              Resolution notes {optionalMark}
            </label>
            <textarea
              id={id("resolutionNotes")}
              name="resolutionNotes"
              rows={2}
              maxLength={2000}
              className={inputClass}
            />
          </div>
        </>
      )}
      <div>
        <label htmlFor={id("note")} className={labelClass}>
          History note {optionalMark}
        </label>
        <input
          id={id("note")}
          name="note"
          type="text"
          maxLength={1000}
          className={inputClass}
        />
      </div>
      {state.message && (
        <p className={errorClass} role="alert">
          {state.message}
        </p>
      )}
      <button type="submit" disabled={pending} className={buttonClass}>
        {pending
          ? "Saving…"
          : target === "RESOLVED"
            ? "Resolve defect"
            : "Reopen defect"}
      </button>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* Meters                                                              */
/* ------------------------------------------------------------------ */

export function AssetMeterForm({
  action,
  formId,
  defaults,
  submitLabel,
}: {
  action: BoundAction;
  formId: string;
  defaults?: { name?: string; unit?: string };
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const id = (f: string) => `meter-${f}-${formId}`;
  return (
    <form action={formAction} className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={id("name")} className={labelClass}>
            Meter name
          </label>
          <input
            id={id("name")}
            name="name"
            type="text"
            required
            maxLength={120}
            defaultValue={defaults?.name}
            placeholder="e.g. Engine hours"
            aria-invalid={Boolean(state.fieldErrors?.name)}
            aria-describedby={id("name-error")}
            className={inputClass}
          />
          <FieldError id={id("name-error")} errors={state.fieldErrors?.name} />
        </div>
        <div>
          <label htmlFor={id("unit")} className={labelClass}>
            Unit
          </label>
          <input
            id={id("unit")}
            name="unit"
            type="text"
            required
            maxLength={30}
            defaultValue={defaults?.unit}
            placeholder="e.g. hours, km, cycles"
            aria-invalid={Boolean(state.fieldErrors?.unit)}
            aria-describedby={id("unit-error")}
            className={inputClass}
          />
          <FieldError id={id("unit-error")} errors={state.fieldErrors?.unit} />
        </div>
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

export function MeterReadingForm({
  action,
  formId,
  members,
  defaultDate,
  submitLabel,
}: {
  action: BoundAction;
  formId: string;
  members: MemberOption[];
  defaultDate?: string;
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const id = (f: string) => `reading-${f}-${formId}`;
  return (
    <form action={formAction} className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={id("reading")} className={labelClass}>
            Reading
          </label>
          <input
            id={id("reading")}
            name="reading"
            type="text"
            inputMode="decimal"
            required
            placeholder="e.g. 812.4"
            aria-invalid={Boolean(state.fieldErrors?.reading)}
            aria-describedby={id("reading-error")}
            className={inputClass}
          />
          <FieldError
            id={id("reading-error")}
            errors={state.fieldErrors?.reading}
          />
        </div>
        <div>
          <label htmlFor={id("recordedOn")} className={labelClass}>
            Recorded on
          </label>
          <input
            id={id("recordedOn")}
            name="recordedOn"
            type="date"
            required
            defaultValue={defaultDate}
            aria-invalid={Boolean(state.fieldErrors?.recordedOn)}
            aria-describedby={id("recordedOn-error")}
            className={inputClass}
          />
          <FieldError
            id={id("recordedOn-error")}
            errors={state.fieldErrors?.recordedOn}
          />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={id("recordedByMemberId")} className={labelClass}>
            Recorded by {optionalMark}
          </label>
          <select
            id={id("recordedByMemberId")}
            name="recordedByMemberId"
            defaultValue=""
            className={inputClass}
          >
            <option value="">Not recorded</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={id("notes")} className={labelClass}>
            Notes {optionalMark}
          </label>
          <input
            id={id("notes")}
            name="notes"
            type="text"
            maxLength={500}
            className={inputClass}
          />
        </div>
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
