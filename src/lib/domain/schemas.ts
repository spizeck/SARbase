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
