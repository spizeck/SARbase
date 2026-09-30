import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Database-backed tests for member availability and contact
 * preferences — run only via `npm run test:db` (TEST_DATABASE_URL).
 * Real rows, real composite-FK enforcement; fixture names are prefixed
 * `availtest-` for cleanup.
 */

import { prisma } from "@/lib/prisma";
import { calendarDateInZone } from "@/lib/dates";

import {
  AvailabilityInputError,
  ContactPreferenceDestinationError,
  computeAvailability,
  getMemberAvailability,
  getMemberContactPreference,
  listMemberAvailabilityHistory,
  listOrganizationAvailability,
  recordMemberAvailability,
  setMemberContactPreference,
} from "./availability";

const hasDb = Boolean(process.env.DATABASE_URL);
const PREFIX = "availtest-";

let counter = 0;
function uniq(suffix: string) {
  counter += 1;
  return `${PREFIX}${counter}-${suffix}`;
}

let orgWest: { id: string }; // America/Puerto_Rico — west of UTC
let orgEast: { id: string }; // Pacific/Auckland — east of UTC
let memberWest: { id: string };
let memberEast: { id: string };
let actor: { id: string };
let otherActor: { id: string };

describe.skipIf(!hasDb)("member availability", () => {
  beforeAll(async () => {
    orgWest = await prisma.organization.create({
      data: { name: uniq("org-west"), timezone: "America/Puerto_Rico" },
    });
    orgEast = await prisma.organization.create({
      data: { name: uniq("org-east"), timezone: "Pacific/Auckland" },
    });
    memberWest = await prisma.member.create({
      data: {
        organizationId: orgWest.id,
        displayName: uniq("member-west"),
        email: "west@example.test",
        phone: "+17875550199",
      },
    });
    memberEast = await prisma.member.create({
      data: { organizationId: orgEast.id, displayName: uniq("member-east") },
    });
    actor = await prisma.authIdentity.create({
      data: {
        provider: "test",
        providerUid: uniq("actor"),
        email: "actor@example.test",
      },
    });
    otherActor = await prisma.authIdentity.create({
      data: {
        provider: "test",
        providerUid: uniq("other-actor"),
        email: "other@example.test",
      },
    });
  });

  afterAll(async () => {
    await prisma.memberAvailabilityUpdate.deleteMany({
      where: { organization: { name: { startsWith: PREFIX } } },
    });
    await prisma.memberNotificationPreference.deleteMany({
      where: { organization: { name: { startsWith: PREFIX } } },
    });
    await prisma.member.deleteMany({
      where: { organization: { name: { startsWith: PREFIX } } },
    });
    await prisma.authIdentity.deleteMany({
      where: { providerUid: { startsWith: PREFIX } },
    });
    await prisma.organization.deleteMany({
      where: { name: { startsWith: PREFIX } },
    });
  });

  it("records a statement and reports it as current", async () => {
    await recordMemberAvailability(
      memberWest.id,
      { status: "AVAILABLE" },
      actor.id,
      { selfReported: true },
    );
    const current = await getMemberAvailability(memberWest.id);
    expect(current.status).toBe("AVAILABLE");
    expect(current.expired).toBe(false);
    expect(current.latest?.actorAuthIdentityId).toBe(actor.id);
    expect(current.latest?.selfReported).toBe(true);
  });

  it("is UNKNOWN for a member who never recorded a statement", async () => {
    const current = await getMemberAvailability(memberEast.id);
    expect(current.status).toBe("UNKNOWN");
    expect(current.latest).toBeNull();
  });

  it("keeps an until=today statement in effect through the org's local day", async () => {
    const orgToday = calendarDateInZone("America/Puerto_Rico");
    await recordMemberAvailability(
      memberWest.id,
      { status: "OFF_ISLAND", until: orgToday },
      actor.id,
      { selfReported: true },
    );
    const current = await getMemberAvailability(memberWest.id);
    expect(current.status).toBe("OFF_ISLAND");
    expect(current.expired).toBe(false);
  });

  it("expires to UNKNOWN once the local end date has passed", async () => {
    const orgToday = calendarDateInZone("America/Puerto_Rico");
    const yesterday = new Date(orgToday.getTime() - 24 * 60 * 60 * 1000);
    // Direct insert — the write path rejects already-past dates, but an
    // until date legitimately becomes past simply by time passing.
    await prisma.memberAvailabilityUpdate.create({
      data: {
        organizationId: orgWest.id,
        memberId: memberWest.id,
        status: "UNAVAILABLE",
        until: yesterday,
        actorAuthIdentityId: actor.id,
      },
    });
    const current = await getMemberAvailability(memberWest.id);
    expect(current.status).toBe("UNKNOWN");
    expect(current.expired).toBe(true);
    // The expired statement is preserved as history, not erased.
    expect(current.latest?.status).toBe("UNAVAILABLE");
  });

  it("the same stored `until` can be in effect west of UTC and expired east of it", async () => {
    const westToday = calendarDateInZone("America/Puerto_Rico");
    const eastToday = calendarDateInZone("Pacific/Auckland");
    const row = {
      status: "OFF_ISLAND" as const,
      until: westToday,
      actorAuthIdentityId: actor.id,
    };
    // Both orgs evaluate the same stored calendar date against their
    // own local today — Auckland may already be a day ahead.
    const westResult = computeAvailability(
      {
        ...row,
        id: "x",
        organizationId: orgWest.id,
        memberId: memberWest.id,
        note: null,
        selfReported: false,
        createdAt: new Date(),
      },
      westToday,
    );
    const eastResult = computeAvailability(
      {
        ...row,
        id: "x",
        organizationId: orgEast.id,
        memberId: memberEast.id,
        note: null,
        selfReported: false,
        createdAt: new Date(),
      },
      eastToday,
    );
    expect(westResult.status).toBe("OFF_ISLAND");
    expect(eastResult.status).toBe(
      eastToday > westToday ? "UNKNOWN" : "OFF_ISLAND",
    );
  });

  it("rejects an until date already past in the org's timezone", async () => {
    const orgToday = calendarDateInZone("America/Puerto_Rico");
    const yesterday = new Date(orgToday.getTime() - 24 * 60 * 60 * 1000);
    await expect(
      recordMemberAvailability(
        memberWest.id,
        { status: "OFF_ISLAND", until: yesterday },
        actor.id,
        { selfReported: true },
      ),
    ).rejects.toThrow(AvailabilityInputError);
  });

  it("preserves history — each statement is a separate immutable row with its actor", async () => {
    await recordMemberAvailability(
      memberWest.id,
      { status: "UNAVAILABLE", note: "Shift work" },
      otherActor.id,
      { selfReported: false },
    );
    const history = await listMemberAvailabilityHistory(memberWest.id);
    expect(history.length).toBeGreaterThanOrEqual(3);
    // Newest first, each row retains its own values + attribution.
    expect(history[0]!.status).toBe("UNAVAILABLE");
    expect(history[0]!.note).toBe("Shift work");
    expect(history[0]!.selfReported).toBe(false);
    expect(history[0]!.actorDisplayName).toBe("other@example.test");
    expect(history.some((u) => u.status === "OFF_ISLAND")).toBe(true);
    expect(history.some((u) => u.actorAuthIdentityId === actor.id)).toBe(true);
    expect(history.some((u) => u.actorAuthIdentityId === otherActor.id)).toBe(
      true,
    );
  });

  it("the database rejects a statement for a member of another organization", async () => {
    await expect(
      prisma.memberAvailabilityUpdate.create({
        data: {
          organizationId: orgEast.id, // mismatched with memberWest's org
          memberId: memberWest.id,
          status: "AVAILABLE",
          actorAuthIdentityId: actor.id,
        },
      }),
    ).rejects.toThrow();
  });

  it("a member with availability history cannot be hard-deleted (Restrict)", async () => {
    await expect(
      prisma.member.delete({ where: { id: memberWest.id } }),
    ).rejects.toThrow();
  });

  it("deleting the authoring identity preserves the statement (scalar actor ref)", async () => {
    // actorAuthIdentityId is a plain reference, not an FK — an identity
    // that authored availability history can still be deleted, and the
    // row keeps the raw id as a stable forensic reference.
    const ghost = await prisma.authIdentity.create({
      data: {
        provider: "test",
        providerUid: uniq("ghost"),
        email: "ghost@example.test",
      },
    });
    const row = await recordMemberAvailability(
      memberWest.id,
      { status: "AVAILABLE", note: "before departure" },
      ghost.id,
      { selfReported: false },
    );
    await prisma.authIdentity.delete({ where: { id: ghost.id } });

    const persisted = await prisma.memberAvailabilityUpdate.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(persisted.actorAuthIdentityId).toBe(ghost.id);
    // Display resolution degrades to the raw id once the identity is gone.
    const history = await listMemberAvailabilityHistory(memberWest.id);
    expect(history.find((u) => u.id === row.id)?.actorDisplayName).toBe(
      ghost.id,
    );
  });

  it("organization overview derives each member's current status", async () => {
    const orgToday = calendarDateInZone("America/Puerto_Rico");
    const yesterday = new Date(orgToday.getTime() - 24 * 60 * 60 * 1000);
    // Latest statement is expired → derived status is UNKNOWN.
    await prisma.memberAvailabilityUpdate.create({
      data: {
        organizationId: orgWest.id,
        memberId: memberWest.id,
        status: "OFF_ISLAND",
        until: yesterday,
        actorAuthIdentityId: actor.id,
      },
    });
    const map = await listOrganizationAvailability(orgWest.id, orgToday);
    expect(map.get(memberWest.id)?.status).toBe("UNKNOWN");
    expect(map.get(memberWest.id)?.expired).toBe(true);
    // A member with no statement is simply absent — UNKNOWN by default.
    expect(map.has("nonexistent")).toBe(false);
  });

  describe("contact preferences", () => {
    it("records channel willingness for a member", async () => {
      const pref = await setMemberContactPreference(memberWest.id, {
        notifyEmail: true,
        notifySms: true,
        notifyWhatsapp: false,
        notifyPush: true,
      });
      expect(pref.notifyEmail).toBe(true);
      expect(pref.notifySms).toBe(true);
      expect(pref.notifyPush).toBe(true);

      const stored = await getMemberContactPreference(memberWest.id);
      expect(stored?.notifyEmail).toBe(true);
    });

    it("updates in place — one row per member", async () => {
      await setMemberContactPreference(memberWest.id, {
        notifyEmail: false,
        notifySms: false,
        notifyWhatsapp: true,
        notifyPush: false,
      });
      const stored = await getMemberContactPreference(memberWest.id);
      expect(stored?.notifyWhatsapp).toBe(true);
      expect(stored?.notifyEmail).toBe(false);
      const count = await prisma.memberNotificationPreference.count({
        where: { memberId: memberWest.id },
      });
      expect(count).toBe(1);
    });

    it("refuses email notifications without an email destination", async () => {
      await expect(
        setMemberContactPreference(memberEast.id, {
          notifyEmail: true,
          notifySms: false,
          notifyWhatsapp: false,
          notifyPush: false,
        }),
      ).rejects.toThrow(ContactPreferenceDestinationError);
    });

    it("refuses SMS/WhatsApp without a phone destination, allows push", async () => {
      await expect(
        setMemberContactPreference(memberEast.id, {
          notifyEmail: false,
          notifySms: true,
          notifyWhatsapp: false,
          notifyPush: false,
        }),
      ).rejects.toThrow(ContactPreferenceDestinationError);

      // Push has no destination yet — willingness is recorded anyway.
      const pref = await setMemberContactPreference(memberEast.id, {
        notifyEmail: false,
        notifySms: false,
        notifyWhatsapp: false,
        notifyPush: true,
      });
      expect(pref.notifyPush).toBe(true);
    });

    it("the database rejects a preference row pointing across organizations", async () => {
      await expect(
        prisma.memberNotificationPreference.create({
          data: {
            organizationId: orgEast.id, // mismatched with memberWest's org
            memberId: memberWest.id,
          },
        }),
      ).rejects.toThrow();
    });
  });
});
