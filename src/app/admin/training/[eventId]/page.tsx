import Link from "next/link";
import { notFound } from "next/navigation";

import {
  getTrainingEvent,
  listTrainingAttendanceChanges,
} from "@/lib/domain/training";
import { listMembers } from "@/lib/domain/member";
import { listUnits } from "@/lib/domain/unit";
import { formatDateOnly } from "@/lib/dates";
import { requireAuth, isOrgAdmin } from "@/lib/auth/authorize";

import {
  updateTrainingEventAction,
  setTrainingEventStatusAction,
  setTrainingAttendanceAction,
} from "../../actions";
import { TrainingEventForm, TrainingAttendanceForm } from "../../forms";
import { AttachmentSection } from "../../attachment-section";

export const metadata = { title: "Training event" };

export const dynamic = "force-dynamic";

export default async function TrainingEventPage({
  params,
}: {
  params: Promise<{ eventId: string }>;
}) {
  const ctx = await requireAuth();
  const { eventId } = await params;
  // eventId is an untrusted selector — resolve the record, then check
  // ADMIN access to the event's REAL organizationId.
  const event = await getTrainingEvent(eventId);
  if (!event || !isOrgAdmin(ctx, event.organizationId)) notFound();

  const orgId = event.organizationId;
  const units = await listUnits(orgId);
  const members = await listMembers(orgId);
  // Immutable attendance edit history (issue #9 audit) — shown to org
  // admins only; this page already notFound()s for anyone else.
  const attendanceChanges = await listTrainingAttendanceChanges(event.id);
  const attendedIds = event.attendances.map((a) => a.memberId);
  const isCancelled = event.status === "CANCELLED";

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <nav className="text-sm text-neutral-500">
        <Link href="/admin" className="hover:underline">
          Admin
        </Link>
        {" / "}
        <Link
          href={`/admin/organizations/${orgId}`}
          className="hover:underline"
        >
          Organization
        </Link>
        {" / "}
        <span className="text-neutral-800">{event.title}</span>
      </nav>

      <section className="mt-6">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-2xl font-semibold tracking-tight">
            {event.title}
          </h1>
          {isCancelled && (
            <span className="inline-block rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-600">
              Cancelled — did not occur
            </span>
          )}
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm text-neutral-700 sm:grid-cols-3">
          <div>
            <dt className="text-xs text-neutral-500">Date</dt>
            <dd>{formatDateOnly(event.date)}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">Duration</dt>
            <dd>
              {event.durationMinutes
                ? `${event.durationMinutes} minutes`
                : "Not recorded"}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">Unit</dt>
            <dd>{event.unit?.name ?? "Organization-wide"}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">Location</dt>
            <dd>{event.location ?? "Not recorded"}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">Instructor</dt>
            <dd>{event.instructorName ?? "Not recorded"}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">Lead member</dt>
            <dd>
              {event.leadMember ? (
                <Link
                  href={`/admin/members/${event.leadMember.id}`}
                  className="hover:underline"
                >
                  {event.leadMember.displayName}
                </Link>
              ) : (
                "None / external"
              )}
            </dd>
          </div>
        </dl>
        {event.topics.length > 0 && (
          <p className="mt-3 text-sm text-neutral-600">
            <span className="font-medium">Topics: </span>
            {event.topics.map((t) => t.label).join(", ")}
          </p>
        )}
        {event.notes && (
          <p className="mt-2 text-sm text-neutral-600">{event.notes}</p>
        )}
        {event.followUp && (
          <p className="mt-2 text-sm text-neutral-600">
            <span className="font-medium">Follow-up: </span>
            {event.followUp}
          </p>
        )}

        <div className="mt-4 flex items-center gap-3">
          <form
            action={setTrainingEventStatusAction.bind(
              null,
              event.id,
              isCancelled ? "COMPLETED" : "CANCELLED",
            )}
          >
            <button
              type="submit"
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
            >
              {isCancelled ? "Mark as completed" : "Mark as cancelled"}
            </button>
          </form>
        </div>
      </section>

      <section aria-labelledby="attendance-heading" className="mt-8">
        <h2 id="attendance-heading" className="text-lg font-medium">
          Attendance
        </h2>
        {isCancelled ? (
          <p className="mt-2 text-sm text-neutral-600">
            This event is marked cancelled — attendance is preserved for the
            record but does not count as participation. Restore it to
            &quot;completed&quot; to edit attendance.
          </p>
        ) : (
          <div className="mt-3 rounded-md border border-neutral-200 p-4">
            <TrainingAttendanceForm
              action={setTrainingAttendanceAction.bind(null, event.id)}
              members={members.map((m) => ({
                id: m.id,
                displayName: m.displayName,
              }))}
              attendedMemberIds={attendedIds}
            />
          </div>
        )}
        {event.attendances.length > 0 && (
          <p className="mt-3 text-sm text-neutral-500">
            Recorded attendees:{" "}
            {event.attendances.map((a) => a.member.displayName).join(", ")}
          </p>
        )}

        {attendanceChanges.length > 0 && (
          <div className="mt-4">
            <h3 className="text-sm font-medium text-neutral-800">
              Attendance history
            </h3>
            <p className="mt-1 text-xs text-neutral-500">
              Every attendance change on this event — who was added or removed,
              by whom, and when.
            </p>
            <ul className="mt-2 divide-y divide-neutral-200 rounded-md border border-neutral-200">
              {attendanceChanges.map((change) => {
                const iso = change.createdAt.toISOString();
                return (
                  <li
                    key={change.id}
                    className="px-4 py-2 text-sm text-neutral-700"
                  >
                    <span className="font-medium text-neutral-900">
                      {change.member.displayName}
                    </span>{" "}
                    {change.action === "ADDED"
                      ? "added to attendance"
                      : "removed from attendance"}{" "}
                    by{" "}
                    <span className="font-medium text-neutral-900">
                      {change.actorDisplayName ??
                        `account ${change.actorAuthIdentityId.slice(0, 8)}`}
                    </span>{" "}
                    ·{" "}
                    <time dateTime={iso}>
                      {iso.slice(0, 16).replace("T", " ")} UTC
                    </time>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </section>

      {/* Issue #16 — attendance sheets, syllabi, and course documents. */}
      <AttachmentSection
        entityType="TRAINING_EVENT"
        entityId={event.id}
        organizationId={orgId}
        heading="Event files"
      />

      <section aria-labelledby="edit-heading" className="mt-8">
        <h2 id="edit-heading" className="text-lg font-medium">
          Event details
        </h2>
        <p className="mt-1 text-sm text-neutral-600">
          Corrections edit this record in place — the event keeps its identity
          and history.
        </p>
        <div className="mt-3 rounded-md border border-neutral-200 p-4">
          <TrainingEventForm
            action={updateTrainingEventAction.bind(null, event.id)}
            units={units}
            members={members.map((m) => ({
              id: m.id,
              displayName: m.displayName,
            }))}
            defaults={{
              title: event.title,
              date: formatDateOnly(event.date) ?? "",
              unitId: event.unitId,
              durationMinutes: event.durationMinutes,
              location: event.location,
              instructorName: event.instructorName,
              leadMemberId: event.leadMemberId,
              notes: event.notes,
              followUp: event.followUp,
              topics: event.topics.map((t) => t.label).join(", "),
            }}
            submitLabel="Save changes"
          />
        </div>
      </section>
    </main>
  );
}
