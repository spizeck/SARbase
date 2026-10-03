/**
 * Global organization search — public result contract.
 *
 * Search is federated: one bounded query per domain, merged and ranked
 * in application code (see docs/search.md). There is no denormalized
 * search table and no external search service — authorization stays in
 * each domain query's WHERE clause, so a record the caller cannot see
 * is never read, counted, or snippetted.
 *
 * Result types are user-facing labels, not table names. Adding a domain
 * means adding a registry entry in ./domains.ts plus a type/label here —
 * no contract change elsewhere.
 */

export const SEARCH_RESULT_TYPES = [
  "member",
  "unit",
  "qualification",
  "training",
  "asset",
  "inventory",
  "location",
  "inspection",
  "maintenance",
  "defect",
  "incident",
  "callout",
  "vendor",
  "expense",
  "document",
  "attachment",
] as const;

export type SearchResultType = (typeof SEARCH_RESULT_TYPES)[number];

export const SEARCH_RESULT_TYPE_LABELS: Record<SearchResultType, string> = {
  member: "Members",
  unit: "Units",
  qualification: "Qualifications",
  training: "Training",
  asset: "Assets",
  inventory: "Inventory",
  location: "Storage locations",
  inspection: "Inspections",
  maintenance: "Maintenance",
  defect: "Defects",
  incident: "Incidents",
  callout: "Callouts",
  vendor: "Vendors",
  expense: "Expenses",
  document: "Documents",
  attachment: "Attachments",
};

/** One matched record, shaped for display. Never leaks fields the
 * caller is not authorized to view — domain searchers build these only
 * from rows their scoped WHERE returned. */
export interface SearchResult {
  type: SearchResultType;
  id: string;
  title: string;
  /** Small factual context (status, dates, parent name). */
  subtitle?: string;
  /** Short window of the matched text when it is not the title. */
  snippet?: string;
  /** Existing page this result navigates to. */
  href: string;
}

export interface SearchResultGroup {
  type: SearchResultType;
  label: string;
  results: SearchResult[];
  /** More matches exist beyond the per-group display limit. */
  hasMore: boolean;
}

export interface OrganizationSearchOutcome {
  /** Raw query as submitted (echoed back into the input). */
  query: string;
  normalizedQuery: string;
  /** Tokens used for matching — powers safe client-side highlighting. */
  tokens: string[];
  /** False when the query was too short to run. */
  accepted: boolean;
  groups: SearchResultGroup[];
  totalCount: number;
}
