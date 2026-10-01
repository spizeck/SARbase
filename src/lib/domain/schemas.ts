import { z } from "zod";

import { isValidTimeZone } from "@/lib/dates";

/**
 * Input validation for the organization/unit/member admin surface.
 *
 * Deliberate choices:
 * - One `displayName` field — names are not split into parts; a single
 *   human-readable name is what the domain needs.
 * - `email`/`phone` are optional contact points. Email is normalized
 *   (trim + lowercase) but NOT unique — the same address may appear on
 *   multiple member records (shared contact, separate organizations).
 *   Sign-in identity uniqueness is a concern of the auth layer, not
 *   this record.
 * - Phone accepts a permissive international character set only — no
 *   country-aware validation is invented.
 * - Empty strings from form fields normalize to undefined/null.
 */

const emptyToUndefined = (value: unknown) =>
  value == null || (typeof value === "string" && value.trim() === "")
    ? undefined
    : value;

export const nameSchema = z
  .string()
  .trim()
  .min(1, "Name is required.")
  .max(120);

export const displayNameSchema = z
  .string()
  .trim()
  .min(1, "Name is required.")
  .max(120);

export const emailSchema = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .trim()
    .toLowerCase()
    .max(254)
    .pipe(z.email("Enter a valid email address."))
    .optional(),
);

export const phoneSchema = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .trim()
    .regex(/^\+?[0-9][0-9\s().-]{4,31}$/, "Enter a valid phone number.")
    // Normalize for storage: digits plus an optional leading "+" —
    // E.164-shaped when the caller supplies a country code, a plain
    // national number otherwise. No country is invented; whatever
    // prefix the organization recorded is preserved.
    .transform((value) => value.replace(/[\s().-]/g, ""))
    .optional(),
);

/**
 * IANA timezone identifier, validated against the runtime's Intl data —
 * no date library needed. Blank/absent input defaults to "UTC".
 */
export const timeZoneSchema = z.preprocess(
  (value) =>
    value == null || (typeof value === "string" && value.trim() === "")
      ? "UTC"
      : value,
  z
    .string()
    .trim()
    .refine(
      isValidTimeZone,
      "Enter a valid IANA timezone (e.g. America/Puerto_Rico).",
    ),
);

export const organizationInputSchema = z.object({
  name: nameSchema,
  timezone: timeZoneSchema,
});
export type OrganizationInput = z.infer<typeof organizationInputSchema>;

export const unitInputSchema = z.object({
  name: nameSchema,
});
export type UnitInput = z.infer<typeof unitInputSchema>;

export const memberInputSchema = z.object({
  displayName: displayNameSchema,
  email: emailSchema,
  phone: phoneSchema,
});
export type MemberInput = z.infer<typeof memberInputSchema>;

export const memberStatusSchema = z.enum(["ACTIVE", "INACTIVE"]);
export type MemberStatusInput = z.infer<typeof memberStatusSchema>;

export const memberUnitsSchema = z.object({
  unitIds: z.array(z.string().min(1)).max(200),
});
export type MemberUnitsInput = z.infer<typeof memberUnitsSchema>;

/**
 * Calendar-date input ("YYYY-MM-DD") → a Date pinned to UTC midnight.
 * Qualification issue/expiry are calendar dates, not instants — pinning
 * to UTC keeps "expired on Nov 14" identical in every server timezone.
 */
export const dateOnlySchema = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.")
    .refine((value) => {
      // JS normalizes impossible dates (2027-02-30 → Mar 2) instead of
      // producing NaN — reject them by comparing the round-trip.
      const d = new Date(`${value}T00:00:00.000Z`);
      return (
        !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value
      );
    }, "Enter a real calendar date.")
    .transform((value) => new Date(`${value}T00:00:00.000Z`))
    .optional(),
);

const optionalText = (max: number) =>
  z.preprocess(emptyToUndefined, z.string().trim().max(max).optional());

export const qualificationDefinitionInputSchema = z.object({
  name: nameSchema,
  description: optionalText(500),
});
export type QualificationDefinitionInput = z.infer<
  typeof qualificationDefinitionInputSchema
>;

export const qualificationDefinitionStatusSchema = z.enum([
  "ACTIVE",
  "INACTIVE",
]);
export type QualificationDefinitionStatusInput = z.infer<
  typeof qualificationDefinitionStatusSchema
>;

export const memberQualificationInputSchema = z
  .object({
    definitionId: z.string().min(1, "Choose a qualification."),
    issuedOn: dateOnlySchema,
    expiresOn: dateOnlySchema,
    issuer: optionalText(120),
    reference: optionalText(120),
    notes: optionalText(2000),
  })
  .refine(
    (value) =>
      !value.issuedOn || !value.expiresOn || value.expiresOn >= value.issuedOn,
    {
      message: "Expiry cannot be earlier than the issue date.",
      path: ["expiresOn"],
    },
  );
export type MemberQualificationInput = z.infer<
  typeof memberQualificationInputSchema
>;

/**
 * Required calendar-date input ("YYYY-MM-DD") → a Date pinned to UTC
 * midnight. Same rule as dateOnlySchema, but a value is mandatory —
 * used for training event dates, which are the org's local calendar
 * date, not an instant.
 */
export const requiredDateOnlySchema = z
  .string({ error: "Date is required." })
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.")
  .refine((value) => {
    const d = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
  }, "Enter a real calendar date.")
  .transform((value) => new Date(`${value}T00:00:00.000Z`));

/** Optional entity id (blank form value → absent). */
const optionalId = z.preprocess(emptyToUndefined, z.string().min(1).optional());

export const trainingEventInputSchema = z.object({
  title: nameSchema,
  date: requiredDateOnlySchema,
  unitId: optionalId,
  durationMinutes: z.preprocess(
    emptyToUndefined,
    z.coerce
      .number()
      .int("Whole minutes only.")
      .min(1, "Duration must be at least 1 minute.")
      .max(24 * 60, "Duration cannot exceed 24 hours.")
      .optional(),
  ),
  location: optionalText(160),
  instructorName: optionalText(120),
  leadMemberId: optionalId,
  notes: optionalText(2000),
  followUp: optionalText(2000),
  topics: z.array(z.string().trim().min(1).max(60)).max(24).default([]),
});
export type TrainingEventInput = z.infer<typeof trainingEventInputSchema>;

export const trainingEventStatusSchema = z.enum(["COMPLETED", "CANCELLED"]);
export type TrainingEventStatusInput = z.infer<
  typeof trainingEventStatusSchema
>;

export const trainingAttendanceSchema = z.object({
  memberIds: z.array(z.string().min(1)).max(500),
});
export type TrainingAttendanceInput = z.infer<typeof trainingAttendanceSchema>;

/* ------------------------------------------------------------------ */
/* Assets, inventory, storage locations (issue #10)                    */
/* ------------------------------------------------------------------ */

export const storageLocationStatusSchema = z.enum(["ACTIVE", "ARCHIVED"]);
export const assetStatusSchema = z.enum([
  "ACTIVE",
  "INACTIVE",
  "OUT_OF_SERVICE",
  "RETIRED",
]);
export const conditionStatusSchema = z.enum([
  "UNKNOWN",
  "GOOD",
  "FAIR",
  "DAMAGED",
]);
export const inventoryItemStatusSchema = z.enum(["ACTIVE", "ARCHIVED"]);

/**
 * A location's container: top-level, inside another location, or
 * inside an asset (a vessel's locker). The domain additionally rejects
 * supplying both parents — they are mutually exclusive by model.
 */
export const storageLocationInputSchema = z
  .object({
    name: nameSchema,
    description: optionalText(500),
    parentLocationId: optionalId,
    containingAssetId: optionalId,
    status: storageLocationStatusSchema.default("ACTIVE"),
  })
  .refine((v) => !(v.parentLocationId && v.containingAssetId), {
    message:
      "A location sits inside either a parent location or an asset — not both.",
    path: ["parentLocationId"],
  });
export type StorageLocationInput = z.infer<typeof storageLocationInputSchema>;

export const assetInputSchema = z.object({
  name: nameSchema,
  category: optionalText(60),
  manufacturer: optionalText(120),
  model: optionalText(120),
  serialNumber: optionalText(120),
  assetTag: optionalText(60),
  purchaseDate: dateOnlySchema,
  vendor: optionalText(120),
  unitId: optionalId,
  parentAssetId: optionalId,
  storageLocationId: optionalId,
  condition: conditionStatusSchema.default("UNKNOWN"),
  status: assetStatusSchema.default("ACTIVE"),
  notes: optionalText(2000),
});
export type AssetInput = z.infer<typeof assetInputSchema>;

/**
 * Exact quantity for stock items — a string like "3" or "2.5" that the
 * domain stores as DECIMAL(14,3). No floats, no negatives, no NaN.
 */
const quantitySchema = z.preprocess(
  emptyToUndefined,
  z
    .string({ error: "Quantity is required." })
    .trim()
    .regex(
      /^\d{1,9}(\.\d{1,3})?$/,
      "Enter a non-negative quantity (e.g. 3 or 2.5).",
    ),
);

export const inventoryItemInputSchema = z.object({
  name: nameSchema,
  category: optionalText(60),
  quantity: quantitySchema,
  unitOfMeasure: optionalText(30),
  vendor: optionalText(120),
  unitId: optionalId,
  storageLocationId: optionalId,
  condition: conditionStatusSchema.default("UNKNOWN"),
  status: inventoryItemStatusSchema.default("ACTIVE"),
  notes: optionalText(2000),
});
export type InventoryItemInput = z.infer<typeof inventoryItemInputSchema>;

/* ------------------------------------------------------------------ */
/* Inspections, maintenance, defects, meters (issue #11)               */
/*                                                                     */
/* Everything below describes factual administrative records: that an  */
/* inspection happened, that service was performed, that a defect was  */
/* reported, that a due date or meter threshold was recorded. No       */
/* verdict vocabulary exists here on purpose — nothing asserts an      */
/* asset is safe, ready, or deployable.                                */
/* ------------------------------------------------------------------ */

export const recurrenceTypeSchema = z.enum([
  "NONE",
  "CALENDAR_DAYS",
  "CALENDAR_MONTHS",
  "METER_INTERVAL",
]);

/** Positive interval value shared by calendar and meter recurrence. */
const intervalValueSchema = z.preprocess(
  emptyToUndefined,
  z.coerce
    .number()
    .int("Whole numbers only.")
    .positive("Interval must be at least 1.")
    .max(36500)
    .optional(),
);

/**
 * Exact meter values — DECIMAL(14,3), same representation as inventory
 * quantity. Non-negative only: odometers, hour meters, and cycle
 * counters never legitimately read below zero.
 */
const meterValueSchema = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .trim()
    .regex(
      /^\d{1,9}(\.\d{1,3})?$/,
      "Enter a non-negative reading (e.g. 812.4).",
    )
    .optional(),
);

/** Inspection definitions track calendar recurrence only. */
const inspectionRecurrenceSchema = z.enum([
  "NONE",
  "CALENDAR_DAYS",
  "CALENDAR_MONTHS",
]);

export const inspectionDefinitionInputSchema = z
  .object({
    name: nameSchema,
    description: optionalText(500),
    recurrenceType: inspectionRecurrenceSchema.default("NONE"),
    intervalValue: intervalValueSchema,
  })
  .check((ctx) => {
    const { recurrenceType, intervalValue } = ctx.value;
    if (recurrenceType === "NONE" && intervalValue != null) {
      ctx.issues.push({
        code: "custom",
        message: "An interval requires a recurrence type.",
        path: ["intervalValue"],
        input: ctx.value,
      });
    }
    if (recurrenceType !== "NONE" && intervalValue == null) {
      ctx.issues.push({
        code: "custom",
        message: "Enter how often this inspection recurs.",
        path: ["intervalValue"],
        input: ctx.value,
      });
    }
  });
export type InspectionDefinitionInput = z.infer<
  typeof inspectionDefinitionInputSchema
>;

export const inspectionDefinitionStatusSchema = z.enum(["ACTIVE", "INACTIVE"]);
export type InspectionDefinitionStatusInput = z.infer<
  typeof inspectionDefinitionStatusSchema
>;

/**
 * A factual inspection occurrence. No result verdict — the row itself
 * states the inspection happened; findings are notes, an optional
 * clerk-observed condition, and any defects a human reports separately.
 */
export const inspectionRecordInputSchema = z
  .object({
    definitionId: z.string().min(1, "Choose an inspection type."),
    performedOn: requiredDateOnlySchema,
    inspectorMemberId: optionalId,
    inspectorName: optionalText(120),
    conditionObserved: z.preprocess(
      emptyToUndefined,
      conditionStatusSchema.optional(),
    ),
    nextDueOn: dateOnlySchema,
    meterId: optionalId,
    meterReading: meterValueSchema,
    notes: optionalText(2000),
  })
  .check((ctx) => {
    const v = ctx.value;
    if ((v.meterId == null) !== (v.meterReading == null)) {
      ctx.issues.push({
        code: "custom",
        message: "A meter reading needs its meter, and vice versa.",
        path: ["meterReading"],
        input: v,
      });
    }
    if (v.nextDueOn && v.nextDueOn < v.performedOn) {
      ctx.issues.push({
        code: "custom",
        message: "Next due cannot be earlier than the inspection date.",
        path: ["nextDueOn"],
        input: v,
      });
    }
  });
export type InspectionRecordInput = z.infer<typeof inspectionRecordInputSchema>;

/** Corrections to a recorded inspection — everything but the target asset/definition/meter fact. */
export const inspectionRecordUpdateSchema = z
  .object({
    performedOn: requiredDateOnlySchema,
    inspectorMemberId: optionalId,
    inspectorName: optionalText(120),
    conditionObserved: z.preprocess(
      emptyToUndefined,
      conditionStatusSchema.optional(),
    ),
    nextDueOn: dateOnlySchema,
    notes: optionalText(2000),
    correctionNote: optionalText(500),
  })
  .refine((v) => !v.nextDueOn || v.nextDueOn >= v.performedOn, {
    message: "Next due cannot be earlier than the inspection date.",
    path: ["nextDueOn"],
  });
export type InspectionRecordUpdate = z.infer<
  typeof inspectionRecordUpdateSchema
>;

export const maintenancePlanInputSchema = z
  .object({
    name: nameSchema,
    description: optionalText(500),
    intervalType: recurrenceTypeSchema.default("NONE"),
    intervalValue: intervalValueSchema,
    meterId: optionalId,
    meterInterval: meterValueSchema,
  })
  .check((ctx) => {
    const v = ctx.value;
    const calendar =
      v.intervalType === "CALENDAR_DAYS" ||
      v.intervalType === "CALENDAR_MONTHS";
    if (calendar && v.intervalValue == null) {
      ctx.issues.push({
        code: "custom",
        message: "Enter the interval (days or months).",
        path: ["intervalValue"],
        input: v,
      });
    }
    if (calendar && (v.meterId != null || v.meterInterval != null)) {
      ctx.issues.push({
        code: "custom",
        message: "Meter fields apply only to meter-interval plans.",
        path: ["meterId"],
        input: v,
      });
    }
    if (v.intervalType === "METER_INTERVAL") {
      if (v.meterId == null) {
        ctx.issues.push({
          code: "custom",
          message: "Choose the meter this plan counts against.",
          path: ["meterId"],
          input: v,
        });
      }
      if (v.meterInterval == null) {
        ctx.issues.push({
          code: "custom",
          message: "Enter the meter interval (e.g. 100).",
          path: ["meterInterval"],
          input: v,
        });
      }
      if (v.intervalValue != null) {
        ctx.issues.push({
          code: "custom",
          message: "Calendar interval does not apply to meter plans.",
          path: ["intervalValue"],
          input: v,
        });
      }
    }
    if (v.intervalType === "NONE") {
      if (
        v.intervalValue != null ||
        v.meterId != null ||
        v.meterInterval != null
      ) {
        ctx.issues.push({
          code: "custom",
          message: "A non-recurring plan takes no interval.",
          path: ["intervalType"],
          input: v,
        });
      }
    }
  });
export type MaintenancePlanInput = z.infer<typeof maintenancePlanInputSchema>;

export const maintenancePlanStatusSchema = z.enum(["ACTIVE", "INACTIVE"]);
export type MaintenancePlanStatusInput = z.infer<
  typeof maintenancePlanStatusSchema
>;

export const maintenanceRecordInputSchema = z
  .object({
    planId: optionalId,
    title: nameSchema,
    performedOn: requiredDateOnlySchema,
    workPerformed: optionalText(2000),
    providerName: optionalText(120),
    performedByMemberId: optionalId,
    meterId: optionalId,
    meterReading: meterValueSchema,
    nextDueOn: dateOnlySchema,
    notes: optionalText(2000),
  })
  .check((ctx) => {
    const v = ctx.value;
    if ((v.meterId == null) !== (v.meterReading == null)) {
      ctx.issues.push({
        code: "custom",
        message: "A meter reading needs its meter, and vice versa.",
        path: ["meterReading"],
        input: v,
      });
    }
    if (v.nextDueOn && v.nextDueOn < v.performedOn) {
      ctx.issues.push({
        code: "custom",
        message: "Next due cannot be earlier than the service date.",
        path: ["nextDueOn"],
        input: v,
      });
    }
  });
export type MaintenanceRecordInput = z.infer<
  typeof maintenanceRecordInputSchema
>;

/** Corrections — asset/plan and the meter fact are immutable. */
export const maintenanceRecordUpdateSchema = z
  .object({
    title: nameSchema,
    performedOn: requiredDateOnlySchema,
    workPerformed: optionalText(2000),
    providerName: optionalText(120),
    performedByMemberId: optionalId,
    nextDueOn: dateOnlySchema,
    notes: optionalText(2000),
    correctionNote: optionalText(500),
  })
  .refine((v) => !v.nextDueOn || v.nextDueOn >= v.performedOn, {
    message: "Next due cannot be earlier than the service date.",
    path: ["nextDueOn"],
  });
export type MaintenanceRecordUpdate = z.infer<
  typeof maintenanceRecordUpdateSchema
>;

export const defectInputSchema = z.object({
  title: nameSchema,
  description: optionalText(2000),
  reportedOn: requiredDateOnlySchema,
  reportedByMemberId: optionalId,
  reporterName: optionalText(120),
});
export type DefectInput = z.infer<typeof defectInputSchema>;

export const defectStatusSchema = z.enum(["OPEN", "RESOLVED"]);
export type DefectStatusInput = z.infer<typeof defectStatusSchema>;

/** Status transition fields — resolvedOn required when resolving. */
export const defectTransitionSchema = z
  .object({
    status: defectStatusSchema,
    resolvedOn: dateOnlySchema,
    resolutionNotes: optionalText(2000),
    note: optionalText(1000),
  })
  .check((ctx) => {
    const v = ctx.value;
    if (v.status === "RESOLVED" && v.resolvedOn == null) {
      ctx.issues.push({
        code: "custom",
        message: "A resolved defect needs a resolution date.",
        path: ["resolvedOn"],
        input: v,
      });
    }
  });
export type DefectTransitionInput = z.infer<typeof defectTransitionSchema>;

export const assetMeterInputSchema = z.object({
  name: nameSchema,
  unit: z.string().trim().min(1, "Unit is required (e.g. hours, km).").max(30),
});
export type AssetMeterInput = z.infer<typeof assetMeterInputSchema>;

export const assetMeterStatusSchema = z.enum(["ACTIVE", "ARCHIVED"]);
export type AssetMeterStatusInput = z.infer<typeof assetMeterStatusSchema>;

const requiredMeterValueSchema = z
  .string({ error: "Reading is required." })
  .trim()
  .regex(/^\d{1,9}(\.\d{1,3})?$/, "Enter a non-negative reading (e.g. 812.4).");

export const meterReadingInputSchema = z.object({
  reading: requiredMeterValueSchema,
  recordedOn: requiredDateOnlySchema,
  recordedByMemberId: optionalId,
  notes: optionalText(500),
});
export type MeterReadingInput = z.infer<typeof meterReadingInputSchema>;

/* ------------------------------------------------------------------ */
/* Availability and contact preferences (issue #12)                    */
/*                                                                     */
/* Availability is a recorded statement, not a readiness judgment. The */
/* status set is deliberately small; `until` is the org's local        */
/* calendar date through which the statement applies (inclusive),      */
/* after which the computed status falls back to UNKNOWN — expiry      */
/* never invents AVAILABLE.                                            */
/* ------------------------------------------------------------------ */

export const availabilityStatusSchema = z.enum([
  "AVAILABLE",
  "UNAVAILABLE",
  "OFF_ISLAND",
  "UNKNOWN",
]);
export type AvailabilityStatusInput = z.infer<typeof availabilityStatusSchema>;

export const availabilityUpdateSchema = z.object({
  status: availabilityStatusSchema,
  // Optional local calendar date the statement applies through — the
  // org-timezone past-check lives in the domain (it needs the
  // organization's clock, which input validation does not have).
  until: dateOnlySchema,
  note: optionalText(200),
});
export type AvailabilityUpdateInput = z.infer<typeof availabilityUpdateSchema>;

/** Checkbox form value: absent/"on"/"true" → boolean. */
const checkboxSchema = z.preprocess(
  (value) => value === "on" || value === "true" || value === true,
  z.boolean(),
);

/**
 * Notification channel willingness — four explicit booleans rather than
 * a generic channel list, matching the model's fixed columns. Turning a
 * channel on requires the matching destination on the member record
 * (email → email; SMS/WhatsApp → phone); that rule lives in the domain
 * because the schema cannot see the member row. Push records
 * willingness only — no destination exists yet.
 */
export const contactPreferenceSchema = z.object({
  notifyEmail: checkboxSchema,
  notifySms: checkboxSchema,
  notifyWhatsapp: checkboxSchema,
  notifyPush: checkboxSchema,
});
export type ContactPreferenceInput = z.infer<typeof contactPreferenceSchema>;
