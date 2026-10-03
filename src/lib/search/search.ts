/**
 * Global organization search — service boundary.
 *
 * `searchOrganizationRecords` is the only entry point. It normalizes
 * the query, resolves which registry domains the caller's role may run,
 * executes them in parallel, and merges deterministic results. A record
 * the caller cannot access is never selected by a domain query — so it
 * cannot leak through a result, a snippet, a count, or a suggestion.
 *
 * Privacy: the raw query text is NEVER logged (queries routinely carry
 * names, casualty details, vendor information). Telemetry is structural
 * only: organization, actor, query-length bucket, counts, duration.
 */

import { isOrgAdmin, hasOrgAccess } from "@/lib/auth/authorize";
import type { AuthContext } from "@/lib/auth/context";
import { log, summarizeError } from "@/lib/logging";

import { SEARCH_DOMAINS, type DomainSearchHit } from "./domains";
import { MATCH_CLASS_RANK, normalizeSearchQuery } from "./query";
import {
  SEARCH_RESULT_TYPES,
  SEARCH_RESULT_TYPE_LABELS,
  type OrganizationSearchOutcome,
  type SearchResultGroup,
  type SearchResultType,
} from "./types";

/** Results shown per group. A broad match beyond this is reported as
 * "has more" rather than paginated — refinements beat pages for the
 * data volumes SARbase serves (see docs/search.md). */
export const SEARCH_GROUP_LIMIT = 8;
/** Rows scanned per domain before classification — the abuse bound. */
export const SEARCH_SCAN_LIMIT = 50;

export interface SearchOptions {
  /** Restrict to one result type (validated against the registry). */
  type?: string;
}

function emptyOutcome(
  raw: string,
  normalized: string,
  tokens: string[],
  accepted: boolean,
): OrganizationSearchOutcome {
  return {
    query: raw,
    normalizedQuery: normalized,
    tokens,
    accepted,
    groups: [],
    totalCount: 0,
  };
}

function queryLengthBucket(length: number): string {
  if (length <= 10) return "short";
  if (length <= 40) return "medium";
  return "long";
}

export async function searchOrganizationRecords(
  ctx: AuthContext,
  organizationId: string,
  rawQuery: string | null | undefined,
  options: SearchOptions = {},
): Promise<OrganizationSearchOutcome> {
  const raw = rawQuery ?? "";
  const query = normalizeSearchQuery(raw);
  if (!query.valid) {
    return emptyOutcome(raw, query.normalized, query.tokens, false);
  }

  // Role gate at the data boundary: every registered domain is
  // adminOnly today, so a non-admin gets an honestly empty outcome —
  // the same shape as "no matches", never an existence signal.
  const admin = isOrgAdmin(ctx, organizationId);
  const typeFilter = SEARCH_RESULT_TYPES.includes(
    options.type as SearchResultType,
  )
    ? (options.type as SearchResultType)
    : undefined;
  const domains = SEARCH_DOMAINS.filter(
    (d) => (admin || !d.adminOnly) && (!typeFilter || d.type === typeFilter),
  );
  if (!hasOrgAccess(ctx, organizationId) || domains.length === 0) {
    return emptyOutcome(raw, query.normalized, query.tokens, true);
  }

  const startedAt = performance.now();
  const settled = await Promise.all(
    domains.map(async (domain) => {
      try {
        return await domain.search({
          organizationId,
          query,
          scanLimit: SEARCH_SCAN_LIMIT,
        });
      } catch (error) {
        // One degraded domain must not blank the whole result page —
        // log the safe error summary and contribute zero hits.
        log({
          event: "search.domain_failed",
          level: "error",
          outcome: "operational_failure",
          subsystem: "search",
          entityType: domain.type,
          organizationId,
          actorId: ctx.identity.id,
          ...summarizeError(error),
        });
        return [] as DomainSearchHit[];
      }
    }),
  );

  const groups: SearchResultGroup[] = [];
  let totalCount = 0;
  for (const [i, domain] of domains.entries()) {
    const hits = (settled[i] ?? []).sort(
      (a, b) =>
        MATCH_CLASS_RANK[a.matchClass] - MATCH_CLASS_RANK[b.matchClass] ||
        a.result.title
          .toLowerCase()
          .localeCompare(b.result.title.toLowerCase()) ||
        a.result.id.localeCompare(b.result.id),
    );
    if (hits.length === 0) continue;
    groups.push({
      type: domain.type,
      label: SEARCH_RESULT_TYPE_LABELS[domain.type],
      results: hits.slice(0, SEARCH_GROUP_LIMIT).map((h) => h.result),
      hasMore: hits.length > SEARCH_GROUP_LIMIT,
    });
    totalCount += hits.length;
  }

  // Structural telemetry only — the query text itself is never logged.
  log({
    event: "search.executed",
    subsystem: "search",
    organizationId,
    actorId: ctx.identity.id,
    queryLength: queryLengthBucket(query.normalized.length),
    resultCount: totalCount,
    durationMs: Math.round(performance.now() - startedAt),
  });

  return {
    query: raw,
    normalizedQuery: query.normalized,
    tokens: query.tokens,
    accepted: true,
    groups,
    totalCount,
  };
}
