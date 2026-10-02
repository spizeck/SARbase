import Link from "next/link";
import { notFound } from "next/navigation";

import { prisma } from "@/lib/prisma";
import { requireOrgAdminOrNotFound } from "@/lib/auth/authorize";
import {
  getIncidentForAdmin,
  INCIDENT_STATUS_LABELS,
  INCIDENT_NOTE_KIND_LABELS,
} from "@/lib/domain/incidents";
import { formatInstantInZone, localDateTimeString } from "@/lib/dates";

import {
  transitionIncidentStatusAction,
  updateIncidentAction,
  linkIncidentCalloutAction,
  addIncidentMemberAction,
  removeIncidentMemberAction,
  addIncidentAssetAction,
  removeIncidentAssetAction,
  addIncidentNoteAction,
  correctIncidentNoteAction,
} from "../../../../actions";
import {
  IncidentFieldsForm,
  IncidentTransitionButton,
  LinkCalloutForm,
  AddIncidentMemberForm,
  AddIncidentAssetForm,
  RemoveParticipantButton,
  AddIncidentNoteForm,
  CorrectNoteForm,
} from "../../../../incident-forms";
import { AttachmentSection } from "../../../../attachment-section";

export const metadata = { title: "Incident" };

export const dynamic = "force-dynamic";

const statusBadgeClass: Record<string, string> = {
  DRAFT: "bg-amber-100 text-amber-800",
  OPEN: "bg-green-100 text-green-800",
  CLOSED: "bg-neutral-100 text-neutral-600",
};

const noteKindBadgeClass: Record<string, string> = {
  GENERAL: "bg-neutral-100 text-neutral-600",
  AFTER_ACTION: "bg-blue-100 text-blue-800",
  CLOSING: "bg-blue-100 text-blue-800",
};

export default async function IncidentDetailPage({
  params,
}: {
  params: Promise<{ orgId: string; incidentId: string }>;
}) {
  const { orgId, incidentId } = await params;
  // Both URL ids are untrusted selectors. The incident's own
  // organizationId decides which grant must exist; a record outside
  // this organization is indistinguishable from 404.
  const incident = await getIncidentForAdmin(incidentId);
  if (!incident || incident.organizationId !== orgId) {
    notFound();
  }
  await requireOrgAdminOrNotFound(incident.organizationId);

  const tz = incident.organization.timezone;
  const fmt = (d: Date | null | undefined) => formatInstantInZone(d, tz);
  const wall = (d: Date | null | undefined) => localDateTimeString(d, tz);

  // Pickers list the organization's own records; members/assets already
  // recorded on the incident are filtered out since adding them again
  // can only fail.
  const participantIds = new Set(incident.members.map((m) => m.memberId));
  const assetIds = new Set(incident.assets.map((a) => a.assetId));
  const [memberOptions, assetOptions, linkableCallouts] = await Promise.all([
    prisma.member.findMany({
      where: { organizationId: orgId, status: "ACTIVE" },
      orderBy: { displayName: "asc" },
      select: { id: true, displayName: true },
    }),
    prisma.asset.findMany({
      where: { organizationId: orgId, status: { not: "RETIRED" } },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    incident.callout
      ? Promise.resolve([])
      : prisma.callout.findMany({
          where: { organizationId: orgId, incident: null },
          orderBy: { activatedAt: "desc" },
          select: { id: true, title: true },
        }),
  ]);

  const fieldDefaults = {
    title: incident.title,
    summary: incident.summary,
    reportedAt: wall(incident.reportedAt),
    departedAt: wall(incident.departedAt),
    onSceneAt: wall(incident.onSceneAt),
    returnedAt: wall(incident.returnedAt),
  };

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <nav aria-label="Breadcrumb" className="text-sm text-neutral-500">
        <Link href="/admin" className="hover:underline">
          Administration
        </Link>
        <span aria-hidden="true"> / </span>
        <Link
          href={`/admin/organizations/${orgId}`}
          className="hover:underline"
        >
          {incident.organization.name}
        </Link>
        <span aria-hidden="true"> / </span>
        <Link
          href={`/admin/organizations/${orgId}/incidents`}
          className="hover:underline"
        >
          Incidents
        </Link>
        <span aria-hidden="true"> / </span>
        <span aria-current="page" className="text-neutral-800">
          {incident.reference}
        </span>
      </nav>

      <section aria-labelledby="incident-heading" className="mt-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="font-mono text-xs text-neutral-500">
              {incident.reference}
            </p>
            <h1
              id="incident-heading"
              className="text-2xl font-semibold tracking-tight"
            >
              {incident.title}
            </h1>
          </div>
          <div className="flex items-center gap-3">
            <span
              className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${statusBadgeClass[incident.status] ?? "bg-neutral-100 text-neutral-600"}`}
            >
              {INCIDENT_STATUS_LABELS[incident.status]}
            </span>
            {incident.status === "DRAFT" && (
              <IncidentTransitionButton
                action={transitionIncidentStatusAction.bind(
                  null,
                  incident.id,
                  "OPEN",
                )}
                label="Open incident"
              />
            )}
            {(incident.status === "DRAFT" || incident.status === "OPEN") && (
              <IncidentTransitionButton
                action={transitionIncidentStatusAction.bind(
                  null,
                  incident.id,
                  "CLOSED",
                )}
                label="Close incident"
              />
            )}
            {incident.status === "CLOSED" && (
              <IncidentTransitionButton
                action={transitionIncidentStatusAction.bind(
                  null,
                  incident.id,
                  "OPEN",
                )}
                label="Reopen record"
              />
            )}
          </div>
        </div>
        {incident.summary && (
          <p className="mt-3 whitespace-pre-line rounded-md border border-neutral-200 bg-neutral-50 p-3 text-sm text-neutral-800">
            {incident.summary}
          </p>
        )}
        <dl className="mt-4 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
          {incident.reportedAt && (
            <div>
              <dt className="text-xs text-neutral-500">Reported</dt>
              <dd className="text-neutral-800">{fmt(incident.reportedAt)}</dd>
            </div>
          )}
          {incident.departedAt && (
            <div>
              <dt className="text-xs text-neutral-500">Departed</dt>
              <dd className="text-neutral-800">{fmt(incident.departedAt)}</dd>
            </div>
          )}
          {incident.onSceneAt && (
            <div>
              <dt className="text-xs text-neutral-500">On scene</dt>
              <dd className="text-neutral-800">{fmt(incident.onSceneAt)}</dd>
            </div>
          )}
          {incident.returnedAt && (
            <div>
              <dt className="text-xs text-neutral-500">Returned</dt>
              <dd className="text-neutral-800">{fmt(incident.returnedAt)}</dd>
            </div>
          )}
          {incident.openedAt && (
            <div>
              <dt className="text-xs text-neutral-500">Opened</dt>
              <dd className="text-neutral-800">{fmt(incident.openedAt)}</dd>
            </div>
          )}
          {incident.closedAt && (
            <div>
              <dt className="text-xs text-neutral-500">Closed</dt>
              <dd className="text-neutral-800">
                {fmt(incident.closedAt)}
                {incident.closedByDisplay
                  ? ` · by ${incident.closedByDisplay}`
                  : ""}
              </dd>
            </div>
          )}
          <div>
            <dt className="text-xs text-neutral-500">Record created</dt>
            <dd className="text-neutral-800">
              {fmt(incident.createdAt)}
              {incident.createdByDisplay
                ? ` · by ${incident.createdByDisplay}`
                : ""}
            </dd>
          </div>
        </dl>
      </section>

      <section
        aria-labelledby="linked-callout-heading"
        className="mt-8 rounded-md border border-neutral-200 p-4"
      >
        <h2
          id="linked-callout-heading"
          className="text-sm font-medium text-neutral-800"
        >
          Linked callout
        </h2>
        {incident.callout ? (
          <p className="mt-2 text-sm text-neutral-700">
            <Link
              href={`/admin/organizations/${orgId}/callouts/${incident.callout.id}`}
              className="font-medium text-neutral-900 hover:underline"
            >
              {incident.callout.title}
            </Link>
            <span className="text-neutral-500">
              {" "}
              — activated {fmt(incident.callout.activatedAt)} ·{" "}
              {incident.callout.status === "ACTIVE" ? "active" : "closed"}. The
              callout&rsquo;s invitations and responses remain on the callout
              record; participation here is recorded separately.
            </span>
          </p>
        ) : linkableCallouts.length > 0 ? (
          <div className="mt-2">
            <LinkCalloutForm
              action={linkIncidentCalloutAction.bind(null, incident.id)}
              callouts={linkableCallouts}
            />
          </div>
        ) : (
          <p className="mt-2 text-sm text-neutral-500">
            No callout linked; no unlinked callouts available.
          </p>
        )}
      </section>

      <section aria-labelledby="participants-heading" className="mt-8">
        <h2 id="participants-heading" className="text-lg font-medium">
          Participating members
        </h2>
        <p className="mt-1 text-xs text-neutral-500">
          Explicit records of participation — never inferred from callout
          responses.
        </p>
        {incident.members.length > 0 ? (
          <ul className="mt-3 divide-y divide-neutral-200 rounded-md border border-neutral-200">
            {incident.members.map((p) => (
              <li
                key={p.id}
                className="flex items-center justify-between gap-3 px-4 py-2 text-sm"
              >
                <span>
                  <Link
                    href={`/admin/members/${p.member.id}`}
                    className="font-medium text-neutral-900 hover:underline"
                  >
                    {p.member.displayName}
                  </Link>
                  {p.roleNote && (
                    <span className="text-neutral-500"> — {p.roleNote}</span>
                  )}
                  <span className="block text-xs text-neutral-400">
                    recorded {fmt(p.recordedAt)}
                    {p.recordedByDisplay ? ` · by ${p.recordedByDisplay}` : ""}
                  </span>
                </span>
                <RemoveParticipantButton
                  action={removeIncidentMemberAction.bind(null, p.id)}
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-neutral-500">
            No participants recorded.
          </p>
        )}
        <div className="mt-3 rounded-md border border-neutral-200 p-4">
          <AddIncidentMemberForm
            action={addIncidentMemberAction.bind(null, incident.id)}
            members={memberOptions.filter((m) => !participantIds.has(m.id))}
          />
        </div>
      </section>

      <section aria-labelledby="assets-heading" className="mt-8">
        <h2 id="assets-heading" className="text-lg font-medium">
          Participating assets
        </h2>
        {incident.assets.length > 0 ? (
          <ul className="mt-3 divide-y divide-neutral-200 rounded-md border border-neutral-200">
            {incident.assets.map((p) => (
              <li
                key={p.id}
                className="flex items-center justify-between gap-3 px-4 py-2 text-sm"
              >
                <span>
                  <Link
                    href={`/admin/organizations/${orgId}/assets/${p.asset.id}`}
                    className="font-medium text-neutral-900 hover:underline"
                  >
                    {p.asset.name}
                  </Link>
                  {p.note && (
                    <span className="text-neutral-500"> — {p.note}</span>
                  )}
                  <span className="block text-xs text-neutral-400">
                    recorded {fmt(p.recordedAt)}
                    {p.recordedByDisplay ? ` · by ${p.recordedByDisplay}` : ""}
                  </span>
                </span>
                <RemoveParticipantButton
                  action={removeIncidentAssetAction.bind(null, p.id)}
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-neutral-500">No assets recorded.</p>
        )}
        <div className="mt-3 rounded-md border border-neutral-200 p-4">
          <AddIncidentAssetForm
            action={addIncidentAssetAction.bind(null, incident.id)}
            assets={assetOptions.filter((a) => !assetIds.has(a.id))}
          />
        </div>
      </section>

      {/* Issue #16 — documentary files on the incident record itself.
          On a CLOSED incident every attachment mutation is a correction
          and requires a recorded reason. */}
      <AttachmentSection
        entityType="INCIDENT"
        entityId={incident.id}
        organizationId={incident.organizationId}
        requireReason={incident.status === "CLOSED"}
        heading="Incident files"
      />

      <section aria-labelledby="timeline-heading" className="mt-10">
        <h2 id="timeline-heading" className="text-lg font-medium">
          Timeline and notes
        </h2>
        <p className="mt-1 text-xs text-neutral-500">
          System events are factual records of actions; notes are human-authored
          statements — attributed and correctable, never silently rewritten.
        </p>
        {incident.feed.length > 0 && (
          <ol className="mt-3 space-y-3">
            {incident.feed.map((item) =>
              item.kind === "event" ? (
                <li key={item.id} className="flex items-baseline gap-3 text-sm">
                  <span
                    aria-hidden="true"
                    className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-neutral-300"
                  />
                  <div>
                    <span className="text-neutral-800">{item.event.text}</span>
                    <span className="block text-xs text-neutral-400">
                      {fmt(item.event.occurredAt)}
                      {item.event.actorDisplay
                        ? ` · ${item.event.actorDisplay}`
                        : ""}
                      {item.event.occurredAt.getTime() !==
                        item.event.createdAt.getTime() &&
                        ` · recorded ${fmt(item.event.createdAt)}`}
                    </span>
                  </div>
                </li>
              ) : (
                <li key={item.id}>
                  <div className="rounded-md border border-neutral-200 bg-white p-3">
                    <div className="flex items-center justify-between gap-3 text-xs text-neutral-500">
                      <span>
                        <span
                          className={`mr-2 inline-block rounded-full px-2 py-0.5 font-medium ${noteKindBadgeClass[item.note.kind] ?? ""}`}
                        >
                          {INCIDENT_NOTE_KIND_LABELS[item.note.kind]}
                        </span>
                        {item.note.authorDisplay ?? "Unknown author"}
                        {" · "}
                        {fmt(item.note.createdAt)}
                        {item.note.occurredAt &&
                          ` · observed ${fmt(item.note.occurredAt)}`}
                        {item.note.corrections.length > 0 &&
                          ` · corrected ${item.note.corrections.length}×`}
                      </span>
                    </div>
                    <p className="mt-2 whitespace-pre-line text-sm text-neutral-800">
                      {item.note.body}
                    </p>
                    {item.note.corrections.length > 0 && (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs font-medium text-neutral-600 hover:text-neutral-900">
                          Correction history ({item.note.corrections.length})
                        </summary>
                        <ul className="mt-1 space-y-1">
                          {item.note.corrections.map((c) => (
                            <li
                              key={c.id}
                              className="rounded border border-neutral-100 bg-neutral-50 px-3 py-1.5 text-xs text-neutral-700"
                            >
                              <span className="text-neutral-500">
                                {fmt(c.createdAt)}
                                {c.actorDisplay ? ` · ${c.actorDisplay}` : ""}
                                {c.reason ? ` · ${c.reason}` : ""}
                              </span>
                              <span className="mt-0.5 block">
                                Before: {c.beforeBody}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                    <AttachmentSection
                      entityType="INCIDENT_NOTE"
                      entityId={item.note.id}
                      organizationId={incident.organizationId}
                      requireReason={incident.status === "CLOSED"}
                      heading="Note files"
                      compact
                    />
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs font-medium text-neutral-600 hover:text-neutral-900">
                        Correct this note
                      </summary>
                      <CorrectNoteForm
                        action={correctIncidentNoteAction.bind(
                          null,
                          item.note.id,
                        )}
                        currentBody={item.note.body}
                        idPrefix={`note-${item.note.id}`}
                      />
                    </details>
                  </div>
                </li>
              ),
            )}
          </ol>
        )}
        <div className="mt-4 rounded-md border border-neutral-200 p-4">
          <h3 className="text-sm font-medium text-neutral-800">Add a note</h3>
          <div className="mt-2">
            <AddIncidentNoteForm
              action={addIncidentNoteAction.bind(null, incident.id)}
            />
          </div>
        </div>
      </section>

      {incident.changes.length > 0 && (
        <section aria-labelledby="audit-heading" className="mt-10">
          <h2 id="audit-heading" className="text-lg font-medium">
            Correction history
          </h2>
          <ul className="mt-3 space-y-2">
            {incident.changes.map((change) => (
              <li
                key={change.id}
                className="rounded-md border border-neutral-200 px-4 py-3 text-sm"
              >
                <p className="text-xs text-neutral-500">
                  {fmt(change.createdAt)}
                  {change.actorDisplay ? ` · ${change.actorDisplay}` : ""}
                  {change.reason ? ` — ${change.reason}` : ""}
                </p>
                <dl className="mt-2 space-y-1 text-xs text-neutral-700">
                  {change.beforeTitle !== change.afterTitle && (
                    <div>
                      Title: {change.beforeTitle} → {change.afterTitle}
                    </div>
                  )}
                  {change.beforeSummary !== change.afterSummary && (
                    <div>
                      Report: {change.beforeSummary ?? "(none)"} →{" "}
                      {change.afterSummary ?? "(none)"}
                    </div>
                  )}
                  {(
                    [
                      [
                        "Reported",
                        change.beforeReportedAt,
                        change.afterReportedAt,
                      ],
                      [
                        "Departed",
                        change.beforeDepartedAt,
                        change.afterDepartedAt,
                      ],
                      [
                        "On scene",
                        change.beforeOnSceneAt,
                        change.afterOnSceneAt,
                      ],
                      [
                        "Returned",
                        change.beforeReturnedAt,
                        change.afterReturnedAt,
                      ],
                    ] as const
                  ).map(([label, before, after]) =>
                    (before?.getTime() ?? null) !==
                    (after?.getTime() ?? null) ? (
                      <div key={label}>
                        {label}: {before ? fmt(before) : "(unset)"} →{" "}
                        {after ? fmt(after) : "(unset)"}
                      </div>
                    ) : null,
                  )}
                </dl>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section
        aria-labelledby="edit-heading"
        className="mt-10 rounded-md border border-neutral-200 p-4"
      >
        <h2 id="edit-heading" className="text-sm font-medium text-neutral-800">
          {incident.status === "CLOSED"
            ? "Correct incident record"
            : "Edit incident record"}
        </h2>
        {incident.status === "CLOSED" && (
          <p className="mt-1 text-xs text-neutral-500">
            The record is closed. Corrections remain possible here — a reason is
            required and every change writes an auditable before/after entry.
            The status stays closed.
          </p>
        )}
        <div className="mt-3">
          <IncidentFieldsForm
            action={updateIncidentAction.bind(null, incident.id)}
            defaults={fieldDefaults}
            requireReason={incident.status === "CLOSED"}
            submitLabel={
              incident.status === "CLOSED"
                ? "Record correction"
                : "Save changes"
            }
          />
        </div>
      </section>
    </main>
  );
}
