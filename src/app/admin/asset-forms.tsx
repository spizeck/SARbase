"use client";

import { useActionState } from "react";

import type { ActionState } from "./actions";

/**
 * Asset/inventory/location admin forms — same ActionState + inline
 * field-error conventions as forms.tsx.
 */

const inputClass =
  "mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm";
const labelClass = "block text-sm font-medium text-neutral-800";
const errorClass = "mt-1 text-sm text-red-700";
const buttonClass =
  "rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50";
const optionalMark = (
  <span className="font-normal text-neutral-500">(optional)</span>
);

function FieldError({ id, errors }: { id: string; errors?: string[] }) {
  if (!errors?.length) return null;
  return (
    <p id={id} className={errorClass} role="alert">
      {errors.join(" ")}
    </p>
  );
}

type BoundAction = (
  prev: ActionState,
  formData: FormData,
) => Promise<ActionState>;

/* ------------------------------------------------------------------ */
/* StorageLocation                                                     */
/* ------------------------------------------------------------------ */

interface StorageLocationDefaults {
  name: string;
  description: string | null;
  /** "location:<id>" | "asset:<id>" | "" */
  container: string;
  status: "ACTIVE" | "ARCHIVED";
}

export function StorageLocationForm({
  action,
  formId,
  locationOptions,
  assetOptions,
  defaults,
  submitLabel,
}: {
  action: BoundAction;
  /** Unique per rendered instance — a page lists many edit forms. */
  formId: string;
  /** Already rendered "A > B > C" paths, self excluded when editing. */
  locationOptions: { id: string; path: string }[];
  assetOptions: { id: string; name: string }[];
  defaults?: StorageLocationDefaults;
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const id = (f: string) => `loc-${f}-${formId}`;
  return (
    <form action={formAction} className="space-y-3">
      <div>
        <label htmlFor={id("name")} className={labelClass}>
          Location name
        </label>
        <input
          id={id("name")}
          name="name"
          type="text"
          required
          maxLength={120}
          defaultValue={defaults?.name}
          placeholder="e.g. Shelf A"
          aria-invalid={Boolean(state.fieldErrors?.name)}
          aria-describedby={id("name-error")}
          className={inputClass}
        />
        <FieldError id={id("name-error")} errors={state.fieldErrors?.name} />
      </div>
      <div>
        <label htmlFor={id("container")} className={labelClass}>
          Located inside {optionalMark}
        </label>
        <select
          id={id("container")}
          name="container"
          defaultValue={defaults?.container ?? ""}
          aria-invalid={Boolean(state.fieldErrors?.parentLocationId)}
          aria-describedby={id("container-error")}
          className={inputClass}
        >
          <option value="">Top level</option>
          {locationOptions.length > 0 && (
            <optgroup label="Inside a location">
              {locationOptions.map((l) => (
                <option key={l.id} value={`location:${l.id}`}>
                  {l.path}
                </option>
              ))}
            </optgroup>
          )}
          {assetOptions.length > 0 && (
            <optgroup label="Inside an asset (e.g. a vessel locker)">
              {assetOptions.map((a) => (
                <option key={a.id} value={`asset:${a.id}`}>
                  {a.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        <FieldError
          id={id("container-error")}
          errors={state.fieldErrors?.parentLocationId}
        />
      </div>
      <div>
        <label htmlFor={id("description")} className={labelClass}>
          Description {optionalMark}
        </label>
        <textarea
          id={id("description")}
          name="description"
          rows={2}
          maxLength={500}
          defaultValue={defaults?.description ?? undefined}
          aria-invalid={Boolean(state.fieldErrors?.description)}
          aria-describedby={id("description-error")}
          className={inputClass}
        />
        <FieldError
          id={id("description-error")}
          errors={state.fieldErrors?.description}
        />
      </div>
      {defaults && (
        <div>
          <label htmlFor={id("status")} className={labelClass}>
            Status
          </label>
          <select
            id={id("status")}
            name="status"
            defaultValue={defaults.status}
            className={inputClass}
          >
            <option value="ACTIVE">Active</option>
            <option value="ARCHIVED">Archived</option>
          </select>
          <p className="mt-1 text-xs text-neutral-500">
            Archiving keeps the location and everything recorded inside it —
            historical records are never deleted.
          </p>
        </div>
      )}
      {state.message && (
        <p className={errorClass} role="alert">
          {state.message}
        </p>
      )}
      <button type="submit" disabled={pending} className={buttonClass}>
        {pending ? "Saving…" : submitLabel}
      </button>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* Asset                                                               */
/* ------------------------------------------------------------------ */

export interface AssetDefaults {
  name: string;
  category: string | null;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  assetTag: string | null;
  purchaseDate: string | null;
  vendor: string | null;
  unitId: string | null;
  parentAssetId: string | null;
  storageLocationId: string | null;
  condition: "UNKNOWN" | "GOOD" | "FAIR" | "DAMAGED";
  status: "ACTIVE" | "INACTIVE" | "OUT_OF_SERVICE" | "RETIRED";
  notes: string | null;
}

export function AssetForm({
  action,
  units,
  locationOptions,
  parentOptions,
  defaults,
  submitLabel,
}: {
  action: BoundAction;
  units: { id: string; name: string }[];
  locationOptions: { id: string; path: string }[];
  /** Same-org assets eligible as a physical parent; excludes self. */
  parentOptions: { id: string; name: string }[];
  defaults?: AssetDefaults;
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const id = (f: string) => `asset-${f}`;
  return (
    <form action={formAction} className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={id("name")} className={labelClass}>
            Name
          </label>
          <input
            id={id("name")}
            name="name"
            type="text"
            required
            maxLength={120}
            defaultValue={defaults?.name}
            placeholder="e.g. Rescue Boat 1"
            aria-invalid={Boolean(state.fieldErrors?.name)}
            aria-describedby={id("name-error")}
            className={inputClass}
          />
          <FieldError id={id("name-error")} errors={state.fieldErrors?.name} />
        </div>
        <div>
          <label htmlFor={id("category")} className={labelClass}>
            Category {optionalMark}
          </label>
          <input
            id={id("category")}
            name="category"
            type="text"
            maxLength={60}
            defaultValue={defaults?.category ?? undefined}
            placeholder="e.g. Vessel, Radio, Medical"
            aria-invalid={Boolean(state.fieldErrors?.category)}
            aria-describedby={id("category-error")}
            className={inputClass}
          />
          <FieldError
            id={id("category-error")}
            errors={state.fieldErrors?.category}
          />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <label htmlFor={id("manufacturer")} className={labelClass}>
            Manufacturer {optionalMark}
          </label>
          <input
            id={id("manufacturer")}
            name="manufacturer"
            type="text"
            maxLength={120}
            defaultValue={defaults?.manufacturer ?? undefined}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor={id("model")} className={labelClass}>
            Model {optionalMark}
          </label>
          <input
            id={id("model")}
            name="model"
            type="text"
            maxLength={120}
            defaultValue={defaults?.model ?? undefined}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor={id("serial")} className={labelClass}>
            Serial number {optionalMark}
          </label>
          <input
            id={id("serial")}
            name="serialNumber"
            type="text"
            maxLength={120}
            defaultValue={defaults?.serialNumber ?? undefined}
            className={inputClass}
          />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <label htmlFor={id("tag")} className={labelClass}>
            Asset tag {optionalMark}
          </label>
          <input
            id={id("tag")}
            name="assetTag"
            type="text"
            maxLength={60}
            defaultValue={defaults?.assetTag ?? undefined}
            placeholder="e.g. SAR-0042"
            aria-invalid={Boolean(state.fieldErrors?.assetTag)}
            aria-describedby={id("tag-error")}
            className={inputClass}
          />
          <FieldError
            id={id("tag-error")}
            errors={state.fieldErrors?.assetTag}
          />
        </div>
        <div>
          <label htmlFor={id("purchased")} className={labelClass}>
            Purchased on {optionalMark}
          </label>
          <input
            id={id("purchased")}
            name="purchaseDate"
            type="date"
            defaultValue={defaults?.purchaseDate ?? undefined}
            aria-invalid={Boolean(state.fieldErrors?.purchaseDate)}
            aria-describedby={id("purchased-error")}
            className={inputClass}
          />
          <FieldError
            id={id("purchased-error")}
            errors={state.fieldErrors?.purchaseDate}
          />
        </div>
        <div>
          <label htmlFor={id("vendor")} className={labelClass}>
            Vendor {optionalMark}
          </label>
          <input
            id={id("vendor")}
            name="vendor"
            type="text"
            maxLength={120}
            defaultValue={defaults?.vendor ?? undefined}
            placeholder="Where it was bought, if useful"
            className={inputClass}
          />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <label htmlFor={id("unit")} className={labelClass}>
            Unit {optionalMark}
          </label>
          <select
            id={id("unit")}
            name="unitId"
            defaultValue={defaults?.unitId ?? ""}
            className={inputClass}
          >
            <option value="">Organization-wide</option>
            {units.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={id("location")} className={labelClass}>
            Stored in {optionalMark}
          </label>
          <select
            id={id("location")}
            name="storageLocationId"
            defaultValue={defaults?.storageLocationId ?? ""}
            aria-invalid={Boolean(state.fieldErrors?.storageLocationId)}
            aria-describedby={id("location-error")}
            className={inputClass}
          >
            <option value="">No recorded location</option>
            {locationOptions.map((l) => (
              <option key={l.id} value={l.id}>
                {l.path}
              </option>
            ))}
          </select>
          <FieldError
            id={id("location-error")}
            errors={state.fieldErrors?.storageLocationId}
          />
        </div>
        <div>
          <label htmlFor={id("parent")} className={labelClass}>
            Part of asset {optionalMark}
          </label>
          <select
            id={id("parent")}
            name="parentAssetId"
            defaultValue={defaults?.parentAssetId ?? ""}
            aria-invalid={Boolean(state.fieldErrors?.parentAssetId)}
            aria-describedby={id("parent-error")}
            className={inputClass}
          >
            <option value="">Standalone</option>
            {parentOptions.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-neutral-500">
            Physical fitting — e.g. an engine is part of a boat.
          </p>
          <FieldError
            id={id("parent-error")}
            errors={state.fieldErrors?.parentAssetId}
          />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={id("condition")} className={labelClass}>
            Recorded condition
          </label>
          <select
            id={id("condition")}
            name="condition"
            defaultValue={defaults?.condition ?? "UNKNOWN"}
            className={inputClass}
          >
            <option value="UNKNOWN">Unknown</option>
            <option value="GOOD">Good</option>
            <option value="FAIR">Fair</option>
            <option value="DAMAGED">Damaged</option>
          </select>
        </div>
        <div>
          <label htmlFor={id("status")} className={labelClass}>
            Status
          </label>
          <select
            id={id("status")}
            name="status"
            defaultValue={defaults?.status ?? "ACTIVE"}
            className={inputClass}
          >
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
            <option value="OUT_OF_SERVICE">Out of service</option>
            <option value="RETIRED">Retired</option>
          </select>
          <p className="mt-1 text-xs text-neutral-500">
            Recorded facts only — SARbase does not judge readiness or safety
            from these fields.
          </p>
        </div>
      </div>
      <div>
        <label htmlFor={id("notes")} className={labelClass}>
          Notes {optionalMark}
        </label>
        <textarea
          id={id("notes")}
          name="notes"
          rows={2}
          maxLength={2000}
          defaultValue={defaults?.notes ?? undefined}
          className={inputClass}
        />
      </div>
      {state.message && (
        <p className={errorClass} role="alert">
          {state.message}
        </p>
      )}
      <button type="submit" disabled={pending} className={buttonClass}>
        {pending ? "Saving…" : submitLabel}
      </button>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* InventoryItem                                                       */
/* ------------------------------------------------------------------ */

interface InventoryItemDefaults {
  name: string;
  category: string | null;
  quantity: string;
  unitOfMeasure: string | null;
  vendor: string | null;
  unitId: string | null;
  storageLocationId: string | null;
  condition: "UNKNOWN" | "GOOD" | "FAIR" | "DAMAGED";
  status: "ACTIVE" | "ARCHIVED";
  notes: string | null;
}

export function InventoryItemForm({
  action,
  formId,
  units,
  locationOptions,
  defaults,
  submitLabel,
}: {
  action: BoundAction;
  formId: string;
  units: { id: string; name: string }[];
  locationOptions: { id: string; path: string }[];
  defaults?: InventoryItemDefaults;
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const id = (f: string) => `item-${f}-${formId}`;
  return (
    <form action={formAction} className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={id("name")} className={labelClass}>
            Item name
          </label>
          <input
            id={id("name")}
            name="name"
            type="text"
            required
            maxLength={120}
            defaultValue={defaults?.name}
            placeholder="e.g. 3/8 double-braid line"
            aria-invalid={Boolean(state.fieldErrors?.name)}
            aria-describedby={id("name-error")}
            className={inputClass}
          />
          <FieldError id={id("name-error")} errors={state.fieldErrors?.name} />
        </div>
        <div>
          <label htmlFor={id("category")} className={labelClass}>
            Category {optionalMark}
          </label>
          <input
            id={id("category")}
            name="category"
            type="text"
            maxLength={60}
            defaultValue={defaults?.category ?? undefined}
            placeholder="e.g. Rope, Pyrotechnics"
            className={inputClass}
          />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <label htmlFor={id("quantity")} className={labelClass}>
            Quantity
          </label>
          <input
            id={id("quantity")}
            name="quantity"
            type="text"
            inputMode="decimal"
            required
            defaultValue={defaults?.quantity}
            placeholder="e.g. 2 or 1.5"
            aria-invalid={Boolean(state.fieldErrors?.quantity)}
            aria-describedby={id("quantity-error")}
            className={inputClass}
          />
          <FieldError
            id={id("quantity-error")}
            errors={state.fieldErrors?.quantity}
          />
        </div>
        <div>
          <label htmlFor={id("uom")} className={labelClass}>
            Unit of measure {optionalMark}
          </label>
          <input
            id={id("uom")}
            name="unitOfMeasure"
            type="text"
            maxLength={30}
            defaultValue={defaults?.unitOfMeasure ?? undefined}
            placeholder="e.g. rolls, each, gallons"
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor={id("vendor")} className={labelClass}>
            Vendor {optionalMark}
          </label>
          <input
            id={id("vendor")}
            name="vendor"
            type="text"
            maxLength={120}
            defaultValue={defaults?.vendor ?? undefined}
            placeholder="Where it was bought, if useful"
            className={inputClass}
          />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <label htmlFor={id("unit")} className={labelClass}>
            Unit {optionalMark}
          </label>
          <select
            id={id("unit")}
            name="unitId"
            defaultValue={defaults?.unitId ?? ""}
            className={inputClass}
          >
            <option value="">Organization-wide</option>
            {units.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={id("location")} className={labelClass}>
            Stored in {optionalMark}
          </label>
          <select
            id={id("location")}
            name="storageLocationId"
            defaultValue={defaults?.storageLocationId ?? ""}
            className={inputClass}
          >
            <option value="">No recorded location</option>
            {locationOptions.map((l) => (
              <option key={l.id} value={l.id}>
                {l.path}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={id("condition")} className={labelClass}>
            Recorded condition
          </label>
          <select
            id={id("condition")}
            name="condition"
            defaultValue={defaults?.condition ?? "UNKNOWN"}
            className={inputClass}
          >
            <option value="UNKNOWN">Unknown</option>
            <option value="GOOD">Good</option>
            <option value="FAIR">Fair</option>
            <option value="DAMAGED">Damaged</option>
          </select>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {defaults ? (
          <div>
            <label htmlFor={id("status")} className={labelClass}>
              Status
            </label>
            <select
              id={id("status")}
              name="status"
              defaultValue={defaults.status}
              className={inputClass}
            >
              <option value="ACTIVE">Active</option>
              <option value="ARCHIVED">Archived</option>
            </select>
          </div>
        ) : null}
        <div>
          <label htmlFor={id("notes")} className={labelClass}>
            Notes {optionalMark}
          </label>
          <textarea
            id={id("notes")}
            name="notes"
            rows={2}
            maxLength={2000}
            defaultValue={defaults?.notes ?? undefined}
            className={inputClass}
          />
        </div>
      </div>
      {state.message && (
        <p className={errorClass} role="alert">
          {state.message}
        </p>
      )}
      <button type="submit" disabled={pending} className={buttonClass}>
        {pending ? "Saving…" : submitLabel}
      </button>
    </form>
  );
}
