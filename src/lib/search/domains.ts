/**
 * Federated domain searchers and the search registry.
 *
 * Each entry answers "which records of MY domain match this query for
 * this organization" as one bounded Prisma query. Authorization is in
 * the WHERE clause itself (organizationId + the domain's own scoping) —
 * a record the caller cannot see is never selected, so it can never
 * appear in a result, a snippet, or a count.
 *
 * Every registry entry is `adminOnly` today because every record
 * surface in SARbase is ADMIN-only (see docs/search.md — the MEMBER
 * role exposes only the member's own account data). The flag is the
 * seam for future member-visible domains and for issue #17's
 * Vendor/Expense records, which register here without touching the
 * orchestration in ./search.ts.
 */

import type { Prisma } from "@prisma/client";

import { formatDateOnly } from "@/lib/dates";
import { prisma } from "@/lib/prisma";

import {
  buildSnippet,
  classifyMatch,
  type NormalizedQuery,
  type SearchMatchClass,
} from "./query";
import type { SearchResult, SearchResultType } from "./types";

const CI: Prisma.QueryMode = "insensitive";

/**
 * One text-field predicate: `equals` for the exact-match pass,
 * `contains` for token matching. The union return type stays
 * assignable to both StringFilter and StringNullableFilter.
 */
function text(
  value: string,
  exact: boolean,
):
  | { equals: string; mode: Prisma.QueryMode }
  | { contains: string; mode: Prisma.QueryMode } {
  return exact ? { equals: value, mode: CI } : { contains: value, mode: CI };
}

export interface DomainSearchInput {
  organizationId: string;
  query: NormalizedQuery;
  /** Rows fetched per domain before in-app classification. Bounded — a
   * broad query never scans more than this per domain. */
  scanLimit: number;
}

export interface DomainSearchHit {
  result: SearchResult;
  matchClass: SearchMatchClass;
}

export type DomainSearcher = (
  input: DomainSearchInput,
) => Promise<DomainSearchHit[]>;

export interface SearchDomain {
  type: SearchResultType;
  /** When true, only ADMIN access runs this domain. */
  adminOnly: boolean;
  search: DomainSearcher;
}

/**
 * Build the WHERE fragment "every token appears in at least one of
 * these fields". ANDs across tokens, ORs across fields — so "3/8 line"
 * matches "3/8 in line (600 ft)" and multi-word names match in any
 * order, while every token must still be present somewhere.
 */
function tokenizedWhere<W>(
  query: NormalizedQuery,
  fieldsFor: (token: string) => W[],
): { AND: { OR: W[] }[] } {
  return { AND: query.tokens.map((token) => ({ OR: fieldsFor(token) })) };
}

/**
 * The companion to tokenizedWhere: OR over the same fields with
 * `equals`. Exact matches are the highest-value results (incident
 * references, asset tags, serial numbers, names) — but the contains
 * scan is capped at scanLimit rows in a fixed order, so an exact hit
 * could be cut before classification ever sees it. A separate bounded
 * exact query guarantees those rows reach the ranker.
 */
function exactWhere<W>(
  query: NormalizedQuery,
  fieldsFor: (value: string, exact: boolean) => W[],
): { OR: W[] } {
  return { OR: fieldsFor(query.normalized, true) };
}

/**
 * Run the exact and contains passes in parallel and merge them with
 * exact rows first, deduplicated by id. Classification re-sorts by
 * match class anyway — this only guarantees exact hits survive the
 * scan limit.
 */
async function runDomain<Row extends { id: string }>(
  exact: () => Promise<Row[]>,
  contains: () => Promise<Row[]>,
): Promise<Row[]> {
  const [exactRows, rows] = await Promise.all([exact(), contains()]);
  const seen = new Set(exactRows.map((r) => r.id));
  return [...exactRows, ...rows.filter((r) => !seen.has(r.id))];
}

interface HitInput {
  type: SearchResultType;
  id: string;
  title: string;
  subtitle?: string;
  href: string;
  /** All field values the query may have matched — classification
   * picks the winner and the snippet source from these. */
  searchable: (string | null | undefined)[];
}

function toHit(
  input: HitInput,
  query: NormalizedQuery,
): DomainSearchHit | null {
  const match = classifyMatch(input.searchable, query);
  if (!match) return null;
  return {
    matchClass: match.matchClass,
    result: {
      type: input.type,
      id: input.id,
      title: input.title,
      subtitle: input.subtitle,
      href: input.href,
      // A snippet is only interesting when the match lives outside the
      // title — otherwise the title already shows it. Snippets carry a
      // display window only; nothing is stored.
      snippet:
        match.matchedValue !== input.title
          ? buildSnippet(match.matchedValue, query)
          : undefined,
    },
  };
}

function hits<T>(
  rows: T[],
  map: (row: T) => HitInput,
  query: NormalizedQuery,
): DomainSearchHit[] {
  const out: DomainSearchHit[] = [];
  for (const row of rows) {
    const hit = toHit(map(row), query);
    if (hit) out.push(hit);
  }
  return out;
}

function joinParts(parts: (string | null | undefined)[]): string | undefined {
  const joined = parts.filter(Boolean).join(" · ");
  return joined.length > 0 ? joined : undefined;
}

const searchMembers: DomainSearcher = async ({
  organizationId,
  query,
  scanLimit,
}) => {
  // Email is searchable for ADMIN only — the whole member domain is
  // admin-only, and the admin member page already displays it. Phone
  // is deliberately not searched and never returned.
  const fields = (v: string, exact: boolean): Prisma.MemberWhereInput[] => [
    { displayName: text(v, exact) },
    { email: text(v, exact) },
  ];
  const select = {
    id: true,
    displayName: true,
    email: true,
    status: true,
    memberUnits: { select: { unit: { select: { name: true } } } },
  } satisfies Prisma.MemberSelect;
  const rows = await runDomain(
    () =>
      prisma.member.findMany({
        where: { organizationId, ...exactWhere(query, fields) },
        take: scanLimit,
        select,
      }),
    () =>
      prisma.member.findMany({
        where: {
          organizationId,
          ...tokenizedWhere(query, (t) => fields(t, false)),
        },
        orderBy: { displayName: "asc" },
        take: scanLimit,
        select,
      }),
  );
  return hits(
    rows,
    (m) => ({
      type: "member",
      id: m.id,
      title: m.displayName,
      subtitle: joinParts([
        m.status === "INACTIVE" ? "Inactive" : null,
        ...m.memberUnits.map((mu) => mu.unit.name),
      ]),
      href: `/admin/members/${m.id}`,
      searchable: [m.displayName, m.email],
    }),
    query,
  );
};

const searchUnits: DomainSearcher = async ({
  organizationId,
  query,
  scanLimit,
}) => {
  const fields = (v: string, exact: boolean): Prisma.UnitWhereInput[] => [
    { name: text(v, exact) },
  ];
  const select = { id: true, name: true } satisfies Prisma.UnitSelect;
  const rows = await runDomain(
    () =>
      prisma.unit.findMany({
        where: { organizationId, ...exactWhere(query, fields) },
        take: scanLimit,
        select,
      }),
    () =>
      prisma.unit.findMany({
        where: {
          organizationId,
          ...tokenizedWhere(query, (t) => fields(t, false)),
        },
        orderBy: { name: "asc" },
        take: scanLimit,
        select,
      }),
  );
  return hits(
    rows,
    (u) => ({
      type: "unit",
      id: u.id,
      title: u.name,
      href: `/admin/organizations/${organizationId}`,
      searchable: [u.name],
    }),
    query,
  );
};

const searchQualifications: DomainSearcher = async ({
  organizationId,
  query,
  scanLimit,
}) => {
  const defFields = (
    v: string,
    exact: boolean,
  ): Prisma.QualificationDefinitionWhereInput[] => [
    { name: text(v, exact) },
    { description: text(v, exact) },
  ];
  const defSelect = {
    id: true,
    name: true,
    description: true,
    status: true,
  } satisfies Prisma.QualificationDefinitionSelect;
  const recFields = (
    v: string,
    exact: boolean,
  ): Prisma.MemberQualificationWhereInput[] => [
    { issuer: text(v, exact) },
    { reference: text(v, exact) },
    { notes: text(v, exact) },
    { member: { displayName: text(v, exact) } },
    { definition: { name: text(v, exact) } },
  ];
  const recSelect = {
    id: true,
    issuer: true,
    reference: true,
    notes: true,
    expiresOn: true,
    member: { select: { id: true, displayName: true } },
    definition: { select: { name: true } },
  } satisfies Prisma.MemberQualificationSelect;

  const [definitions, records] = await Promise.all([
    runDomain(
      () =>
        prisma.qualificationDefinition.findMany({
          where: { organizationId, ...exactWhere(query, defFields) },
          take: scanLimit,
          select: defSelect,
        }),
      () =>
        prisma.qualificationDefinition.findMany({
          where: {
            organizationId,
            ...tokenizedWhere(query, (t) => defFields(t, false)),
          },
          orderBy: { name: "asc" },
          take: scanLimit,
          select: defSelect,
        }),
    ),
    runDomain(
      () =>
        prisma.memberQualification.findMany({
          where: { organizationId, ...exactWhere(query, recFields) },
          take: scanLimit,
          select: recSelect,
        }),
      () =>
        prisma.memberQualification.findMany({
          where: {
            organizationId,
            ...tokenizedWhere(query, (t) => recFields(t, false)),
          },
          orderBy: { issuedOn: "desc" },
          take: scanLimit,
          select: recSelect,
        }),
    ),
  ]);

  return [
    ...hits(
      definitions,
      (d) => ({
        type: "qualification",
        id: d.id,
        title: d.name,
        subtitle:
          d.status === "INACTIVE"
            ? "Inactive qualification definition"
            : "Qualification definition",
        href: `/admin/organizations/${organizationId}`,
        searchable: [d.name, d.description],
      }),
      query,
    ),
    ...hits(
      records,
      (r) => ({
        type: "qualification",
        id: r.id,
        title: `${r.definition.name} — ${r.member.displayName}`,
        subtitle: joinParts([
          r.issuer ? `Issued by ${r.issuer}` : null,
          r.expiresOn ? `expires ${formatDateOnly(r.expiresOn)}` : null,
        ]),
        href: `/admin/members/${r.member.id}`,
        searchable: [
          r.issuer,
          r.reference,
          r.notes,
          r.member.displayName,
          r.definition.name,
        ],
      }),
      query,
    ),
  ];
};

const searchTraining: DomainSearcher = async ({
  organizationId,
  query,
  scanLimit,
}) => {
  const fields = (
    v: string,
    exact: boolean,
  ): Prisma.TrainingEventWhereInput[] => [
    { title: text(v, exact) },
    { location: text(v, exact) },
    { instructorName: text(v, exact) },
    { notes: text(v, exact) },
    { followUp: text(v, exact) },
    { unit: { name: text(v, exact) } },
    { leadMember: { displayName: text(v, exact) } },
    { topics: { some: { label: text(v, exact) } } },
  ];
  const select = {
    id: true,
    title: true,
    date: true,
    location: true,
    instructorName: true,
    notes: true,
    followUp: true,
    status: true,
    unit: { select: { name: true } },
    leadMember: { select: { displayName: true } },
    // Only topics containing a query token are needed for
    // classification and snippets — bounded, not the whole topic list.
    topics: {
      where: {
        OR: query.tokens.map((t) => ({
          label: { contains: t, mode: CI },
        })),
      },
      select: { label: true },
      take: 5,
    },
  } satisfies Prisma.TrainingEventSelect;
  const rows = await runDomain(
    () =>
      prisma.trainingEvent.findMany({
        where: { organizationId, ...exactWhere(query, fields) },
        take: scanLimit,
        select,
      }),
    () =>
      prisma.trainingEvent.findMany({
        where: {
          organizationId,
          ...tokenizedWhere(query, (t) => fields(t, false)),
        },
        orderBy: { date: "desc" },
        take: scanLimit,
        select,
      }),
  );
  return hits(
    rows,
    (e) => ({
      type: "training",
      id: e.id,
      title: e.title,
      subtitle: joinParts([
        formatDateOnly(e.date),
        e.status === "CANCELLED" ? "Cancelled" : null,
        e.location,
        e.unit?.name,
      ]),
      href: `/admin/training/${e.id}`,
      searchable: [
        e.title,
        e.location,
        e.instructorName,
        e.notes,
        e.followUp,
        e.unit?.name,
        e.leadMember?.displayName,
        ...e.topics.map((t) => t.label),
      ],
    }),
    query,
  );
};

const searchAssets: DomainSearcher = async ({
  organizationId,
  query,
  scanLimit,
}) => {
  const fields = (v: string, exact: boolean): Prisma.AssetWhereInput[] => [
    { name: text(v, exact) },
    { category: text(v, exact) },
    { manufacturer: text(v, exact) },
    { model: text(v, exact) },
    { serialNumber: text(v, exact) },
    { assetTag: text(v, exact) },
    { vendor: text(v, exact) },
    { notes: text(v, exact) },
  ];
  const select = {
    id: true,
    name: true,
    category: true,
    manufacturer: true,
    model: true,
    serialNumber: true,
    assetTag: true,
    vendor: true,
    notes: true,
    status: true,
    storageLocation: { select: { name: true } },
  } satisfies Prisma.AssetSelect;
  const rows = await runDomain(
    () =>
      prisma.asset.findMany({
        where: { organizationId, ...exactWhere(query, fields) },
        take: scanLimit,
        select,
      }),
    () =>
      prisma.asset.findMany({
        where: {
          organizationId,
          ...tokenizedWhere(query, (t) => fields(t, false)),
        },
        orderBy: { name: "asc" },
        take: scanLimit,
        select,
      }),
  );
  return hits(
    rows,
    (a) => ({
      type: "asset",
      id: a.id,
      title: a.name,
      subtitle: joinParts([
        a.assetTag ? `Tag ${a.assetTag}` : null,
        a.category,
        a.status !== "ACTIVE"
          ? a.status.toLowerCase().replace(/_/g, " ")
          : null,
        a.storageLocation ? `at ${a.storageLocation.name}` : null,
      ]),
      href: `/admin/assets/${a.id}`,
      searchable: [
        a.name,
        a.category,
        a.manufacturer,
        a.model,
        a.serialNumber,
        a.assetTag,
        a.vendor,
        a.notes,
      ],
    }),
    query,
  );
};

const searchInventory: DomainSearcher = async ({
  organizationId,
  query,
  scanLimit,
}) => {
  const fields = (
    v: string,
    exact: boolean,
  ): Prisma.InventoryItemWhereInput[] => [
    { name: text(v, exact) },
    { category: text(v, exact) },
    { vendor: text(v, exact) },
    { unitOfMeasure: text(v, exact) },
    { notes: text(v, exact) },
    { storageLocation: { name: text(v, exact) } },
  ];
  const select = {
    id: true,
    name: true,
    category: true,
    vendor: true,
    unitOfMeasure: true,
    notes: true,
    status: true,
    quantity: true,
    storageLocation: { select: { name: true } },
  } satisfies Prisma.InventoryItemSelect;
  const rows = await runDomain(
    () =>
      prisma.inventoryItem.findMany({
        where: { organizationId, ...exactWhere(query, fields) },
        take: scanLimit,
        select,
      }),
    () =>
      prisma.inventoryItem.findMany({
        where: {
          organizationId,
          ...tokenizedWhere(query, (t) => fields(t, false)),
        },
        orderBy: { name: "asc" },
        take: scanLimit,
        select,
      }),
  );
  return hits(
    rows,
    (i) => ({
      type: "inventory",
      id: i.id,
      title: i.name,
      subtitle: joinParts([
        `${i.quantity}${i.unitOfMeasure ? ` ${i.unitOfMeasure}` : ""}`,
        i.category,
        i.status === "ARCHIVED" ? "archived" : null,
        i.storageLocation ? `at ${i.storageLocation.name}` : null,
      ]),
      href: `/admin/organizations/${organizationId}/inventory`,
      searchable: [
        i.name,
        i.category,
        i.vendor,
        i.unitOfMeasure,
        i.notes,
        i.storageLocation?.name,
      ],
    }),
    query,
  );
};

const searchLocations: DomainSearcher = async ({
  organizationId,
  query,
  scanLimit,
}) => {
  const fields = (
    v: string,
    exact: boolean,
  ): Prisma.StorageLocationWhereInput[] => [
    { name: text(v, exact) },
    { description: text(v, exact) },
    { parentLocation: { name: text(v, exact) } },
    { containingAsset: { name: text(v, exact) } },
  ];
  const select = {
    id: true,
    name: true,
    description: true,
    status: true,
    parentLocation: { select: { name: true } },
    containingAsset: { select: { name: true } },
  } satisfies Prisma.StorageLocationSelect;
  const rows = await runDomain(
    () =>
      prisma.storageLocation.findMany({
        where: { organizationId, ...exactWhere(query, fields) },
        take: scanLimit,
        select,
      }),
    () =>
      prisma.storageLocation.findMany({
        where: {
          organizationId,
          ...tokenizedWhere(query, (t) => fields(t, false)),
        },
        orderBy: { name: "asc" },
        take: scanLimit,
        select,
      }),
  );
  return hits(
    rows,
    (l) => ({
      type: "location",
      id: l.id,
      title: l.name,
      subtitle: joinParts([
        l.parentLocation ? `in ${l.parentLocation.name}` : null,
        l.containingAsset ? `on ${l.containingAsset.name}` : null,
        l.status === "ARCHIVED" ? "archived" : null,
      ]),
      href: `/admin/organizations/${organizationId}/locations`,
      searchable: [
        l.name,
        l.description,
        l.parentLocation?.name,
        l.containingAsset?.name,
      ],
    }),
    query,
  );
};

const searchInspections: DomainSearcher = async ({
  organizationId,
  query,
  scanLimit,
}) => {
  const defFields = (
    v: string,
    exact: boolean,
  ): Prisma.InspectionDefinitionWhereInput[] => [
    { name: text(v, exact) },
    { description: text(v, exact) },
  ];
  const defSelect = {
    id: true,
    name: true,
    description: true,
    status: true,
  } satisfies Prisma.InspectionDefinitionSelect;
  const recFields = (
    v: string,
    exact: boolean,
  ): Prisma.InspectionRecordWhereInput[] => [
    { inspectorName: text(v, exact) },
    { notes: text(v, exact) },
    { asset: { name: text(v, exact) } },
    { definition: { name: text(v, exact) } },
  ];
  const recSelect = {
    id: true,
    performedOn: true,
    inspectorName: true,
    notes: true,
    asset: { select: { name: true } },
    definition: { select: { name: true } },
  } satisfies Prisma.InspectionRecordSelect;

  const [definitions, records] = await Promise.all([
    runDomain(
      () =>
        prisma.inspectionDefinition.findMany({
          where: { organizationId, ...exactWhere(query, defFields) },
          take: scanLimit,
          select: defSelect,
        }),
      () =>
        prisma.inspectionDefinition.findMany({
          where: {
            organizationId,
            ...tokenizedWhere(query, (t) => defFields(t, false)),
          },
          orderBy: { name: "asc" },
          take: scanLimit,
          select: defSelect,
        }),
    ),
    runDomain(
      () =>
        prisma.inspectionRecord.findMany({
          where: { organizationId, ...exactWhere(query, recFields) },
          take: scanLimit,
          select: recSelect,
        }),
      () =>
        prisma.inspectionRecord.findMany({
          where: {
            organizationId,
            ...tokenizedWhere(query, (t) => recFields(t, false)),
          },
          orderBy: { performedOn: "desc" },
          take: scanLimit,
          select: recSelect,
        }),
    ),
  ]);
  const href = `/admin/organizations/${organizationId}/maintenance`;
  return [
    ...hits(
      definitions,
      (d) => ({
        type: "inspection",
        id: d.id,
        title: d.name,
        subtitle:
          d.status === "INACTIVE"
            ? "Inactive inspection definition"
            : "Inspection definition",
        href,
        searchable: [d.name, d.description],
      }),
      query,
    ),
    ...hits(
      records,
      (r) => ({
        type: "inspection",
        id: r.id,
        title: `${r.definition.name} — ${r.asset.name}`,
        subtitle: joinParts([formatDateOnly(r.performedOn), r.inspectorName]),
        href,
        searchable: [r.inspectorName, r.notes, r.asset.name, r.definition.name],
      }),
      query,
    ),
  ];
};

const searchMaintenance: DomainSearcher = async ({
  organizationId,
  query,
  scanLimit,
}) => {
  const planFields = (
    v: string,
    exact: boolean,
  ): Prisma.MaintenancePlanWhereInput[] => [
    { name: text(v, exact) },
    { description: text(v, exact) },
    { asset: { name: text(v, exact) } },
  ];
  const planSelect = {
    id: true,
    name: true,
    description: true,
    status: true,
    asset: { select: { name: true } },
  } satisfies Prisma.MaintenancePlanSelect;
  const recFields = (
    v: string,
    exact: boolean,
  ): Prisma.MaintenanceRecordWhereInput[] => [
    { title: text(v, exact) },
    { workPerformed: text(v, exact) },
    { providerName: text(v, exact) },
    { notes: text(v, exact) },
    { asset: { name: text(v, exact) } },
    { plan: { name: text(v, exact) } },
  ];
  const recSelect = {
    id: true,
    title: true,
    performedOn: true,
    workPerformed: true,
    providerName: true,
    notes: true,
    asset: { select: { name: true } },
    plan: { select: { name: true } },
  } satisfies Prisma.MaintenanceRecordSelect;

  const [plans, records] = await Promise.all([
    runDomain(
      () =>
        prisma.maintenancePlan.findMany({
          where: { organizationId, ...exactWhere(query, planFields) },
          take: scanLimit,
          select: planSelect,
        }),
      () =>
        prisma.maintenancePlan.findMany({
          where: {
            organizationId,
            ...tokenizedWhere(query, (t) => planFields(t, false)),
          },
          orderBy: { name: "asc" },
          take: scanLimit,
          select: planSelect,
        }),
    ),
    runDomain(
      () =>
        prisma.maintenanceRecord.findMany({
          where: { organizationId, ...exactWhere(query, recFields) },
          take: scanLimit,
          select: recSelect,
        }),
      () =>
        prisma.maintenanceRecord.findMany({
          where: {
            organizationId,
            ...tokenizedWhere(query, (t) => recFields(t, false)),
          },
          orderBy: { performedOn: "desc" },
          take: scanLimit,
          select: recSelect,
        }),
    ),
  ]);
  const href = `/admin/organizations/${organizationId}/maintenance`;
  return [
    ...hits(
      plans,
      (p) => ({
        type: "maintenance",
        id: p.id,
        title: `${p.name} — ${p.asset.name}`,
        subtitle:
          p.status === "INACTIVE"
            ? "Inactive maintenance plan"
            : "Maintenance plan",
        href,
        searchable: [p.name, p.description, p.asset.name],
      }),
      query,
    ),
    ...hits(
      records,
      (r) => ({
        type: "maintenance",
        id: r.id,
        title: r.title,
        subtitle: joinParts([
          formatDateOnly(r.performedOn),
          r.asset.name,
          r.providerName,
        ]),
        href,
        searchable: [
          r.title,
          r.workPerformed,
          r.providerName,
          r.notes,
          r.asset.name,
          r.plan?.name,
        ],
      }),
      query,
    ),
  ];
};

const searchDefects: DomainSearcher = async ({
  organizationId,
  query,
  scanLimit,
}) => {
  const fields = (v: string, exact: boolean): Prisma.DefectWhereInput[] => [
    { title: text(v, exact) },
    { description: text(v, exact) },
    { reporterName: text(v, exact) },
    { resolutionNotes: text(v, exact) },
    { asset: { name: text(v, exact) } },
    { reportedByMember: { displayName: text(v, exact) } },
  ];
  const select = {
    id: true,
    title: true,
    description: true,
    reporterName: true,
    resolutionNotes: true,
    status: true,
    reportedOn: true,
    asset: { select: { name: true } },
    reportedByMember: { select: { displayName: true } },
  } satisfies Prisma.DefectSelect;
  const rows = await runDomain(
    () =>
      prisma.defect.findMany({
        where: { organizationId, ...exactWhere(query, fields) },
        take: scanLimit,
        select,
      }),
    () =>
      prisma.defect.findMany({
        where: {
          organizationId,
          ...tokenizedWhere(query, (t) => fields(t, false)),
        },
        orderBy: { reportedOn: "desc" },
        take: scanLimit,
        select,
      }),
  );
  return hits(
    rows,
    (d) => ({
      type: "defect",
      id: d.id,
      title: d.title,
      subtitle: joinParts([
        d.status === "OPEN" ? "Open" : "Resolved",
        formatDateOnly(d.reportedOn),
        d.asset.name,
      ]),
      href: `/admin/organizations/${organizationId}/maintenance`,
      searchable: [
        d.title,
        d.description,
        d.reporterName,
        d.resolutionNotes,
        d.asset.name,
        d.reportedByMember?.displayName,
      ],
    }),
    query,
  );
};

const searchIncidents: DomainSearcher = async ({
  organizationId,
  query,
  scanLimit,
}) => {
  const fields = (v: string, exact: boolean): Prisma.IncidentWhereInput[] => [
    { reference: text(v, exact) },
    { title: text(v, exact) },
    { summary: text(v, exact) },
    { notes: { some: { body: text(v, exact) } } },
  ];
  const select = {
    id: true,
    reference: true,
    title: true,
    summary: true,
    status: true,
    createdAt: true,
    // Only note bodies containing a query token — candidate snippet
    // sources; classification still requires all tokens in one field.
    notes: {
      where: {
        OR: query.tokens.map((t) => ({
          body: { contains: t, mode: CI },
        })),
      },
      select: { body: true },
      take: 5,
    },
  } satisfies Prisma.IncidentSelect;
  const rows = await runDomain(
    () =>
      prisma.incident.findMany({
        where: { organizationId, ...exactWhere(query, fields) },
        take: scanLimit,
        select,
      }),
    () =>
      prisma.incident.findMany({
        where: {
          organizationId,
          ...tokenizedWhere(query, (t) => fields(t, false)),
        },
        orderBy: { createdAt: "desc" },
        take: scanLimit,
        select,
      }),
  );
  return hits(
    rows,
    (i) => ({
      type: "incident",
      id: i.id,
      title: `${i.reference} — ${i.title}`,
      subtitle: joinParts([
        i.status.charAt(0) + i.status.slice(1).toLowerCase(),
        formatDateOnly(i.createdAt),
      ]),
      href: `/admin/organizations/${organizationId}/incidents/${i.id}`,
      searchable: [
        i.reference,
        i.title,
        i.summary,
        ...i.notes.map((n) => n.body),
      ],
    }),
    query,
  );
};

const searchCallouts: DomainSearcher = async ({
  organizationId,
  query,
  scanLimit,
}) => {
  const fields = (v: string, exact: boolean): Prisma.CalloutWhereInput[] => [
    { title: text(v, exact) },
    { message: text(v, exact) },
    { unit: { name: text(v, exact) } },
  ];
  const select = {
    id: true,
    title: true,
    message: true,
    status: true,
    activatedAt: true,
    unit: { select: { name: true } },
  } satisfies Prisma.CalloutSelect;
  const rows = await runDomain(
    () =>
      prisma.callout.findMany({
        where: { organizationId, ...exactWhere(query, fields) },
        take: scanLimit,
        select,
      }),
    () =>
      prisma.callout.findMany({
        where: {
          organizationId,
          ...tokenizedWhere(query, (t) => fields(t, false)),
        },
        orderBy: { activatedAt: "desc" },
        take: scanLimit,
        select,
      }),
  );
  return hits(
    rows,
    (c) => ({
      type: "callout",
      id: c.id,
      title: c.title,
      subtitle: joinParts([
        c.status === "CLOSED" ? "Closed" : "Active",
        formatDateOnly(c.activatedAt),
        c.unit?.name,
      ]),
      href: `/admin/organizations/${organizationId}/callouts/${c.id}`,
      searchable: [c.title, c.message, c.unit?.name],
    }),
    query,
  );
};

const searchDocuments: DomainSearcher = async ({
  organizationId,
  query,
  scanLimit,
}) => {
  const fields = (
    v: string,
    exact: boolean,
  ): Prisma.OrganizationDocumentWhereInput[] => [
    { title: text(v, exact) },
    { category: text(v, exact) },
    { notes: text(v, exact) },
  ];
  const select = {
    id: true,
    title: true,
    category: true,
    notes: true,
    status: true,
  } satisfies Prisma.OrganizationDocumentSelect;
  const rows = await runDomain(
    () =>
      prisma.organizationDocument.findMany({
        where: { organizationId, ...exactWhere(query, fields) },
        take: scanLimit,
        select,
      }),
    () =>
      prisma.organizationDocument.findMany({
        where: {
          organizationId,
          ...tokenizedWhere(query, (t) => fields(t, false)),
        },
        orderBy: { title: "asc" },
        take: scanLimit,
        select,
      }),
  );
  return hits(
    rows,
    (d) => ({
      type: "document",
      id: d.id,
      title: d.title,
      subtitle: joinParts([
        d.category,
        d.status === "ARCHIVED" ? "archived" : null,
      ]),
      href: `/admin/organizations/${organizationId}/documents/${d.id}`,
      searchable: [d.title, d.category, d.notes],
    }),
    query,
  );
};

/**
 * Attachment metadata search — filename/description only, never file
 * bytes, storage keys, or provider details. Every hit resolves through
 * the link tables to the page that already exposes it to admins; an
 * unlinked attachment (shouldn't exist — uploads are created linked)
 * falls back to the organization page rather than a dead end.
 */
const searchAttachments: DomainSearcher = async ({
  organizationId,
  query,
  scanLimit,
}) => {
  const fields = (v: string, exact: boolean): Prisma.AttachmentWhereInput[] => [
    { displayFilename: text(v, exact) },
    { description: text(v, exact) },
  ];
  const select = {
    id: true,
    displayFilename: true,
    description: true,
  } satisfies Prisma.AttachmentSelect;
  const rows = await runDomain(
    () =>
      prisma.attachment.findMany({
        where: {
          organizationId,
          status: "ACTIVE",
          ...exactWhere(query, fields),
        },
        take: scanLimit,
        select,
      }),
    () =>
      prisma.attachment.findMany({
        where: {
          organizationId,
          status: "ACTIVE",
          ...tokenizedWhere(query, (t) => fields(t, false)),
        },
        orderBy: { displayFilename: "asc" },
        take: scanLimit,
        select,
      }),
  );
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const inIds = { in: ids };
  const [
    incidentLinks,
    noteLinks,
    qualificationLinks,
    trainingLinks,
    assetLinks,
    inspectionLinks,
    maintenanceLinks,
    defectLinks,
    documentVersions,
  ] = await Promise.all([
    prisma.incidentAttachment.findMany({
      where: { organizationId, attachmentId: inIds },
      select: { attachmentId: true, incidentId: true },
    }),
    prisma.incidentNoteAttachment.findMany({
      where: { organizationId, attachmentId: inIds },
      select: { attachmentId: true, incidentId: true },
    }),
    prisma.memberQualificationAttachment.findMany({
      where: { organizationId, attachmentId: inIds },
      select: {
        attachmentId: true,
        memberQualification: { select: { memberId: true } },
      },
    }),
    prisma.trainingEventAttachment.findMany({
      where: { organizationId, attachmentId: inIds },
      select: { attachmentId: true, trainingEventId: true },
    }),
    prisma.assetAttachment.findMany({
      where: { organizationId, attachmentId: inIds },
      select: { attachmentId: true, assetId: true },
    }),
    prisma.inspectionRecordAttachment.findMany({
      where: { organizationId, attachmentId: inIds },
      select: { attachmentId: true },
    }),
    prisma.maintenanceRecordAttachment.findMany({
      where: { organizationId, attachmentId: inIds },
      select: { attachmentId: true },
    }),
    prisma.defectAttachment.findMany({
      where: { organizationId, attachmentId: inIds },
      select: { attachmentId: true },
    }),
    prisma.organizationDocumentVersion.findMany({
      where: { organizationId, attachmentId: inIds },
      select: { attachmentId: true, documentId: true },
    }),
  ]);

  const org = `/admin/organizations/${organizationId}`;
  const parents = new Map<string, { href: string; label: string }>();
  const put = (attachmentId: string, href: string, label: string) => {
    if (!parents.has(attachmentId)) parents.set(attachmentId, { href, label });
  };
  for (const l of documentVersions) {
    put(l.attachmentId, `${org}/documents/${l.documentId}`, "Document version");
  }
  for (const l of incidentLinks) {
    put(l.attachmentId, `${org}/incidents/${l.incidentId}`, "Incident file");
  }
  for (const l of noteLinks) {
    put(
      l.attachmentId,
      `${org}/incidents/${l.incidentId}`,
      "Incident note file",
    );
  }
  for (const l of qualificationLinks) {
    put(
      l.attachmentId,
      `/admin/members/${l.memberQualification.memberId}`,
      "Qualification file",
    );
  }
  for (const l of trainingLinks) {
    put(
      l.attachmentId,
      `/admin/training/${l.trainingEventId}`,
      "Training file",
    );
  }
  for (const l of assetLinks) {
    put(l.attachmentId, `/admin/assets/${l.assetId}`, "Asset file");
  }
  const maintenanceHref = `${org}/maintenance`;
  for (const l of inspectionLinks) {
    put(l.attachmentId, maintenanceHref, "Inspection file");
  }
  for (const l of maintenanceLinks) {
    put(l.attachmentId, maintenanceHref, "Maintenance file");
  }
  for (const l of defectLinks) {
    put(l.attachmentId, maintenanceHref, "Defect file");
  }

  return hits(
    rows,
    (a) => {
      const parent = parents.get(a.id);
      return {
        type: "attachment",
        id: a.id,
        title: a.displayFilename,
        subtitle: parent?.label,
        href: parent?.href ?? org,
        searchable: [a.displayFilename, a.description],
      };
    },
    query,
  );
};

/**
 * The registry is display order AND the extension seam: new domains
 * (vendors, expenses after issue #17 merges) append a SearchDomain here
 * with their own isolated searcher — orchestration never changes.
 */
export const SEARCH_DOMAINS: SearchDomain[] = [
  { type: "member", adminOnly: true, search: searchMembers },
  { type: "unit", adminOnly: true, search: searchUnits },
  { type: "qualification", adminOnly: true, search: searchQualifications },
  { type: "training", adminOnly: true, search: searchTraining },
  { type: "asset", adminOnly: true, search: searchAssets },
  { type: "inventory", adminOnly: true, search: searchInventory },
  { type: "location", adminOnly: true, search: searchLocations },
  { type: "inspection", adminOnly: true, search: searchInspections },
  { type: "maintenance", adminOnly: true, search: searchMaintenance },
  { type: "defect", adminOnly: true, search: searchDefects },
  { type: "incident", adminOnly: true, search: searchIncidents },
  { type: "callout", adminOnly: true, search: searchCallouts },
  { type: "document", adminOnly: true, search: searchDocuments },
  { type: "attachment", adminOnly: true, search: searchAttachments },
];
