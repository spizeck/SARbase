import { describe, expect, it } from "vitest";

import {
  assetInputSchema,
  dateOnlySchema,
  defectTransitionSchema,
  inspectionDefinitionInputSchema,
  inspectionRecordInputSchema,
  inventoryItemInputSchema,
  maintenancePlanInputSchema,
  memberInputSchema,
  memberQualificationInputSchema,
  memberStatusSchema,
  meterReadingInputSchema,
  organizationInputSchema,
  qualificationDefinitionInputSchema,
  storageLocationInputSchema,
  trainingAttendanceSchema,
  trainingEventInputSchema,
} from "./schemas";

describe("organizationInputSchema", () => {
  it("trims and accepts a non-empty name", () => {
    const parsed = organizationInputSchema.parse({ name: "  Rescue Org  " });
    expect(parsed.name).toBe("Rescue Org");
  });

  it("rejects empty and whitespace-only names", () => {
    expect(organizationInputSchema.safeParse({ name: "" }).success).toBe(false);
    expect(organizationInputSchema.safeParse({ name: "   " }).success).toBe(
      false,
    );
  });
});

describe("memberInputSchema", () => {
  it("normalizes email to trimmed lowercase", () => {
    const parsed = memberInputSchema.parse({
      displayName: "Pat Example",
      email: "  Pat@Example.COM ",
      phone: undefined,
    });
    expect(parsed.email).toBe("pat@example.com");
  });

  it("treats blank email/phone as absent", () => {
    const parsed = memberInputSchema.parse({
      displayName: "Pat Example",
      email: "",
      phone: "  ",
    });
    expect(parsed.email).toBeUndefined();
    expect(parsed.phone).toBeUndefined();
  });

  it("accepts optional contact fields entirely omitted", () => {
    const parsed = memberInputSchema.parse({ displayName: "Pat Example" });
    expect(parsed.email).toBeUndefined();
    expect(parsed.phone).toBeUndefined();
  });

  it("rejects malformed email", () => {
    expect(
      memberInputSchema.safeParse({
        displayName: "Pat",
        email: "not-an-email",
      }).success,
    ).toBe(false);
  });

  it("rejects a blank display name", () => {
    expect(memberInputSchema.safeParse({ displayName: "   " }).success).toBe(
      false,
    );
  });
});

describe("memberStatusSchema", () => {
  it("accepts only ACTIVE/INACTIVE", () => {
    expect(memberStatusSchema.safeParse("ACTIVE").success).toBe(true);
    expect(memberStatusSchema.safeParse("INACTIVE").success).toBe(true);
    expect(memberStatusSchema.safeParse("SUSPENDED").success).toBe(false);
  });
});

describe("dateOnlySchema", () => {
  it("parses YYYY-MM-DD into a UTC-midnight Date", () => {
    const parsed = dateOnlySchema.parse("2027-11-14");
    expect(parsed).toBeInstanceOf(Date);
    expect(parsed!.toISOString()).toBe("2027-11-14T00:00:00.000Z");
  });

  it("treats blank input as absent", () => {
    expect(dateOnlySchema.parse("")).toBeUndefined();
    expect(dateOnlySchema.parse("   ")).toBeUndefined();
    expect(dateOnlySchema.parse(undefined)).toBeUndefined();
  });

  it("rejects malformed and impossible dates", () => {
    expect(dateOnlySchema.safeParse("11/14/2027").success).toBe(false);
    expect(dateOnlySchema.safeParse("2027-13-40").success).toBe(false);
    expect(dateOnlySchema.safeParse("2027-02-30").success).toBe(false);
  });
});

describe("qualificationDefinitionInputSchema", () => {
  it("accepts a trimmed name with optional description", () => {
    const parsed = qualificationDefinitionInputSchema.parse({
      name: "  First aid  ",
      description: "",
    });
    expect(parsed.name).toBe("First aid");
    expect(parsed.description).toBeUndefined();
  });

  it("rejects a blank name", () => {
    expect(
      qualificationDefinitionInputSchema.safeParse({ name: "  " }).success,
    ).toBe(false);
  });
});

describe("memberQualificationInputSchema", () => {
  const base = { definitionId: "def-1" };

  it("accepts a record with no dates at all", () => {
    const parsed = memberQualificationInputSchema.parse(base);
    expect(parsed.issuedOn).toBeUndefined();
    expect(parsed.expiresOn).toBeUndefined();
  });

  it("accepts expiry without issue date", () => {
    const parsed = memberQualificationInputSchema.parse({
      ...base,
      expiresOn: "2029-05-01",
    });
    expect(parsed.expiresOn!.toISOString()).toBe("2029-05-01T00:00:00.000Z");
  });

  it("rejects expiry earlier than the issue date", () => {
    const result = memberQualificationInputSchema.safeParse({
      ...base,
      issuedOn: "2027-06-01",
      expiresOn: "2027-05-31",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["expiresOn"]);
    }
  });

  it("accepts expiry equal to the issue date", () => {
    expect(
      memberQualificationInputSchema.safeParse({
        ...base,
        issuedOn: "2027-06-01",
        expiresOn: "2027-06-01",
      }).success,
    ).toBe(true);
  });

  it("requires a definition id", () => {
    expect(
      memberQualificationInputSchema.safeParse({ definitionId: "" }).success,
    ).toBe(false);
  });
});

describe("organizationInputSchema timezone", () => {
  it("defaults blank/absent timezone to UTC", () => {
    expect(
      organizationInputSchema.parse({ name: "Org", timezone: "" }).timezone,
    ).toBe("UTC");
    expect(organizationInputSchema.parse({ name: "Org" }).timezone).toBe("UTC");
  });

  it("accepts a real IANA timezone", () => {
    expect(
      organizationInputSchema.parse({
        name: "Org",
        timezone: " America/Puerto_Rico ",
      }).timezone,
    ).toBe("America/Puerto_Rico");
  });

  it("rejects an unknown timezone identifier", () => {
    expect(
      organizationInputSchema.safeParse({
        name: "Org",
        timezone: "Not/AZone",
      }).success,
    ).toBe(false);
  });
});

describe("trainingEventInputSchema", () => {
  const base = { title: "Anchor drill", date: "2027-06-01" };

  it("accepts a minimal event and normalizes blanks", () => {
    const parsed = trainingEventInputSchema.parse({
      ...base,
      unitId: "",
      durationMinutes: "",
      location: "",
      topics: [],
    });
    expect(parsed.title).toBe("Anchor drill");
    expect(parsed.date!.toISOString()).toBe("2027-06-01T00:00:00.000Z");
    expect(parsed.unitId).toBeUndefined();
    expect(parsed.durationMinutes).toBeUndefined();
  });

  it("requires a real date", () => {
    expect(trainingEventInputSchema.safeParse({ title: "X" }).success).toBe(
      false,
    );
    expect(
      trainingEventInputSchema.safeParse({ ...base, date: "2027-02-30" })
        .success,
    ).toBe(false);
    expect(
      trainingEventInputSchema.safeParse({ ...base, date: "June 1" }).success,
    ).toBe(false);
  });

  it("bounds duration to 1–1440 whole minutes", () => {
    for (const bad of ["0", "-5", "1441", "1.5", "abc"]) {
      expect(
        trainingEventInputSchema.safeParse({
          ...base,
          durationMinutes: bad,
        }).success,
      ).toBe(false);
    }
    expect(
      trainingEventInputSchema.parse({ ...base, durationMinutes: "90" })
        .durationMinutes,
    ).toBe(90);
  });

  it("accepts topics as a bounded string array", () => {
    const parsed = trainingEventInputSchema.parse({
      ...base,
      topics: ["  anchor work ", "radio"],
    });
    expect(parsed.topics).toEqual(["anchor work", "radio"]);
  });
});

describe("trainingAttendanceSchema", () => {
  it("accepts a member id list", () => {
    expect(
      trainingAttendanceSchema.parse({ memberIds: ["m1", "m2"] }).memberIds,
    ).toEqual(["m1", "m2"]);
  });
});

describe("storageLocationInputSchema", () => {
  it("accepts a top-level location", () => {
    const parsed = storageLocationInputSchema.parse({ name: "  Dock shed " });
    expect(parsed.name).toBe("Dock shed");
    expect(parsed.parentLocationId).toBeUndefined();
    expect(parsed.containingAssetId).toBeUndefined();
    expect(parsed.status).toBe("ACTIVE");
  });

  it("rejects a location with both a parent location and an asset", () => {
    expect(
      storageLocationInputSchema.safeParse({
        name: "Locker",
        parentLocationId: "loc-1",
        containingAssetId: "asset-1",
      }).success,
    ).toBe(false);
  });
});

describe("assetInputSchema", () => {
  it("accepts a minimal asset and normalizes blanks", () => {
    const parsed = assetInputSchema.parse({
      name: "  Rescue Boat 1 ",
      serialNumber: "",
      purchaseDate: "",
    });
    expect(parsed.name).toBe("Rescue Boat 1");
    expect(parsed.serialNumber).toBeUndefined();
    expect(parsed.purchaseDate).toBeUndefined();
    expect(parsed.condition).toBe("UNKNOWN");
    expect(parsed.status).toBe("ACTIVE");
  });

  it("accepts a purchase date with existing date-only semantics", () => {
    const parsed = assetInputSchema.parse({
      name: "AED",
      purchaseDate: "2024-03-15",
    });
    expect(parsed.purchaseDate!.toISOString()).toBe("2024-03-15T00:00:00.000Z");
  });

  it("rejects an impossible purchase date and unknown enums", () => {
    expect(
      assetInputSchema.safeParse({ name: "X", purchaseDate: "2024-02-30" })
        .success,
    ).toBe(false);
    expect(
      assetInputSchema.safeParse({ name: "X", status: "BROKEN" }).success,
    ).toBe(false);
    expect(
      assetInputSchema.safeParse({ name: "X", condition: "MINT" }).success,
    ).toBe(false);
  });
});

describe("inventoryItemInputSchema", () => {
  const base = { name: "3/8 double-braid line" };

  it("accepts whole and fractional quantities", () => {
    for (const q of ["3", "2.5", "0", "0.125", "250"]) {
      expect(
        inventoryItemInputSchema.safeParse({ ...base, quantity: q }).success,
      ).toBe(true);
    }
  });

  it("rejects negatives, NaN, unsafe precision, and blanks", () => {
    for (const q of ["-1", "abc", "", "  ", "1.0001", "1e3", ".5", "2.5.1"]) {
      expect(
        inventoryItemInputSchema.safeParse({ ...base, quantity: q }).success,
      ).toBe(false);
    }
  });

  it("rejects quantities beyond the DECIMAL(14,3) range", () => {
    expect(
      inventoryItemInputSchema.safeParse({ ...base, quantity: "9999999999" })
        .success,
    ).toBe(false);
  });

  it("keeps quantity as an exact string for Decimal storage", () => {
    const parsed = inventoryItemInputSchema.parse({ ...base, quantity: "2.5" });
    expect(parsed.quantity).toBe("2.5");
    expect(parsed.status).toBe("ACTIVE");
    expect(parsed.condition).toBe("UNKNOWN");
  });
});

/* ------------------------------------------------------------------ */
/* Issue #11 schemas                                                   */
/* ------------------------------------------------------------------ */

describe("inspectionDefinitionInputSchema", () => {
  it("accepts a non-recurring definition", () => {
    const parsed = inspectionDefinitionInputSchema.parse({
      name: "Radio check",
      recurrenceType: "NONE",
    });
    expect(parsed.recurrenceType).toBe("NONE");
  });

  it("requires an interval when a recurrence is chosen", () => {
    expect(
      inspectionDefinitionInputSchema.safeParse({
        name: "Monthly check",
        recurrenceType: "CALENDAR_DAYS",
      }).success,
    ).toBe(false);
    expect(
      inspectionDefinitionInputSchema.safeParse({
        name: "Monthly check",
        recurrenceType: "CALENDAR_DAYS",
        intervalValue: "30",
      }).success,
    ).toBe(true);
  });

  it("rejects an interval on a non-recurring definition", () => {
    expect(
      inspectionDefinitionInputSchema.safeParse({
        name: "x",
        recurrenceType: "NONE",
        intervalValue: "30",
      }).success,
    ).toBe(false);
  });

  it("inspection definitions are calendar-only — no meter intervals", () => {
    expect(
      inspectionDefinitionInputSchema.safeParse({
        name: "x",
        recurrenceType: "METER_INTERVAL",
      }).success,
    ).toBe(false);
  });
});

describe("inspectionRecordInputSchema", () => {
  const base = {
    definitionId: "def-1",
    performedOn: "2026-09-15",
  };

  it("accepts a bare factual record", () => {
    const parsed = inspectionRecordInputSchema.parse(base);
    expect(parsed.performedOn).toEqual(new Date("2026-09-15T00:00:00.000Z"));
  });

  it("rejects a next-due earlier than the performed date", () => {
    expect(
      inspectionRecordInputSchema.safeParse({
        ...base,
        nextDueOn: "2026-09-01",
      }).success,
    ).toBe(false);
    expect(
      inspectionRecordInputSchema.safeParse({
        ...base,
        nextDueOn: "2026-09-15",
      }).success,
    ).toBe(true);
  });

  it("requires meter id and reading to arrive together", () => {
    expect(
      inspectionRecordInputSchema.safeParse({ ...base, meterId: "m1" }).success,
    ).toBe(false);
    expect(
      inspectionRecordInputSchema.safeParse({ ...base, meterReading: "10" })
        .success,
    ).toBe(false);
    expect(
      inspectionRecordInputSchema.safeParse({
        ...base,
        meterId: "m1",
        meterReading: "10.5",
      }).success,
    ).toBe(true);
  });

  it("rejects negative and malformed meter readings", () => {
    for (const reading of ["-1", "1.2345", "abc", "12,5"]) {
      expect(
        inspectionRecordInputSchema.safeParse({
          ...base,
          meterId: "m1",
          meterReading: reading,
        }).success,
      ).toBe(false);
    }
  });
});

describe("maintenancePlanInputSchema", () => {
  const base = { name: "Oil change" };

  it("accepts a meter-interval plan with meter + interval", () => {
    const parsed = maintenancePlanInputSchema.parse({
      ...base,
      intervalType: "METER_INTERVAL",
      meterId: "m1",
      meterInterval: "100",
    });
    expect(parsed.intervalType).toBe("METER_INTERVAL");
  });

  it("rejects a meter plan missing its meter or interval", () => {
    expect(
      maintenancePlanInputSchema.safeParse({
        ...base,
        intervalType: "METER_INTERVAL",
        meterInterval: "100",
      }).success,
    ).toBe(false);
    expect(
      maintenancePlanInputSchema.safeParse({
        ...base,
        intervalType: "METER_INTERVAL",
        meterId: "m1",
      }).success,
    ).toBe(false);
  });

  it("rejects calendar fields on meter plans and vice versa", () => {
    expect(
      maintenancePlanInputSchema.safeParse({
        ...base,
        intervalType: "METER_INTERVAL",
        meterId: "m1",
        meterInterval: "100",
        intervalValue: "30",
      }).success,
    ).toBe(false);
    expect(
      maintenancePlanInputSchema.safeParse({
        ...base,
        intervalType: "CALENDAR_DAYS",
        intervalValue: "30",
        meterId: "m1",
      }).success,
    ).toBe(false);
  });

  it("a NONE plan takes no interval at all", () => {
    expect(
      maintenancePlanInputSchema.safeParse({
        ...base,
        intervalType: "NONE",
        intervalValue: "30",
      }).success,
    ).toBe(false);
    expect(
      maintenancePlanInputSchema.safeParse({ ...base, intervalType: "NONE" })
        .success,
    ).toBe(true);
  });
});

describe("defectTransitionSchema", () => {
  it("requires a resolution date when resolving", () => {
    expect(
      defectTransitionSchema.safeParse({ status: "RESOLVED" }).success,
    ).toBe(false);
    expect(
      defectTransitionSchema.safeParse({
        status: "RESOLVED",
        resolvedOn: "2026-09-20",
      }).success,
    ).toBe(true);
  });

  it("a reopen needs no resolution fields", () => {
    expect(defectTransitionSchema.safeParse({ status: "OPEN" }).success).toBe(
      true,
    );
  });
});

describe("meterReadingInputSchema", () => {
  it("accepts exact decimals and rejects invalid shapes", () => {
    expect(
      meterReadingInputSchema.safeParse({
        reading: "812.435",
        recordedOn: "2026-09-15",
      }).success,
    ).toBe(true);
    for (const reading of ["-1", "1.2345", "", "NaN"]) {
      expect(
        meterReadingInputSchema.safeParse({
          reading,
          recordedOn: "2026-09-15",
        }).success,
      ).toBe(false);
    }
  });
});
