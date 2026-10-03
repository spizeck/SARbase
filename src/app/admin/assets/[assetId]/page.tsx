import Link from "next/link";
import { notFound } from "next/navigation";

import {
  getAsset,
  listStorageLocations,
  listAssets,
} from "@/lib/domain/assets";
import { getOrganization } from "@/lib/domain/organization";
import { listUnits } from "@/lib/domain/unit";
import { listMembers } from "@/lib/domain/member";
import {
  listInspectionDefinitions,
  listAssetInspections,
  listAssetMaintenancePlans,
  listAssetMaintenanceRecords,
  listAssetDefects,
  listAssetMeters,
  organizationToday,
  dateDueLabel,
} from "@/lib/domain/maintenance";
import { formatDateOnly } from "@/lib/dates";
import { requireAuth, isOrgAdmin } from "@/lib/auth/authorize";

import {
  updateAssetAction,
  recordInspectionAction,
  updateInspectionRecordAction,
  createMaintenancePlanAction,
  updateMaintenancePlanAction,
  setMaintenancePlanStatusAction,
  recordMaintenanceAction,
  updateMaintenanceRecordAction,
  reportDefectAction,
  updateDefectAction,
  transitionDefectAction,
  createAssetMeterAction,
  updateAssetMeterAction,
  setAssetMeterStatusAction,
  recordMeterReadingAction,
} from "../../actions";
import { AssetForm } from "../../asset-forms";
import {
  InspectionRecordForm,
  InspectionRecordEditForm,
  MaintenancePlanForm,
  MaintenanceRecordForm,
  MaintenanceRecordEditForm,
  DefectForm,
  DefectTransitionForm,
  AssetMeterForm,
  MeterReadingForm,
} from "../../maintenance-forms";
import { AttachmentSection } from "../../attachment-section";

export const metadata = { title: "Asset" };

export const dynamic = "force-dynamic";

const STATUS_LABELS: Record<string, string> = {
  INACTIVE: "Inactive",
  OUT_OF_SERVICE: "Out of service",
  RETIRED: "Retired",
};
const CONDITION_LABELS: Record<string, string> = {
  UNKNOWN: "Unknown",
  GOOD: "Good",
  FAIR: "Fair",
  DAMAGED: "Damaged",
};

/** Deterministic instant rendering for correction-history rows. */
function formatInstant(d: Date) {
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

type ChangeDiff = readonly [label: string, before: string, after: string];

export default async function AssetPage({
  params,
}: {
  params: Promise<{ assetId: string }>;
}) {
  const ctx = await requireAuth();
  const { assetId } = await params;
  // assetId is an untrusted selector — resolve the record, then check
  // ADMIN access to the asset's REAL organizationId.
  const asset = await getAsset(assetId);
  if (!asset || !isOrgAdmin(ctx, asset.organizationId)) notFound();

  const orgId = asset.organizationId;
  const [
    organization,
    units,
    locations,
    siblings,
    members,
    inspectionDefinitions,
    inspectionRecords,
    maintenancePlans,
    maintenanceRecords,
    defects,
    meters,
    today,
  ] = await Promise.all([
    getOrganization(orgId),
    listUnits(orgId),
    listStorageLocations(orgId),
    listAssets(orgId, { includeRetired: true }),
    listMembers(orgId),
    listInspectionDefinitions(orgId),
    listAssetInspections(assetId),
    listAssetMaintenancePlans(assetId, { includeInactive: true }),
    listAssetMaintenanceRecords(assetId),
    listAssetDefects(assetId),
    listAssetMeters(assetId),
    organizationToday(orgId),
  ]);
  if (!organization) notFound();

  const memberOptions = members.map((m) => ({
    id: m.id,
    displayName: m.displayName,
  }));

  // Correction-history value formatting (before → after facts).
  const dash = "—";
  const fmtD = (d: Date | null) => (d ? formatDateOnly(d)! : dash);
  const fmtS = (s: string | null) => (s && s.trim() !== "" ? s : dash);
  const fmtMember = (id: string | null) =>
    id
      ? (members.find((m) => m.id === id)?.displayName ?? "Removed member")
      : dash;
  const fmtCond = (c: string | null) => (c ? (CONDITION_LABELS[c] ?? c) : dash);
  const meterOptions = meters
    .filter((m) => m.status === "ACTIVE")
    .map((m) => ({ id: m.id, name: m.name, unit: m.unit }));
  const todayString = formatDateOnly(today) ?? undefined;

  const INTERVAL_LABELS: Record<string, string> = {
    NONE: "No recurrence",
    CALENDAR_DAYS: "days",
    CALENDAR_MONTHS: "months",
    METER_INTERVAL: "meter units",
  };

  const locationPath = asset.storageLocationId
    ? locations.find((l) => l.id === asset.storageLocationId)?.path
    : undefined;

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
        <Link
          href={`/admin/organizations/${orgId}/assets`}
          className="hover:underline"
        >
          Assets
        </Link>
        <span aria-hidden="true"> / </span>
        <span aria-current="page" className="text-neutral-800">
          {asset.name}
        </span>
      </nav>

      <section aria-labelledby="asset-heading" className="mt-6">
        <div className="flex items-center justify-between gap-4">
          <h1
            id="asset-heading"
            className="text-2xl font-semibold tracking-tight"
          >
            {asset.name}
          </h1>
          {asset.status !== "ACTIVE" && (
            <span className="inline-block rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-600">
              {STATUS_LABELS[asset.status]}
            </span>
          )}
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm text-neutral-700 sm:grid-cols-3">
          <div>
            <dt className="text-xs text-neutral-500">Category</dt>
            <dd>{asset.category ?? "Not recorded"}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">Manufacturer</dt>
            <dd>{asset.manufacturer ?? "Not recorded"}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">Model</dt>
            <dd>{asset.model ?? "Not recorded"}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">Serial number</dt>
            <dd>{asset.serialNumber ?? "Not recorded"}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">Asset tag</dt>
            <dd>{asset.assetTag ?? "Not recorded"}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">Purchased</dt>
            <dd>
              {asset.purchaseDate
                ? formatDateOnly(asset.purchaseDate)
                : "Not recorded"}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">Vendor</dt>
            <dd>{asset.vendor ?? "Not recorded"}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">Unit</dt>
            <dd>{asset.unit?.name ?? "Organization-wide"}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">Stored in</dt>
            <dd>{locationPath ?? "No recorded location"}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">Part of</dt>
            <dd>
              {asset.parentAsset ? (
                <Link
                  href={`/admin/assets/${asset.parentAsset.id}`}
                  className="hover:underline"
                >
                  {asset.parentAsset.name}
                </Link>
              ) : (
                "Standalone"
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">Recorded condition</dt>
            <dd>{CONDITION_LABELS[asset.condition]}</dd>
          </div>
        </dl>
        {asset.notes && (
          <p className="mt-3 text-sm text-neutral-600">
            <span className="font-medium">Notes: </span>
            {asset.notes}
          </p>
        )}
      </section>

      {/* Issue #16 — manuals, registrations, photos, and other documents
          recorded against this asset. */}
      <AttachmentSection
        entityType="ASSET"
        entityId={asset.id}
        organizationId={orgId}
        heading="Asset files"
      />

      {(asset.childAssets.length > 0 ||
        asset.containedLocations.length > 0) && (
        <section aria-labelledby="contains-heading" className="mt-8">
          <h2 id="contains-heading" className="text-lg font-medium">
            What this asset contains
          </h2>
          {asset.childAssets.length > 0 && (
            <ul className="mt-2 space-y-1 text-sm">
              {asset.childAssets.map((child) => (
                <li key={child.id}>
                  <Link
                    href={`/admin/assets/${child.id}`}
                    className="text-neutral-800 hover:underline"
                  >
                    {child.name}
                  </Link>
                  <span className="text-neutral-500">
                    {[
                      child.category && ` — ${child.category}`,
                      child.status !== "ACTIVE" &&
                        ` (${(STATUS_LABELS[child.status] ?? child.status).toLowerCase()})`,
                    ]
                      .filter(Boolean)
                      .join("")}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {asset.containedLocations.length > 0 && (
            <p className="mt-2 text-sm text-neutral-600">
              Storage locations inside:{" "}
              {asset.containedLocations.map((l) => l.name).join(", ")}
            </p>
          )}
        </section>
      )}

      {/* Issue #11 — meters, inspections, maintenance, defects. All
          labels are factual: dates, readings, and statuses only. */}

      <section aria-labelledby="meters-heading" className="mt-10">
        <h2 id="meters-heading" className="text-lg font-medium">
          Meters
        </h2>
        <p className="mt-1 text-sm text-neutral-600">
          Manually recorded counters (engine hours, odometer, cycles). Readings
          are append-only and never decrease — if a meter is reset or replaced,
          archive it and create a new one.
        </p>
        {meters.length > 0 ? (
          <ul className="mt-3 space-y-2">
            {meters.map((meter) => {
              const latest = meter.readings[0];
              return (
                <li
                  key={meter.id}
                  className="rounded-md border border-neutral-200 p-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <span className="text-sm font-medium text-neutral-900">
                        {meter.name}
                      </span>
                      <span className="ml-2 text-xs text-neutral-500">
                        {latest
                          ? `${latest.reading} ${meter.unit} (recorded ${formatDateOnly(latest.recordedOn)})`
                          : `No readings yet — ${meter.unit}`}
                      </span>
                      {meter.status === "ARCHIVED" && (
                        <span className="ml-2 inline-block rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-600">
                          Archived
                        </span>
                      )}
                    </div>
                    <form
                      action={setAssetMeterStatusAction.bind(
                        null,
                        meter.id,
                        meter.status === "ACTIVE" ? "ARCHIVED" : "ACTIVE",
                      )}
                    >
                      <button
                        type="submit"
                        className="rounded-md border border-neutral-300 px-3 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
                      >
                        {meter.status === "ACTIVE" ? "Archive" : "Reactivate"}
                      </button>
                    </form>
                  </div>
                  <div className="mt-2 flex gap-4 text-xs">
                    {meter.status === "ACTIVE" && (
                      <details>
                        <summary className="cursor-pointer font-medium text-neutral-600 hover:text-neutral-900">
                          Add reading
                        </summary>
                        <div className="mt-2">
                          <MeterReadingForm
                            action={recordMeterReadingAction.bind(
                              null,
                              meter.id,
                            )}
                            formId={meter.id}
                            members={memberOptions}
                            defaultDate={todayString}
                            submitLabel="Record reading"
                          />
                        </div>
                      </details>
                    )}
                    <details>
                      <summary className="cursor-pointer font-medium text-neutral-600 hover:text-neutral-900">
                        Edit
                      </summary>
                      <div className="mt-2">
                        <AssetMeterForm
                          action={updateAssetMeterAction.bind(null, meter.id)}
                          formId={meter.id}
                          defaults={{ name: meter.name, unit: meter.unit }}
                          submitLabel="Save meter"
                        />
                      </div>
                    </details>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-neutral-600">
            No meters recorded on this asset.
          </p>
        )}
        <div className="mt-3 rounded-md border border-neutral-200 p-4">
          <h3 className="text-sm font-medium text-neutral-800">Add meter</h3>
          <div className="mt-2">
            <AssetMeterForm
              action={createAssetMeterAction.bind(null, asset.id)}
              formId="new"
              submitLabel="Add meter"
            />
          </div>
        </div>
      </section>

      <section aria-labelledby="inspections-heading" className="mt-10">
        <h2 id="inspections-heading" className="text-lg font-medium">
          Inspections
        </h2>
        <p className="mt-1 text-sm text-neutral-600">
          Factual inspection occurrences — that an inspection happened, on which
          date, by whom, and any recorded next-due date.
        </p>
        {inspectionRecords.length > 0 ? (
          <ul className="mt-3 space-y-2">
            {inspectionRecords.map((record) => (
              <li
                key={record.id}
                className="rounded-md border border-neutral-200 p-3"
              >
                <div className="text-sm font-medium text-neutral-900">
                  {record.definition.name}
                  <span className="ml-2 text-xs font-normal text-neutral-500">
                    performed {formatDateOnly(record.performedOn)}
                  </span>
                </div>
                <dl className="mt-1 grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-neutral-600 sm:grid-cols-3">
                  <div>
                    <dt className="inline text-neutral-500">Inspector: </dt>
                    <dd className="inline">
                      {record.inspectorMember?.displayName ??
                        record.inspectorName ??
                        "Not recorded"}
                    </dd>
                  </div>
                  <div>
                    <dt className="inline text-neutral-500">Condition: </dt>
                    <dd className="inline">
                      {record.conditionObserved
                        ? (CONDITION_LABELS[record.conditionObserved] ??
                          record.conditionObserved)
                        : "Not recorded"}
                    </dd>
                  </div>
                  <div>
                    <dt className="inline text-neutral-500">Next due: </dt>
                    <dd className="inline">
                      {dateDueLabel(record.nextDueOn, today)}
                    </dd>
                  </div>
                  {record.meterReading != null && (
                    <div>
                      <dt className="inline text-neutral-500">Meter: </dt>
                      <dd className="inline">
                        {record.meter?.name}: {String(record.meterReading)}{" "}
                        {record.meter?.unit}
                      </dd>
                    </div>
                  )}
                </dl>
                {record.notes && (
                  <p className="mt-1 text-xs text-neutral-600">
                    {record.notes}
                  </p>
                )}
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs font-medium text-neutral-600 hover:text-neutral-900">
                    Correct this record
                  </summary>
                  <div className="mt-2">
                    <InspectionRecordEditForm
                      action={updateInspectionRecordAction.bind(
                        null,
                        record.id,
                      )}
                      formId={record.id}
                      members={memberOptions}
                      defaults={{
                        performedOn: formatDateOnly(record.performedOn)!,
                        inspectorMemberId: record.inspectorMemberId,
                        inspectorName: record.inspectorName,
                        conditionObserved: record.conditionObserved,
                        nextDueOn: formatDateOnly(record.nextDueOn),
                        notes: record.notes,
                      }}
                      submitLabel="Save correction"
                    />
                  </div>
                </details>
                {record.changes.length > 0 && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs font-medium text-neutral-600 hover:text-neutral-900">
                      Correction history ({record.changes.length})
                    </summary>
                    <ul className="mt-2 space-y-2">
                      {record.changes.map((change) => {
                        const diffs = (
                          [
                            [
                              "Performed on",
                              fmtD(change.beforePerformedOn),
                              fmtD(change.afterPerformedOn),
                            ],
                            [
                              "Inspector (member)",
                              fmtMember(change.beforeInspectorMemberId),
                              fmtMember(change.afterInspectorMemberId),
                            ],
                            [
                              "Inspector name",
                              fmtS(change.beforeInspectorName),
                              fmtS(change.afterInspectorName),
                            ],
                            [
                              "Observed condition",
                              fmtCond(change.beforeConditionObserved),
                              fmtCond(change.afterConditionObserved),
                            ],
                            [
                              "Next due",
                              fmtD(change.beforeNextDueOn),
                              fmtD(change.afterNextDueOn),
                            ],
                            [
                              "Notes",
                              fmtS(change.beforeNotes),
                              fmtS(change.afterNotes),
                            ],
                          ] as const satisfies readonly ChangeDiff[]
                        ).filter(([, before, after]) => before !== after);
                        return (
                          <li
                            key={change.id}
                            className="text-xs text-neutral-600"
                          >
                            <div>
                              Corrected {formatInstant(change.createdAt)} by{" "}
                              {change.actorAuthIdentity.email}
                              {change.note ? ` — ${change.note}` : ""}
                            </div>
                            {diffs.length > 0 && (
                              <ul className="mt-1 list-disc pl-4">
                                {diffs.map(([label, before, after]) => (
                                  <li key={label}>
                                    {label}: {before} → {after}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </details>
                )}
                {/* Issue #16 — inspection sheets and reports. */}
                <AttachmentSection
                  entityType="INSPECTION_RECORD"
                  entityId={record.id}
                  organizationId={orgId}
                  heading="Record files"
                  compact
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-neutral-600">
            No inspections recorded on this asset.
          </p>
        )}
        <div className="mt-3 rounded-md border border-neutral-200 p-4">
          <h3 className="text-sm font-medium text-neutral-800">
            Record an inspection
          </h3>
          {inspectionDefinitions.length > 0 ? (
            <div className="mt-2">
              <InspectionRecordForm
                action={recordInspectionAction.bind(null, asset.id)}
                formId="new"
                definitions={inspectionDefinitions.map((d) => ({
                  id: d.id,
                  name: d.name,
                }))}
                members={memberOptions}
                meters={meterOptions}
                defaultDate={todayString}
                submitLabel="Record inspection"
              />
            </div>
          ) : (
            <p className="mt-2 text-sm text-neutral-600">
              No active inspection types — define them under{" "}
              <Link
                href={`/admin/organizations/${orgId}/maintenance`}
                className="font-medium text-neutral-800 hover:underline"
              >
                Maintenance
              </Link>
              .
            </p>
          )}
        </div>
      </section>

      <section aria-labelledby="maintenance-heading" className="mt-10">
        <h2 id="maintenance-heading" className="text-lg font-medium">
          Maintenance
        </h2>
        <p className="mt-1 text-sm text-neutral-600">
          Recurring requirements and the factual service history against them.
        </p>
        {maintenancePlans.length > 0 && (
          <>
            <h3 className="mt-4 text-sm font-medium text-neutral-800">Plans</h3>
            <ul className="mt-2 space-y-2">
              {maintenancePlans.map((plan) => (
                <li
                  key={plan.id}
                  className="rounded-md border border-neutral-200 p-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <span className="text-sm font-medium text-neutral-900">
                        {plan.name}
                      </span>
                      <span className="ml-2 text-xs text-neutral-500">
                        {plan.intervalType === "METER_INTERVAL"
                          ? `Every ${plan.meterInterval} ${plan.meter?.unit ?? "units"} (${plan.meter?.name})`
                          : plan.intervalType === "NONE"
                            ? INTERVAL_LABELS.NONE
                            : `Every ${plan.intervalValue} ${INTERVAL_LABELS[plan.intervalType]}`}
                      </span>
                      {plan.status === "INACTIVE" && (
                        <span className="ml-2 inline-block rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-600">
                          Inactive
                        </span>
                      )}
                    </div>
                    <form
                      action={setMaintenancePlanStatusAction.bind(
                        null,
                        plan.id,
                        plan.status === "ACTIVE" ? "INACTIVE" : "ACTIVE",
                      )}
                    >
                      <button
                        type="submit"
                        className="rounded-md border border-neutral-300 px-3 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
                      >
                        {plan.status === "ACTIVE" ? "Deactivate" : "Reactivate"}
                      </button>
                    </form>
                  </div>
                  {plan.description && (
                    <p className="mt-1 text-xs text-neutral-600">
                      {plan.description}
                    </p>
                  )}
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs font-medium text-neutral-600 hover:text-neutral-900">
                      Edit
                    </summary>
                    <div className="mt-2">
                      <MaintenancePlanForm
                        action={updateMaintenancePlanAction.bind(null, plan.id)}
                        formId={plan.id}
                        meters={meterOptions}
                        defaults={{
                          name: plan.name,
                          description: plan.description,
                          intervalType: plan.intervalType,
                          intervalValue: plan.intervalValue,
                          meterId: plan.meterId,
                          meterInterval: plan.meterInterval?.toString() ?? null,
                        }}
                        submitLabel="Save plan"
                      />
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="mt-3 rounded-md border border-neutral-200 p-4">
          <h3 className="text-sm font-medium text-neutral-800">
            Add a maintenance plan
          </h3>
          <div className="mt-2">
            <MaintenancePlanForm
              action={createMaintenancePlanAction.bind(null, asset.id)}
              formId="new"
              meters={meterOptions}
              submitLabel="Add plan"
            />
          </div>
        </div>

        <h3 className="mt-6 text-sm font-medium text-neutral-800">
          Service history
        </h3>
        {maintenanceRecords.length > 0 ? (
          <ul className="mt-2 space-y-2">
            {maintenanceRecords.map((record) => (
              <li
                key={record.id}
                className="rounded-md border border-neutral-200 p-3"
              >
                <div className="text-sm font-medium text-neutral-900">
                  {record.title}
                  <span className="ml-2 text-xs font-normal text-neutral-500">
                    performed {formatDateOnly(record.performedOn)}
                    {record.plan ? ` — ${record.plan.name}` : " — ad-hoc"}
                  </span>
                </div>
                <dl className="mt-1 grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-neutral-600 sm:grid-cols-3">
                  <div>
                    <dt className="inline text-neutral-500">By: </dt>
                    <dd className="inline">
                      {record.performedByMember?.displayName ??
                        record.providerName ??
                        "Not recorded"}
                    </dd>
                  </div>
                  {record.meterReading != null && (
                    <div>
                      <dt className="inline text-neutral-500">Meter: </dt>
                      <dd className="inline">
                        {record.meter?.name}: {String(record.meterReading)}{" "}
                        {record.meter?.unit}
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt className="inline text-neutral-500">Next due: </dt>
                    <dd className="inline">
                      {dateDueLabel(record.nextDueOn, today)}
                    </dd>
                  </div>
                </dl>
                {record.workPerformed && (
                  <p className="mt-1 text-xs text-neutral-600">
                    {record.workPerformed}
                  </p>
                )}
                {record.notes && (
                  <p className="mt-1 text-xs text-neutral-600">
                    {record.notes}
                  </p>
                )}
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs font-medium text-neutral-600 hover:text-neutral-900">
                    Correct this record
                  </summary>
                  <div className="mt-2">
                    <MaintenanceRecordEditForm
                      action={updateMaintenanceRecordAction.bind(
                        null,
                        record.id,
                      )}
                      formId={record.id}
                      members={memberOptions}
                      defaults={{
                        title: record.title,
                        performedOn: formatDateOnly(record.performedOn)!,
                        workPerformed: record.workPerformed,
                        providerName: record.providerName,
                        performedByMemberId: record.performedByMemberId,
                        nextDueOn: formatDateOnly(record.nextDueOn),
                        notes: record.notes,
                      }}
                      submitLabel="Save correction"
                    />
                  </div>
                </details>
                {record.changes.length > 0 && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs font-medium text-neutral-600 hover:text-neutral-900">
                      Correction history ({record.changes.length})
                    </summary>
                    <ul className="mt-2 space-y-2">
                      {record.changes.map((change) => {
                        const diffs = (
                          [
                            ["Title", change.beforeTitle, change.afterTitle],
                            [
                              "Performed on",
                              fmtD(change.beforePerformedOn),
                              fmtD(change.afterPerformedOn),
                            ],
                            [
                              "Work performed",
                              fmtS(change.beforeWorkPerformed),
                              fmtS(change.afterWorkPerformed),
                            ],
                            [
                              "Provider",
                              fmtS(change.beforeProviderName),
                              fmtS(change.afterProviderName),
                            ],
                            [
                              "Performed by (member)",
                              fmtMember(change.beforePerformedByMemberId),
                              fmtMember(change.afterPerformedByMemberId),
                            ],
                            [
                              "Next due",
                              fmtD(change.beforeNextDueOn),
                              fmtD(change.afterNextDueOn),
                            ],
                            [
                              "Notes",
                              fmtS(change.beforeNotes),
                              fmtS(change.afterNotes),
                            ],
                          ] as const satisfies readonly ChangeDiff[]
                        ).filter(([, before, after]) => before !== after);
                        return (
                          <li
                            key={change.id}
                            className="text-xs text-neutral-600"
                          >
                            <div>
                              Corrected {formatInstant(change.createdAt)} by{" "}
                              {change.actorAuthIdentity.email}
                              {change.note ? ` — ${change.note}` : ""}
                            </div>
                            {diffs.length > 0 && (
                              <ul className="mt-1 list-disc pl-4">
                                {diffs.map(([label, before, after]) => (
                                  <li key={label}>
                                    {label}: {before} → {after}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </details>
                )}
                {/* Issue #16 — invoices, service sheets, work photos. */}
                <AttachmentSection
                  entityType="MAINTENANCE_RECORD"
                  entityId={record.id}
                  organizationId={orgId}
                  heading="Record files"
                  compact
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-neutral-600">
            No service recorded on this asset.
          </p>
        )}
        <div className="mt-3 rounded-md border border-neutral-200 p-4">
          <h3 className="text-sm font-medium text-neutral-800">
            Record service or repair
          </h3>
          <div className="mt-2">
            <MaintenanceRecordForm
              action={recordMaintenanceAction.bind(null, asset.id)}
              formId="new"
              plans={maintenancePlans
                .filter((p) => p.status === "ACTIVE")
                .map((p) => ({ id: p.id, name: p.name }))}
              members={memberOptions}
              meters={meterOptions}
              defaultDate={todayString}
              submitLabel="Record service"
            />
          </div>
        </div>
      </section>

      <section aria-labelledby="defects-heading" className="mt-10">
        <h2 id="defects-heading" className="text-lg font-medium">
          Defects
        </h2>
        <p className="mt-1 text-sm text-neutral-600">
          Human-reported issues. A defect records that someone reported a
          problem and whether it has been resolved — it does not mark the asset
          unsafe or unavailable.
        </p>
        {defects.length > 0 ? (
          <ul className="mt-3 space-y-2">
            {defects.map((defect) => (
              <li
                key={defect.id}
                className="rounded-md border border-neutral-200 p-3"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-medium text-neutral-900">
                    {defect.title}
                    <span
                      className={`ml-2 inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                        defect.status === "OPEN"
                          ? "bg-amber-100 text-amber-800"
                          : "bg-neutral-100 text-neutral-600"
                      }`}
                    >
                      {defect.status === "OPEN" ? "Open" : "Resolved"}
                    </span>
                  </div>
                </div>
                <dl className="mt-1 grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-neutral-600 sm:grid-cols-3">
                  <div>
                    <dt className="inline text-neutral-500">Reported: </dt>
                    <dd className="inline">
                      {formatDateOnly(defect.reportedOn)}
                      {(defect.reportedByMember?.displayName ??
                        defect.reporterName) &&
                        ` by ${defect.reportedByMember?.displayName ?? defect.reporterName}`}
                    </dd>
                  </div>
                  {defect.resolvedOn && (
                    <div>
                      <dt className="inline text-neutral-500">Resolved: </dt>
                      <dd className="inline">
                        {formatDateOnly(defect.resolvedOn)}
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt className="inline text-neutral-500">History: </dt>
                    <dd className="inline">
                      {defect._count.changes} change
                      {defect._count.changes === 1 ? "" : "s"}
                    </dd>
                  </div>
                </dl>
                {defect.description && (
                  <p className="mt-1 text-xs text-neutral-600">
                    {defect.description}
                  </p>
                )}
                {defect.resolutionNotes && (
                  <p className="mt-1 text-xs text-neutral-600">
                    Resolution: {defect.resolutionNotes}
                  </p>
                )}
                <div className="mt-2 flex gap-4">
                  <details>
                    <summary className="cursor-pointer text-xs font-medium text-neutral-600 hover:text-neutral-900">
                      Edit
                    </summary>
                    <div className="mt-2">
                      <DefectForm
                        action={updateDefectAction.bind(null, defect.id)}
                        formId={defect.id}
                        members={memberOptions}
                        defaults={{
                          title: defect.title,
                          description: defect.description,
                          reportedOn: formatDateOnly(defect.reportedOn)!,
                          reportedByMemberId: defect.reportedByMemberId,
                          reporterName: defect.reporterName,
                        }}
                        submitLabel="Save correction"
                      />
                    </div>
                  </details>
                  <details>
                    <summary className="cursor-pointer text-xs font-medium text-neutral-600 hover:text-neutral-900">
                      {defect.status === "OPEN" ? "Resolve" : "Reopen"}
                    </summary>
                    <div className="mt-2">
                      <DefectTransitionForm
                        action={transitionDefectAction.bind(null, defect.id)}
                        formId={defect.id}
                        target={defect.status === "OPEN" ? "RESOLVED" : "OPEN"}
                        defaultDate={todayString}
                      />
                    </div>
                  </details>
                </div>
                {/* Issue #16 — damage photos and supporting files. */}
                <AttachmentSection
                  entityType="DEFECT"
                  entityId={defect.id}
                  organizationId={orgId}
                  heading="Defect files"
                  compact
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-neutral-600">
            No defects recorded on this asset.
          </p>
        )}
        <div className="mt-3 rounded-md border border-neutral-200 p-4">
          <h3 className="text-sm font-medium text-neutral-800">
            Report a defect
          </h3>
          <div className="mt-2">
            <DefectForm
              action={reportDefectAction.bind(null, asset.id)}
              formId="new"
              members={memberOptions}
              defaultDate={todayString}
              showMarkOutOfService={asset.status !== "OUT_OF_SERVICE"}
              submitLabel="Report defect"
            />
          </div>
        </div>
      </section>

      <section aria-labelledby="edit-heading" className="mt-8">
        <details className="rounded-md border border-neutral-200 p-4">
          <summary
            id="edit-heading"
            className="cursor-pointer text-sm font-medium text-neutral-800"
          >
            Edit asset
          </summary>
          <div className="mt-3">
            <AssetForm
              action={updateAssetAction.bind(null, asset.id)}
              units={units}
              locationOptions={locations.map((l) => ({
                id: l.id,
                path: l.path,
              }))}
              parentOptions={siblings
                .filter((a) => a.id !== asset.id)
                .map((a) => ({ id: a.id, name: a.name }))}
              defaults={{
                name: asset.name,
                category: asset.category,
                manufacturer: asset.manufacturer,
                model: asset.model,
                serialNumber: asset.serialNumber,
                assetTag: asset.assetTag,
                purchaseDate: formatDateOnly(asset.purchaseDate),
                vendor: asset.vendor,
                unitId: asset.unitId,
                parentAssetId: asset.parentAssetId,
                storageLocationId: asset.storageLocationId,
                condition: asset.condition,
                status: asset.status,
                notes: asset.notes,
              }}
              submitLabel="Save asset"
            />
          </div>
        </details>
      </section>
    </main>
  );
}
