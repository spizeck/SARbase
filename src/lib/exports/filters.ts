/**
 * Export filter parsing and normalization (issue #19).
 *
 * Every filter arrives as a query parameter on the export URL. The
 * contract per dataset declares WHICH filters it supports; a parameter
 * that is not supported fails with 400 rather than silently widening
 * the export — an admin who asked for "approved expenses" must never
 * receive an unfiltered file because a filter name was mistyped.
 *
 * Value semantics:
 * - `from` / `to` are organization-local calendar dates (YYYY-MM-DD),
 *   inclusive. They are stored as UTC-midnight Dates so they compare
 *   cleanly against `@db.Date` columns; instant columns translate the
 *   same bounds into the organization's timezone (see datasets.ts).
 * - `unit` is a unit id of this organization, or the sentinel "org"
 *   selecting rows with no unit. An id that is not one of the org's
 *   units is left as-is — it matches nothing, so a forged id cannot
 *   widen the export (same convention as the admin pages).
 * - Expense extras: `status`, `reimbursementStatus`, `currency`,
 *   `vendor`, `category` (exact match). Enum/currency values must be
 *   valid or the request is rejected; ids follow match-nothing.
 */

import { ExpenseStatus, ReimbursementStatus } from "@prisma/client";

import { dateOnlySchema } from "@/lib/domain/schemas";
import { isSupportedCurrency } from "@/lib/money";

/** Validation failure for a filter parameter — the route maps to 400. */
export class ExportFilterError extends Error {}

export interface ExportFilters {
  /** Inclusive local-date lower bound (UTC-midnight Date). */
  from?: Date;
  /** Inclusive local-date upper bound (UTC-midnight Date). */
  to?: Date;
  /** Direct unit column value, or the ORG sentinel for `unitId IS NULL`. */
  unit?: string;
  /** Expense dataset extras. */
  vendor?: string;
  status?: ExpenseStatus;
  reimbursementStatus?: ReimbursementStatus;
  currency?: string;
  category?: string;
}

/** `unit` sentinel — rows with no unit assignment. */
export const ORG_WIDE_UNIT = "org";

/** Filter keys a dataset may declare support for. */
export type FilterKey =
  | "date"
  | "unit"
  | "vendor"
  | "status"
  | "reimbursementStatus"
  | "currency"
  | "category";

const PARAM_FOR: Record<FilterKey, string> = {
  date: "from", // "to" shares the declaration
  unit: "unit",
  vendor: "vendor",
  status: "status",
  reimbursementStatus: "reimbursementStatus",
  currency: "currency",
  category: "category",
};

function parseLocalDateParam(name: string, value: string): Date {
  const parsed = dateOnlySchema.safeParse(value);
  if (!parsed.success || !parsed.data) {
    throw new ExportFilterError(
      `Invalid ${name} — expected a YYYY-MM-DD calendar date.`,
    );
  }
  return parsed.data;
}

/**
 * Parse and validate the supported subset of query parameters into
 * normalized filters. `allowed` is the dataset's declared filter set.
 * Throws ExportFilterError for unsupported params or malformed values.
 */
export function parseExportFilters(
  params: URLSearchParams,
  allowed: ReadonlySet<FilterKey>,
): ExportFilters {
  // Reject any parameter the dataset does not declare — silently
  // dropping a filter would produce a wider export than requested.
  const allowedParams = new Set<string>();
  for (const key of allowed) {
    allowedParams.add(PARAM_FOR[key]);
    if (key === "date") allowedParams.add("to");
  }
  for (const key of params.keys()) {
    if (!allowedParams.has(key)) {
      throw new ExportFilterError(`Unsupported filter "${key}".`);
    }
  }

  const filters: ExportFilters = {};

  const from = params.get("from");
  const to = params.get("to");
  if (from) filters.from = parseLocalDateParam("from", from);
  if (to) filters.to = parseLocalDateParam("to", to);
  if (
    filters.from &&
    filters.to &&
    filters.to.getTime() < filters.from.getTime()
  ) {
    throw new ExportFilterError("`to` must not be earlier than `from`.");
  }

  const unit = params.get("unit");
  if (unit) {
    filters.unit = unit.trim();
    if (filters.unit.length === 0 || filters.unit.length > 64) {
      throw new ExportFilterError("Invalid unit filter.");
    }
  }

  const vendor = params.get("vendor");
  if (vendor) {
    filters.vendor = vendor.trim();
    if (filters.vendor.length === 0 || filters.vendor.length > 64) {
      throw new ExportFilterError("Invalid vendor filter.");
    }
  }

  const status = params.get("status");
  if (status) {
    if (!Object.values(ExpenseStatus).includes(status as ExpenseStatus)) {
      throw new ExportFilterError("Invalid expense status filter.");
    }
    filters.status = status as ExpenseStatus;
  }

  const reimbursement = params.get("reimbursementStatus");
  if (reimbursement) {
    if (
      !Object.values(ReimbursementStatus).includes(
        reimbursement as ReimbursementStatus,
      )
    ) {
      throw new ExportFilterError("Invalid reimbursement status filter.");
    }
    filters.reimbursementStatus = reimbursement as ReimbursementStatus;
  }

  const currency = params.get("currency");
  if (currency) {
    const code = currency.trim().toUpperCase();
    if (!isSupportedCurrency(code)) {
      throw new ExportFilterError("Invalid currency filter.");
    }
    filters.currency = code;
  }

  const category = params.get("category");
  if (category) {
    filters.category = category.trim();
    if (filters.category.length === 0 || filters.category.length > 100) {
      throw new ExportFilterError("Invalid category filter.");
    }
  }

  return filters;
}

/**
 * The filter subset safe to persist on DataExportEvent: structured,
 * bounded values only. Free-text input (category) is deliberately
 * excluded — audit needs the shape of the request, not its text.
 */
export function auditFilterMetadata(
  f: ExportFilters,
): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  if (f.from) out.from = f.from.toISOString().slice(0, 10);
  if (f.to) out.to = f.to.toISOString().slice(0, 10);
  if (f.unit) out.unit = f.unit;
  if (f.vendor) out.vendor = f.vendor;
  if (f.status) out.status = f.status;
  if (f.reimbursementStatus) out.reimbursementStatus = f.reimbursementStatus;
  if (f.currency) out.currency = f.currency;
  return Object.keys(out).length > 0 ? out : undefined;
}
