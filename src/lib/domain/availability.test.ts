import { describe, expect, it } from "vitest";
import type { MemberAvailabilityUpdate } from "@prisma/client";

import {
  AVAILABILITY_STATUS_LABELS,
  computeAvailability,
} from "./availability";
import {
  availabilityStatusSchema,
  availabilityUpdateSchema,
  contactPreferenceSchema,
} from "./schemas";

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

function updateRow(
  overrides: Partial<MemberAvailabilityUpdate> = {},
): MemberAvailabilityUpdate {
  return {
    id: "upd-1",
    organizationId: "org-1",
    memberId: "member-1",
    status: "AVAILABLE",
    until: null,
    note: null,
    selfReported: true,
    actorAuthIdentityId: "identity-1",
    createdAt: new Date("2026-09-30T12:00:00.000Z"),
    ...overrides,
  };
}

describe("AVAILABILITY_STATUS_LABELS", () => {
  it("has a label for every status", () => {
    for (const status of availabilityStatusSchema.options) {
      expect(AVAILABILITY_STATUS_LABELS[status]).toBeTruthy();
    }
  });
});

describe("computeAvailability", () => {
  const today = day("2026-10-01");

  it("is UNKNOWN with no recorded statement", () => {
    const result = computeAvailability(null, today);
    expect(result.status).toBe("UNKNOWN");
    expect(result.latest).toBeNull();
    expect(result.expired).toBe(false);
  });

  it("returns the latest statement's status while in effect", () => {
    const result = computeAvailability(
      updateRow({ status: "OFF_ISLAND", until: day("2026-10-12") }),
      today,
    );
    expect(result.status).toBe("OFF_ISLAND");
    expect(result.expired).toBe(false);
  });

  it("treats `until` as inclusive — still in effect on the end date", () => {
    const result = computeAvailability(
      updateRow({ status: "OFF_ISLAND", until: day("2026-10-01") }),
      today,
    );
    expect(result.status).toBe("OFF_ISLAND");
    expect(result.expired).toBe(false);
  });

  it("falls back to UNKNOWN the day after `until` — never AVAILABLE", () => {
    const result = computeAvailability(
      updateRow({ status: "OFF_ISLAND", until: day("2026-09-30") }),
      today,
    );
    expect(result.status).toBe("UNKNOWN");
    expect(result.expired).toBe(true);
    // The expired statement remains visible as provenance.
    expect(result.latest?.status).toBe("OFF_ISLAND");
  });

  it("expires an AVAILABLE statement the same way — elapsed time is not a statement", () => {
    const result = computeAvailability(
      updateRow({ status: "AVAILABLE", until: day("2026-09-30") }),
      today,
    );
    expect(result.status).toBe("UNKNOWN");
    expect(result.expired).toBe(true);
  });

  it("a statement without `until` stays in effect", () => {
    const result = computeAvailability(
      updateRow({ status: "UNAVAILABLE", until: null }),
      day("2027-06-01"),
    );
    expect(result.status).toBe("UNAVAILABLE");
    expect(result.expired).toBe(false);
  });
});

describe("availabilityUpdateSchema", () => {
  it("accepts a status with an optional until date and note", () => {
    const parsed = availabilityUpdateSchema.parse({
      status: "OFF_ISLAND",
      until: "2026-10-12",
      note: "Family trip",
    });
    expect(parsed.until?.toISOString()).toBe("2026-10-12T00:00:00.000Z");
    expect(parsed.note).toBe("Family trip");
  });

  it("accepts a bare status", () => {
    const parsed = availabilityUpdateSchema.parse({ status: "AVAILABLE" });
    expect(parsed.until).toBeUndefined();
    expect(parsed.note).toBeUndefined();
  });

  it("rejects an unknown status value", () => {
    expect(
      availabilityUpdateSchema.safeParse({ status: "READY_TO_LAUNCH" }).success,
    ).toBe(false);
  });

  it("rejects malformed and impossible until dates", () => {
    for (const until of ["12 Oct", "2026-13-01", "2026-02-30"]) {
      expect(
        availabilityUpdateSchema.safeParse({ status: "AVAILABLE", until })
          .success,
      ).toBe(false);
    }
  });
});

describe("contactPreferenceSchema", () => {
  it("treats absent checkboxes as false and 'on' as true", () => {
    const parsed = contactPreferenceSchema.parse({
      notifyEmail: "on",
      notifyPush: "on",
    });
    expect(parsed).toEqual({
      notifyEmail: true,
      notifySms: false,
      notifyWhatsapp: false,
      notifyPush: true,
    });
  });

  it("all-off is a valid preference state", () => {
    expect(contactPreferenceSchema.parse({})).toEqual({
      notifyEmail: false,
      notifySms: false,
      notifyWhatsapp: false,
      notifyPush: false,
    });
  });
});
