/**
 * CSV serialization for organization data exports (issue #19).
 *
 * Contract — see docs/reporting.md for the full format specification:
 *
 * - UTF-8 with a BOM. The BOM is deliberate: Excel and LibreOffice use
 *   it to detect UTF-8, and SARbase values are routinely non-ASCII
 *   (names, locations). Parsers that don't expect it see one extra
 *   empty header character at worst.
 * - One header row, then one row per record. Column order is the
 *   declared column order — never object insertion order — so every
 *   export of a dataset is byte-stable in structure.
 * - RFC 4180 quoting: a cell containing `"`, `,`, CR, or LF is wrapped
 *   in double quotes and embedded quotes are doubled. Line endings are
 *   CRLF inside the file.
 * - No locale-dependent formatting: instants are ISO 8601 UTC,
 *   date-only values are YYYY-MM-DD, numbers use "." decimals with no
 *   thousands grouping, NULL is an empty cell.
 * - Formula-injection mitigation applies ONLY to `text` cells —
 *   human-entered free text. A text cell whose first character is one
 *   of `=`, `+`, `-`, `@` or a tab/CR/LF gets a leading `'`, so
 *   spreadsheet applications treat it as a literal. Ids, enum values,
 *   numbers, dates, and instants are machine-generated and emitted
 *   verbatim — prefixing them would corrupt join keys and arithmetic.
 */

export type CsvCellKind =
  | "id"
  | "enum"
  | "text"
  | "number"
  | "decimal"
  | "boolean"
  | "date"
  | "instant";

export interface CsvColumn {
  /** Row-object key — also the emitted header name unless `header` is set. */
  key: string;
  kind: CsvCellKind;
  header?: string;
}

export type CsvRow = Record<string, unknown>;

export interface CsvTable {
  columns: CsvColumn[];
  rows: CsvRow[];
}

export const CSV_UTF8_BOM = "\uFEFF";

// A cell is dangerous when a formula character appears first, or after
// only whitespace (some importers trim before evaluating), or when it
// leads with a tab/CR/LF at all — the documented smuggling vectors.
const FORMULA_PREFIX_RE = /^(\s*[=+\-@]|[\t\r\n])/;

/**
 * Neutralize a human-entered value that a spreadsheet would otherwise
 * evaluate as a formula. Applied only to `text` cells — machine values
 * (ids, enums, numbers, dates) cannot contain hostile input and must
 * not be altered.
 */
export function sanitizeSpreadsheetText(value: string): string {
  return FORMULA_PREFIX_RE.test(value) ? `'${value}` : value;
}

function quoteIfNeeded(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Render one typed cell to its serialized string (pre-quoting). */
function serializeCell(value: unknown, kind: CsvCellKind): string {
  if (value === null || value === undefined) return "";
  switch (kind) {
    case "text":
      return sanitizeSpreadsheetText(String(value));
    case "date": {
      if (!(value instanceof Date)) {
        throw new TypeError(`date cell expected Date, got ${typeof value}`);
      }
      return value.toISOString().slice(0, 10);
    }
    case "instant": {
      if (!(value instanceof Date)) {
        throw new TypeError(`instant cell expected Date, got ${typeof value}`);
      }
      return value.toISOString();
    }
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new TypeError(`number cell expected finite number`);
      }
      return String(value);
    case "decimal":
      // Prisma Decimal (toString is exact) or a plain string — emitted
      // verbatim, never routed through floating-point math.
      return typeof value === "string" ? value : String(value);
    case "boolean":
      return value === true ? "true" : "false";
    case "id":
    case "enum":
      return String(value);
  }
}

/**
 * Serialize a table to CSV text (with BOM). Rows supply values by
 * column key; keys absent from a row serialize as empty. Row order is
 * the caller's — datasets must ORDER BY a stable key for deterministic
 * output.
 */
export function toCsv(table: CsvTable): string {
  const { columns, rows } = table;
  const lines: string[] = [];
  lines.push(columns.map((c) => quoteIfNeeded(c.header ?? c.key)).join(","));
  for (const row of rows) {
    lines.push(
      columns
        .map((c) => quoteIfNeeded(serializeCell(row[c.key], c.kind)))
        .join(","),
    );
  }
  return CSV_UTF8_BOM + lines.join("\r\n") + "\r\n";
}
