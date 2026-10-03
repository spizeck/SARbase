import Link from "next/link";
import { notFound } from "next/navigation";

import { getOrganization } from "@/lib/domain/organization";
import { requireOrgAdminOrNotFound } from "@/lib/auth/authorize";
import { searchOrganizationRecords } from "@/lib/search/search";
import { SEARCH_MIN_QUERY_LENGTH } from "@/lib/search/query";
import {
  SEARCH_RESULT_TYPES,
  SEARCH_RESULT_TYPE_LABELS,
  type SearchResult,
  type SearchResultType,
} from "@/lib/search/types";

export const metadata = { title: "Search" };

export const dynamic = "force-dynamic";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Safe match highlighting: splits plain text on query tokens and wraps
 * matches in <mark>. Everything is a React text node — no
 * dangerouslySetInnerHTML, no stored markup.
 */
function Highlighted({ text, tokens }: { text: string; tokens: string[] }) {
  const live = tokens.filter((t) => t.length > 0);
  if (live.length === 0 || text.length === 0) return <>{text}</>;
  const pattern = new RegExp(`(${live.map(escapeRegExp).join("|")})`, "gi");
  const parts = text.split(pattern);
  return (
    <>
      {parts.map((part, i) =>
        // With a capturing split, odd indices are the matched segments.
        i % 2 === 1 ? (
          <mark key={i} className="bg-amber-100 text-inherit">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}

function ResultRow({
  result,
  tokens,
}: {
  result: SearchResult;
  tokens: string[];
}) {
  return (
    <li className="px-4 py-3 text-sm">
      <Link
        href={result.href}
        className="font-medium text-neutral-900 hover:underline"
      >
        <Highlighted text={result.title} tokens={tokens} />
      </Link>
      {result.subtitle && (
        <p className="mt-0.5 text-xs text-neutral-500">
          <Highlighted text={result.subtitle} tokens={tokens} />
        </p>
      )}
      {result.snippet && (
        <p className="mt-1 text-xs text-neutral-600">
          <Highlighted text={result.snippet} tokens={tokens} />
        </p>
      )}
    </li>
  );
}

/**
 * Organization-wide record search (issue #18). Server-rendered against
 * the caller's own OrganizationAccess grants — the result set contains
 * only records this admin may already view, and non-admins never reach
 * this page (same gate as every other admin surface).
 */
export default async function SearchPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ q?: string; type?: string }>;
}) {
  const { orgId } = await params;
  const { q, type } = await searchParams;
  // orgId is an untrusted selector — the grant is checked against the
  // caller's OrganizationAccess rows, same as every admin page.
  const ctx = await requireOrgAdminOrNotFound(orgId);
  const organization = await getOrganization(orgId);
  if (!organization) notFound();

  const hasQuery = typeof q === "string" && q.trim().length > 0;
  const outcome = hasQuery
    ? await searchOrganizationRecords(ctx, orgId, q, { type })
    : null;
  const activeType: SearchResultType | undefined = SEARCH_RESULT_TYPES.includes(
    type as SearchResultType,
  )
    ? (type as SearchResultType)
    : undefined;

  const typeHref = (t: SearchResultType | undefined) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (t) params.set("type", t);
    const qs = params.toString();
    return `/admin/organizations/${orgId}/search${qs ? `?${qs}` : ""}`;
  };

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <nav aria-label="Breadcrumb" className="text-sm text-neutral-500">
        <Link href="/admin" className="hover:underline">
          Administration
        </Link>
        <span aria-hidden="true"> / </span>
        <Link
          href={`/admin/organizations/${orgId}`}
          className="hover:underline"
        >
          {organization.name}
        </Link>
        <span aria-hidden="true"> / </span>
        <span aria-current="page" className="text-neutral-800">
          Search
        </span>
      </nav>

      <h1 className="mt-6 text-2xl font-semibold tracking-tight">
        Search records
      </h1>
      <p className="mt-2 text-sm text-neutral-600">
        Find members, assets, training, incidents, documents, and other records
        for {organization.name}. You only ever see records your access already
        allows.
      </p>

      <form method="get" className="mt-4 flex gap-2" role="search">
        <label htmlFor="search-q" className="sr-only">
          Search query
        </label>
        <input
          id="search-q"
          name="q"
          type="search"
          defaultValue={q ?? ""}
          placeholder="Name, tag, reference, topic…"
          maxLength={100}
          autoComplete="off"
          className="min-w-0 flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm"
        />
        {activeType && <input type="hidden" name="type" value={activeType} />}
        <button
          type="submit"
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
        >
          Search
        </button>
      </form>

      {outcome?.accepted && (
        <nav
          aria-label="Filter by record type"
          className="mt-4 flex flex-wrap gap-2 text-sm"
        >
          <Link
            href={typeHref(undefined)}
            aria-current={!activeType ? "true" : undefined}
            className={`rounded-md border px-3 py-1 ${
              !activeType
                ? "border-neutral-900 font-medium text-neutral-900"
                : "border-neutral-300 text-neutral-600 hover:bg-neutral-50"
            }`}
          >
            All
          </Link>
          {SEARCH_RESULT_TYPES.map((t) => (
            <Link
              key={t}
              href={typeHref(t)}
              aria-current={activeType === t ? "true" : undefined}
              className={`rounded-md border px-3 py-1 ${
                activeType === t
                  ? "border-neutral-900 font-medium text-neutral-900"
                  : "border-neutral-300 text-neutral-600 hover:bg-neutral-50"
              }`}
            >
              {SEARCH_RESULT_TYPE_LABELS[t]}
            </Link>
          ))}
        </nav>
      )}

      <section aria-label="Search results" className="mt-8">
        {!hasQuery && (
          <p className="text-sm text-neutral-500">
            Enter a name, asset tag, serial number, location, reference, or
            topic — for example <span className="font-medium">3/8 line</span> or{" "}
            <span className="font-medium">flares</span>.
          </p>
        )}
        {hasQuery && outcome && !outcome.accepted && (
          <p className="text-sm text-neutral-500">
            Enter at least {SEARCH_MIN_QUERY_LENGTH} characters to search.
          </p>
        )}
        {outcome?.accepted && outcome.groups.length === 0 && (
          <p className="text-sm text-neutral-500">
            No records match your search.
          </p>
        )}
        {outcome?.accepted &&
          outcome.groups.map((group) => (
            <section
              key={group.type}
              aria-labelledby={`search-group-${group.type}`}
              className="mt-6 first:mt-0"
            >
              <h2
                id={`search-group-${group.type}`}
                className="text-sm font-medium text-neutral-500"
              >
                {group.label}
              </h2>
              <ul className="mt-1 divide-y divide-neutral-200 rounded-md border border-neutral-200">
                {group.results.map((result) => (
                  <ResultRow
                    key={`${result.type}:${result.id}`}
                    result={result}
                    tokens={outcome.tokens}
                  />
                ))}
              </ul>
              {group.hasMore && (
                <p className="mt-1 text-xs text-neutral-500">
                  More {group.label.toLowerCase()} match — refine the search or
                  filter this type.
                </p>
              )}
            </section>
          ))}
      </section>
    </main>
  );
}
