import { describe, expect, it } from "vitest";

import {
  CSV_UTF8_BOM,
  sanitizeSpreadsheetText,
  toCsv,
  type CsvTable,
} from "./csv";

function table(rows: CsvTable["rows"]): CsvTable {
  return {
    columns: [
      { key: "id", kind: "id" },
      { key: "name", kind: "text" },
      { key: "note", kind: "text" },
      { key: "amount", kind: "number" },
      { key: "when", kind: "instant" },
      { key: "on", kind: "date" },
    ],
    rows,
  };
}

function body(csv: string): string {
  return csv.slice(CSV_UTF8_BOM.length);
}

describe("toCsv", () => {
  it("emits a BOM, declared header order, and CRLF line endings", () => {
    const csv = toCsv(
      table([
        {
          id: "a1",
          name: "Nicky",
          note: null,
          amount: 42,
          when: new Date("2026-10-03T12:34:56.000Z"),
          on: new Date("2026-10-03T00:00:00.000Z"),
        },
      ]),
    );
    expect(csv.startsWith(CSV_UTF8_BOM)).toBe(true);
    expect(body(csv)).toBe(
      "id,name,note,amount,when,on\r\n" +
        "a1,Nicky,,42,2026-10-03T12:34:56.000Z,2026-10-03\r\n",
    );
  });

  it("quotes commas, quotes, and newlines and escapes embedded quotes", () => {
    const csv = toCsv(
      table([
        {
          id: "a1",
          name: 'Say "hi", then\ngo',
          note: "x",
          amount: 1,
          when: new Date("2026-01-01T00:00:00.000Z"),
          on: new Date("2026-01-01T00:00:00.000Z"),
        },
      ]),
    );
    expect(body(csv)).toContain('"Say ""hi"", then\ngo"');
  });

  it("preserves unicode verbatim", () => {
    const csv = toCsv(
      table([
        {
          id: "a1",
          name: "Søren ñoño 🚤",
          note: "café",
          amount: 1,
          when: new Date("2026-01-01T00:00:00.000Z"),
          on: new Date("2026-01-01T00:00:00.000Z"),
        },
      ]),
    );
    expect(csv).toContain("Søren ñoño 🚤");
  });

  it("serializes null and undefined as empty cells", () => {
    const csv = toCsv(
      table([
        {
          id: "a1",
          name: null,
          note: undefined,
          amount: 0,
          when: new Date("2026-01-01T00:00:00.000Z"),
          on: new Date("2026-01-01T00:00:00.000Z"),
        },
      ]),
    );
    const line = body(csv).split("\r\n")[1];
    expect(line).toBe("a1,,,0,2026-01-01T00:00:00.000Z,2026-01-01");
  });

  it("keeps column order even when row keys differ", () => {
    const csv = toCsv({
      columns: [
        { key: "b", kind: "id" },
        { key: "a", kind: "id" },
      ],
      rows: [{ a: "1", b: "2" }],
    });
    expect(body(csv)).toBe("b,a\r\n2,1\r\n");
  });
});

describe("sanitizeSpreadsheetText", () => {
  it.each([
    ["=1+1", "'=1+1"],
    ["+SUM(A1:A2)", "'+SUM(A1:A2)"],
    ["-10+20", "'-10+20"],
    ["@evil", "'@evil"],
    ["\t=cmd", "'\t=cmd"],
    [" =1+1", "' =1+1"],
    ["\n=HYPERLINK()", "'\n=HYPERLINK()"],
  ])("neutralizes %j → %j", (input, expected) => {
    expect(sanitizeSpreadsheetText(input)).toBe(expected);
  });

  it.each([["plain text"], ["Fuel, filters"], ["(paren)"], [".hidden"]])(
    "leaves safe value %j unchanged",
    (input) => {
      expect(sanitizeSpreadsheetText(input)).toBe(input);
    },
  );

  it("applies mitigation only to text cells, never numbers or ids", () => {
    const csv = toCsv({
      columns: [
        { key: "id", kind: "id" },
        { key: "n", kind: "number" },
        { key: "t", kind: "text" },
      ],
      rows: [{ id: "-id", n: -5, t: "=1+1" }],
    });
    expect(body(csv).split("\r\n")[1]).toBe("-id,-5,'=1+1");
  });
});
