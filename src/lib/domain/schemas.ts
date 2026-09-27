import { z } from "zod";

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
  typeof value === "string" && value.trim() === "" ? undefined : value;

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

export const organizationInputSchema = z.object({
  name: nameSchema,
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
